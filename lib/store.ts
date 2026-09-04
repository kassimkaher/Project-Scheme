import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  ProjectRecord, ProjectSummary, QaMode, QaProjectSpec, QaProjectSpecSafe,
  RunRecord, RunScope, RunStatus,
} from '@/types/qa';
import { decryptJson, encryptJson } from './crypto';
import { fingerprintSpec, mergeSecrets, specStats, splitSecrets } from './spec';

/**
 * 2 → nested runs, split secrets.
 * 3 → adds projects.index.json so a project whose directory vanishes is
 *     reported instead of silently disappearing from the library.
 */
export const SCHEMA_VERSION = 3;

const root = () => path.resolve(process.cwd(), process.env.QA_DATA_DIR || '.qa-data');
const projectsDir = () => path.join(root(), 'projects');
const legacyRunsDir = () => path.join(root(), 'runs');
const orphanRunsDir = () => path.join(root(), 'orphan-runs');
const metaFile = () => path.join(root(), 'meta.json');

const indexFile = () => path.join(root(), 'projects.index.json');

export const projectDir = (projectId: string) => path.join(projectsDir(), projectId);
export const projectRunsDir = (projectId: string) => path.join(projectDir(projectId), 'runs');
export const runDir = (projectId: string, runId: string) => path.join(projectRunsDir(projectId), runId);
export const runPathIn = (projectId: string, runId: string, ...parts: string[]) =>
  path.join(runDir(projectId, runId), ...parts);

// ------------------------------------------------------------------ utilities

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Write via temp + rename so a concurrent reader never sees a partial file.
 *
 * The temp name carries random bytes, not just pid + millisecond. Two writes to
 * the same target inside one millisecond in one process would otherwise pick the
 * same temp path; the first rename succeeds and the second fails with ENOENT.
 * That is not hypothetical — it broke concurrent reads of the shared project
 * index, because two requests both touch it while per-project files never
 * collided.
 */
async function writeJsonAtomic(file: string, value: unknown, mode?: number) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), mode ? { mode } : undefined);
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * Serializes read-modify-write on the shared index within this process, so two
 * concurrent requests cannot each read the old list and clobber the other's
 * entry. Cross-process safety is out of scope: this is a single-server local app.
 */
let indexLock: Promise<unknown> = Promise.resolve();
function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = indexLock.then(fn, fn);
  indexLock = next.catch(() => {});
  return next;
}

async function exists(p: string) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function listDirs(p: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(p, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * A small append-only index of which projects are supposed to exist.
 *
 * The store is a plain directory tree, and the QA agent runs on the same machine
 * with broad tool permissions. If a project directory disappears — an errant
 * process, a mistaken delete, a failed sync — reading the directory alone makes
 * the library silently show fewer projects, which is the worst possible failure
 * mode for a tool whose job is to remember your projects.
 *
 * The index lets `listProjects` report a recorded project whose data is missing,
 * so loss is visible instead of silent. It holds no secrets.
 */
type IndexEntry = { id: string; name: string; fingerprint: string; createdAt: string; sourceFilename?: string };

async function readIndex(): Promise<IndexEntry[]> {
  const existing = await readJson<IndexEntry[]>(indexFile());
  if (existing) return existing;
  // No index yet (older install, or the file was lost): seed it from what is on
  // disk. Seeding rather than reporting everything as missing is deliberate — an
  // absent index is not evidence of data loss, and crying wolf would be worse.
  const seeded: IndexEntry[] = [];
  for (const id of await listDirs(projectsDir())) {
    const rec = await readJson<ProjectRecord>(path.join(projectDir(id), 'project.json'));
    if (rec) {
      seeded.push({
        id: rec.id, name: rec.name, fingerprint: rec.fingerprint,
        createdAt: rec.createdAt, sourceFilename: rec.sourceFilename,
      });
    }
  }
  await writeJsonAtomic(indexFile(), seeded);
  return seeded;
}

async function indexUpsert(rec: ProjectRecord) {
  return withIndexLock(async () => {
    const list = await readIndex();
    const next = list.filter((e) => e.id !== rec.id);
    next.push({
      id: rec.id, name: rec.name, fingerprint: rec.fingerprint,
      createdAt: rec.createdAt, sourceFilename: rec.sourceFilename,
    });
    await writeJsonAtomic(indexFile(), next);
  });
}

async function indexRemove(id: string) {
  return withIndexLock(async () => {
    await writeJsonAtomic(indexFile(), (await readIndex()).filter((e) => e.id !== id));
  });
}

/** Projects the index records but whose directory is no longer present. */
export async function missingProjects(): Promise<IndexEntry[]> {
  await ensureStore();
  const present = new Set(await listDirs(projectsDir()));
  return (await readIndex()).filter((e) => !present.has(e.id));
}

// ----------------------------------------------------------------- migration

let initialised: Promise<void> | null = null;

/**
 * Creates the store and brings a v1 layout forward.
 *
 * v1 kept `projects/<id>/{spec.enc,source.enc,meta.json}` and a single global
 * `runs/<run-id>/state.json`. v2 stores non-sensitive metadata in project.json,
 * secrets separately in secrets.enc, and nests runs under their project.
 *
 * Migration never deletes a project and never marks one active — a migrated
 * project simply appears in the library for the user to open deliberately.
 */
export async function ensureStore(): Promise<void> {
  if (!initialised) initialised = init();
  return initialised;
}

async function init() {
  await fs.mkdir(projectsDir(), { recursive: true });
  const meta = await readJson<{ schemaVersion: number }>(metaFile());
  if (meta?.schemaVersion === SCHEMA_VERSION) return;

  const notes: string[] = [];

  // 1. project.json + secrets.enc for every legacy project.
  for (const id of await listDirs(projectsDir())) {
    const dir = projectDir(id);
    if (await exists(path.join(dir, 'project.json'))) continue;
    const legacyMeta = await readJson<{ id: string; name: string; createdAt: string }>(path.join(dir, 'meta.json'));
    const specEnc = await fs.readFile(path.join(dir, 'spec.enc'), 'utf8').catch(() => null);
    if (!specEnc) { notes.push(`project ${id}: no spec.enc, left untouched`); continue; }
    let spec: QaProjectSpec;
    try {
      spec = decryptJson<QaProjectSpec>(specEnc);
    } catch (e) {
      // Wrong/rotated key: leave the files alone rather than destroying data.
      notes.push(`project ${id}: could not decrypt with the current QA_MASTER_KEY, left untouched`);
      continue;
    }
    const { safe, secrets } = splitSecrets(spec);
    const now = new Date().toISOString();
    const record: ProjectRecord = {
      id,
      name: spec.system.name,
      description: spec.system.description,
      fingerprint: fingerprintSpec(spec),
      declaredId: spec.projectId,
      spec: safe,
      createdAt: legacyMeta?.createdAt || now,
      updatedAt: now,
      runCount: 0,
      migratedFrom: 'v1',
    };
    await fs.mkdir(projectRunsDir(id), { recursive: true });
    await fs.writeFile(path.join(dir, 'secrets.enc'), encryptJson(secrets), { mode: 0o600 });
    await writeJsonAtomic(path.join(dir, 'project.json'), record);
    await fs.rm(path.join(dir, 'spec.enc'), { force: true });
    notes.push(`project ${id} (${record.name}): migrated to v2, preserved in project history`);
  }

  // 2. Re-home legacy global runs under their project.
  for (const runId of await listDirs(legacyRunsDir())) {
    const from = path.join(legacyRunsDir(), runId);
    const state = await readJson<any>(path.join(from, 'state.json'));
    const projectId = state?.projectId;
    const known = Boolean(projectId) && (await exists(projectDir(projectId)));
    const target = known ? runDir(projectId, runId) : path.join(orphanRunsDir(), runId);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(from, target).catch(() => {});
    if (state && known) {
      const owner = await readJson<ProjectRecord>(path.join(projectDir(projectId), 'project.json'));
      const record = legacyStateToRun(state, runId, projectId, owner?.name || '');
      await writeJsonAtomic(path.join(target, 'run.json'), record);
      await fs.rm(path.join(target, 'state.json'), { force: true });
    }
    notes.push(`run ${runId}: moved to ${known ? `project ${projectId}` : 'orphan-runs (owning project unknown)'}`);
  }
  await fs.rm(legacyRunsDir(), { recursive: true, force: true }).catch(() => {});

  // 3. Drop v1 leftovers and backfill any run record that migration touched
  //    across versions. Counters are derived on read, so nothing to recompute.
  for (const id of await listDirs(projectsDir())) {
    await fs.rm(path.join(projectDir(id), 'meta.json'), { force: true }).catch(() => {});
    await fs.rm(path.join(projectDir(id), 'spec.enc'), { force: true }).catch(() => {});
    const rec = await readJson<ProjectRecord>(path.join(projectDir(id), 'project.json'));
    if (!rec) continue;
    for (const runId of await listDirs(projectRunsDir(id))) {
      const rj = path.join(runDir(id, runId), 'run.json');
      const run = await readJson<RunRecord>(rj);
      if (run && !run.projectName) await writeJsonAtomic(rj, { ...run, projectName: rec.name });
    }
  }

  // Seed the integrity index from whatever is on disk right now.
  const seeded: IndexEntry[] = [];
  for (const id of await listDirs(projectsDir())) {
    const rec = await readJson<ProjectRecord>(path.join(projectDir(id), 'project.json'));
    if (rec) {
      seeded.push({
        id: rec.id, name: rec.name, fingerprint: rec.fingerprint,
        createdAt: rec.createdAt, sourceFilename: rec.sourceFilename,
      });
    }
  }
  await writeJsonAtomic(indexFile(), seeded);

  await writeJsonAtomic(metaFile(), {
    schemaVersion: SCHEMA_VERSION,
    migratedAt: new Date().toISOString(),
    notes,
  });
}

function legacyStateToRun(state: any, runId: string, projectId: string, projectName = ''): RunRecord {
  const status: RunStatus =
    state.status === 'completed' ? 'completed'
    : state.status === 'cancelled' ? 'cancelled'
    : state.status === 'failed' ? 'failed'
    : 'failed'; // a v1 run left mid-flight cannot still be running after a restart
  return {
    id: runId,
    projectId,
    projectName: state.projectName || projectName,
    envId: state.envId || '',
    mode: (state.mode || 'analyze') as QaMode,
    status,
    stage: status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed',
    createdAt: state.createdAt || new Date().toISOString(),
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    updatedAt: state.updatedAt || new Date().toISOString(),
    exitCode: state.exitCode ?? null,
    reportExists: Boolean(state.reportExists),
    failure: status === 'failed'
      ? {
          stage: 'failed',
          message: state.error
            ? String(state.error)
            : 'This run predates structured failure reporting; details were not captured.',
          exitCode: state.exitCode ?? null,
          occurredAt: state.finishedAt || state.updatedAt || new Date().toISOString(),
          retryable: true,
        }
      : undefined,
  };
}

export async function migrationNotes() {
  await ensureStore();
  return (await readJson<{ notes?: string[]; migratedAt?: string }>(metaFile())) || {};
}

// ------------------------------------------------------------------- projects

export async function readProjectRecord(id: string): Promise<ProjectRecord> {
  await ensureStore();
  const rec = await readJson<ProjectRecord>(path.join(projectDir(id), 'project.json'));
  if (!rec) throw new Error(`Project not found: ${id}`);
  return rec;
}

async function writeProjectRecord(rec: ProjectRecord) {
  rec.updatedAt = new Date().toISOString();
  await writeJsonAtomic(path.join(projectDir(rec.id), 'project.json'), rec);
  await indexUpsert(rec);
  return rec;
}

/**
 * Run statistics are derived from the run.json files present on disk rather than
 * read from a stored counter. A cached count can drift — after a crash, a manual
 * deletion, or a migration that moved runs between layouts — and a project
 * library that under-reports its own history is worse than a slightly slower one.
 */
export async function projectRunStats(projectId: string) {
  const runs = await listRunsForProject(projectId, true);
  const latest = runs[0];
  const withReport = runs.find((r) => r.reportExists);
  return {
    runCount: runs.filter((r) => r.status !== 'queued').length,
    lastRunAt: latest?.startedAt || latest?.createdAt,
    latestRunId: latest?.id,
    latestRunStatus: latest?.status,
    latestReportRunId: withReport?.id,
  };
}

export async function listProjects(): Promise<ProjectSummary[]> {
  await ensureStore();
  const ids = await listDirs(projectsDir());
  const records = await Promise.all(ids.map((id) => readProjectRecord(id).catch(() => null)));
  const present = records.filter((r): r is ProjectRecord => Boolean(r));
  const stats = await Promise.all(present.map((r) => projectRunStats(r.id)));
  return present
    .map((r, i) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      ...specStats(r.spec),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      lastOpenedAt: r.lastOpenedAt,
      ...stats[i],
    }))
    .sort((a, b) => String(b.lastRunAt || b.updatedAt).localeCompare(String(a.lastRunAt || a.updatedAt)));
}

export async function findProjectByFingerprint(fingerprint: string): Promise<ProjectRecord | null> {
  await ensureStore();
  for (const id of await listDirs(projectsDir())) {
    const rec = await readProjectRecord(id).catch(() => null);
    if (rec?.fingerprint === fingerprint) return rec;
  }
  return null;
}

export async function createProject(spec: QaProjectSpec, raw: string, filename?: string): Promise<ProjectRecord> {
  await ensureStore();
  const id = crypto.randomUUID();
  const dir = projectDir(id);
  await fs.mkdir(path.join(dir, 'runs'), { recursive: true });
  const { safe, secrets } = splitSecrets(spec);
  const now = new Date().toISOString();
  const record: ProjectRecord = {
    id,
    name: spec.system.name,
    description: spec.system.description,
    sourceFilename: filename,
    fingerprint: fingerprintSpec(spec),
    declaredId: spec.projectId,
    spec: safe,
    createdAt: now,
    updatedAt: now,
    runCount: 0,
  };
  await fs.writeFile(path.join(dir, 'secrets.enc'), encryptJson(secrets), { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'source.enc'), encryptJson({ raw, filename }), { mode: 0o600 });
  await writeJsonAtomic(path.join(dir, 'project.json'), record);
  await indexUpsert(record);
  return record;
}

/** Re-import over an existing project: definition and secrets replaced, history kept. */
export async function updateProjectFromSpec(
  id: string, spec: QaProjectSpec, raw: string, filename?: string,
): Promise<ProjectRecord> {
  const existing = await readProjectRecord(id);
  const { safe, secrets } = splitSecrets(spec);
  const dir = projectDir(id);
  await fs.writeFile(path.join(dir, 'secrets.enc'), encryptJson(secrets), { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'source.enc'), encryptJson({ raw, filename }), { mode: 0o600 });
  return writeProjectRecord({
    ...existing,
    name: spec.system.name,
    description: spec.system.description,
    sourceFilename: filename || existing.sourceFilename,
    fingerprint: fingerprintSpec(spec),
    declaredId: spec.projectId,
    spec: safe,
  });
}

/** Configuration editing from the UI. Credential values are untouched by design. */
export async function patchProject(id: string, patch: Record<string, any>): Promise<ProjectRecord> {
  const rec = await readProjectRecord(id);
  const spec: QaProjectSpecSafe = { ...rec.spec };
  if (patch.name !== undefined || patch.description !== undefined) {
    spec.system = {
      name: patch.name ?? spec.system.name,
      description: patch.description ?? spec.system.description,
    };
  }
  if (patch.environments) spec.environments = patch.environments;
  if (patch.documentation) spec.documentation = patch.documentation;
  if (patch.qa) spec.qa = { ...spec.qa, ...patch.qa };
  if (patch.accountCatalog !== undefined) {
    spec.accountCatalog = patch.accountCatalog === null ? undefined : patch.accountCatalog;
  }
  if (patch.accounts) {
    // Merge metadata only; credentialKeys/source stay as stored so no secret shape is lost.
    const byId = new Map(spec.accounts.map((a) => [a.id, a]));
    spec.accounts = patch.accounts.map((p: any) => {
      const prev = byId.get(p.id);
      return {
        id: p.id,
        role: p.role,
        label: p.label,
        loginType: p.loginType,
        notes: p.notes,
        credentialKeys: prev?.credentialKeys || [],
        source: prev?.source || 'static',
      };
    });
  }
  return writeProjectRecord({
    ...rec,
    name: spec.system.name,
    description: spec.system.description,
    spec,
  });
}

export async function duplicateProject(id: string, name?: string): Promise<ProjectRecord> {
  const src = await readProjectRecord(id);
  const newId = crypto.randomUUID();
  const dstDir = projectDir(newId);
  await fs.mkdir(path.join(dstDir, 'runs'), { recursive: true });
  for (const f of ['secrets.enc', 'source.enc']) {
    const from = path.join(projectDir(id), f);
    if (await exists(from)) await fs.copyFile(from, path.join(dstDir, f));
  }
  const now = new Date().toISOString();
  const copyName = name || `${src.name} (copy)`;
  const record: ProjectRecord = {
    ...src,
    id: newId,
    name: copyName,
    spec: { ...src.spec, system: { ...src.spec.system, name: copyName } },
    // A copy is a distinct project, so it must not collide with the original on re-import.
    fingerprint: `copy:${newId}`,
    declaredId: undefined,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: undefined,
    lastRunAt: undefined,
    runCount: 0,
    latestRunId: undefined,
    latestRunStatus: undefined,
    latestReportRunId: undefined,
  };
  await writeJsonAtomic(path.join(dstDir, 'project.json'), record);
  await indexUpsert(record);
  return record;
}

/** Removes the project, its encrypted secrets and every run artifact it owns. */
export async function deleteProject(id: string): Promise<void> {
  await ensureStore();
  const dir = projectDir(id);
  if (!(await exists(dir))) throw new Error(`Project not found: ${id}`);
  await fs.rm(dir, { recursive: true, force: true });
  await indexRemove(id);
}

export async function touchProjectOpened(id: string): Promise<void> {
  const rec = await readProjectRecord(id).catch(() => null);
  if (!rec) return;
  rec.lastOpenedAt = new Date().toISOString();
  await writeProjectRecord(rec);
}

/** Runner-only: rehydrates credentials from secrets.enc. */
export async function getFullSpec(id: string): Promise<QaProjectSpec> {
  const rec = await readProjectRecord(id);
  const enc = await fs.readFile(path.join(projectDir(id), 'secrets.enc'), 'utf8').catch(() => null);
  const secrets = enc ? decryptJson<{ accounts: Record<string, Record<string, string>> }>(enc) : { accounts: {} };
  return mergeSecrets(rec.spec, secrets);
}

/*
 * source.enc is written on import so the definition as authored is never lost,
 * but nothing reads it back. There is intentionally no accessor: the file holds
 * plaintext credentials, and a helper that returns them is one careless route
 * away from becoming a leak. Recovering a definition is a deliberate,
 * out-of-band act using QA_MASTER_KEY, not an app feature.
 */

// ----------------------------------------------------------------------- runs

/** runId -> projectId. The store is small enough that a scan beats an index to keep consistent. */
export async function findRunProject(runId: string): Promise<string | null> {
  await ensureStore();
  for (const pid of await listDirs(projectsDir())) {
    if (await exists(path.join(runDir(pid, runId), 'run.json'))) return pid;
  }
  return null;
}

export async function createRun(
  projectId: string, envId: string, mode: QaMode, scope?: RunScope, retryOf?: string,
): Promise<{ record: RunRecord; dir: string }> {
  const project = await readProjectRecord(projectId);
  const id = crypto.randomUUID();
  const dir = runDir(projectId, id);
  await fs.mkdir(path.join(dir, 'evidence'), { recursive: true });
  const now = new Date().toISOString();
  const record: RunRecord = {
    id,
    projectId,
    projectName: project.name,
    envId,
    mode,
    scope,
    status: 'queued',
    stage: 'queued',
    createdAt: now,
    updatedAt: now,
    retryOf,
  };
  await writeJsonAtomic(path.join(dir, 'run.json'), record);
  return { record, dir };
}

export async function readRunRecord(runId: string, projectId?: string): Promise<RunRecord> {
  const pid = projectId || (await findRunProject(runId));
  if (!pid) throw new Error(`Run not found: ${runId}`);
  const rec = await readJson<RunRecord>(path.join(runDir(pid, runId), 'run.json'));
  if (!rec) throw new Error(`Run not found: ${runId}`);
  return rec;
}

export async function updateRun(runId: string, patch: Partial<RunRecord>, projectId?: string): Promise<RunRecord> {
  const pid = projectId || (await findRunProject(runId));
  if (!pid) throw new Error(`Run not found: ${runId}`);
  const current = await readRunRecord(runId, pid);
  const next: RunRecord = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(path.join(runDir(pid, runId), 'run.json'), next);
  if (patch.status || patch.counts) await recomputeProjectCounters(pid);
  return next;
}

/** Persists the derived stats onto project.json. Reads never depend on this. */
export async function recomputeProjectCounters(projectId: string): Promise<void> {
  const rec = await readJson<ProjectRecord>(path.join(projectDir(projectId), 'project.json'));
  if (!rec) return;
  await writeJsonAtomic(path.join(projectDir(projectId), 'project.json'), {
    ...rec,
    ...(await projectRunStats(projectId)),
  });
}

export async function listRunsForProject(projectId: string, includeDismissed = false): Promise<RunRecord[]> {
  await ensureStore();
  const ids = await listDirs(projectRunsDir(projectId));
  const records = await Promise.all(
    ids.map((id) => readJson<RunRecord>(path.join(runDir(projectId, id), 'run.json'))),
  );
  return records
    .filter((r): r is RunRecord => Boolean(r))
    .filter((r) => includeDismissed || !r.dismissed)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function listAllRuns(includeDismissed = false): Promise<RunRecord[]> {
  await ensureStore();
  const pids = await listDirs(projectsDir());
  const all = (await Promise.all(pids.map((p) => listRunsForProject(p, includeDismissed)))).flat();
  return all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

const MAX_LOG_CHARS = 60_000;
const MAX_PROGRESS_LINES = 300;

/** Full run detail including on-disk artifacts, for the run view. */
export async function getRunDetail(runId: string) {
  const pid = await findRunProject(runId);
  if (!pid) throw new Error(`Run not found: ${runId}`);
  const dir = runDir(pid, runId);
  const record = await readRunRecord(runId, pid);
  const files: string[] = await fs.readdir(dir).catch(() => [] as string[]);
  const read = async (name: string) => (files.includes(name) ? fs.readFile(path.join(dir, name), 'utf8') : null);
  const readJsonArtifact = async (name: string) => {
    const raw = await read(name);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return { parseError: `${name} is not valid JSON`, raw: raw.slice(0, 2000) }; }
  };

  const logRaw = (await read('agent.log')) || '';
  const progressRaw = (await read('progress.ndjson')) || '';
  const evidence: string[] = await fs.readdir(path.join(dir, 'evidence')).catch(() => [] as string[]);

  return {
    ...record,
    report: await read('report.md'),
    log: logRaw.slice(-MAX_LOG_CHARS),
    analysis: await readJsonArtifact('system-analysis.json'),
    useCases: await readJsonArtifact('use-cases.json'),
    results: await readJsonArtifact('results.json'),
    accountsResolved: await readJsonArtifact('accounts-resolved.json'),
    progress: progressRaw
      .trim().split('\n').filter(Boolean).slice(-MAX_PROGRESS_LINES)
      .map((line) => { try { return JSON.parse(line); } catch { return { raw: line }; } }),
    evidence,
    files: files.filter((f) => !f.endsWith('.tmp')),
  };
}

/** Hides a finished run from the active list. Artifacts are untouched. */
export async function dismissRun(runId: string, dismissed = true): Promise<RunRecord> {
  const rec = await readRunRecord(runId);
  if (dismissed && (rec.status === 'running' || rec.status === 'queued')) {
    throw new Error('This run is still active. Cancel it before clearing it from the active list.');
  }
  return updateRun(runId, { dismissed }, rec.projectId);
}

/** Destructive: permanently removes a run's report, logs and evidence. */
export async function deleteRun(runId: string): Promise<void> {
  const rec = await readRunRecord(runId);
  if (rec.status === 'running' || rec.status === 'queued') {
    throw new Error('This run is still active. Cancel it before deleting its history.');
  }
  await fs.rm(runDir(rec.projectId, runId), { recursive: true, force: true });
  await recomputeProjectCounters(rec.projectId);
}

export async function runArtifactPath(runId: string, ...parts: string[]): Promise<string> {
  const pid = await findRunProject(runId);
  if (!pid) throw new Error(`Run not found: ${runId}`);
  return runPathIn(pid, runId, ...parts);
}

/** Any run still marked active. Used to enforce the single-active-run rule. */
export async function activeRuns(): Promise<RunRecord[]> {
  return (await listAllRuns(true)).filter((r) => r.status === 'running' || r.status === 'queued');
}
