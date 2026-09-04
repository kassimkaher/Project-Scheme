import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { QaMode, RunRecord, RunScope } from '@/types/qa';
import {
  activeRuns, createRun, getFullSpec, listRunsForProject, readProjectRecord,
  readRunRecord, runDir, updateRun,
} from './store';
import { fetchAccountCatalog, mergeAccounts, secretLiterals, type CatalogAccount } from './accounts';
import { resolveCatalog } from './spec';
import { preflight, resolveChromiumExecutable, resolvePlaywrightMcp } from './preflight';
import { buildAgentPrompt } from './agent-prompt';
import { isAlive } from './procs';
import { redact } from './redact';

const MAX_CONCURRENT = Number(process.env.QA_MAX_CONCURRENT_RUNS || 2);

export class LaunchError extends Error {
  status: number;
  payload: Record<string, unknown>;
  constructor(message: string, status = 400, payload: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

/**
 * A supervisor that died without writing a terminal status leaves its run stuck
 * on "running". Called before listing runs so a restart never shows a phantom.
 *
 * A run with no pid yet is still being prepared by the API route — preflight
 * includes a Claude Code session probe that can take up to two minutes — so it
 * gets a generous grace period. Reconciling it on a short timer would kill runs
 * that are merely slow to start.
 */
const PREPARE_GRACE_MS = 10 * 60 * 1000;

export async function reconcileRuns(): Promise<void> {
  for (const run of await activeRuns()) {
    if (!run.pid) {
      const ageMs = Date.now() - new Date(run.createdAt).getTime();
      if (ageMs < PREPARE_GRACE_MS) continue;
    }
    if (run.pid && isAlive(run.pid)) continue;
    await updateRun(run.id, {
      status: 'failed',
      stage: 'failed',
      finishedAt: new Date().toISOString(),
      failure: run.failure || {
        stage: run.stage === 'queued' ? 'preparing' : run.stage,
        message: 'The run supervisor is no longer running, so this run was marked failed.',
        detail: run.pid
          ? `Process ${run.pid} is gone but no completion was recorded. The orchestrator was most likely restarted or the process was killed externally.`
          : 'The supervisor process never registered a pid.',
        exitCode: null,
        occurredAt: new Date().toISOString(),
        retryable: true,
      },
    }, run.projectId).catch(() => {});
  }
}

export type LaunchOptions = {
  projectId: string;
  envId: string;
  mode: QaMode;
  scope?: RunScope;
  enforcePreflight?: boolean;
  retryOf?: string;
};

export type LaunchResult = {
  run: RunRecord;
  accountsResolved: number;
  catalogUrl?: string;
};

/**
 * Prepares and starts one QA run.
 *
 * Configuration is treated as configuration and live sources as live sources: the
 * OpenAPI URL and the QA account catalog are re-read on every launch so a re-run
 * never tests against a stale contract or a retired persona.
 */
export async function launchRun(opts: LaunchOptions): Promise<LaunchResult> {
  const { projectId, envId, mode, scope, enforcePreflight = true, retryOf } = opts;

  const project = await readProjectRecord(projectId);
  const env = project.spec.environments.find((e) => e.id === envId);
  if (!env) throw new LaunchError(`Environment "${envId}" is not defined in this project.`, 400);

  // ---- concurrency: one active run per project, plus a global cap
  const active = await activeRuns();
  const sameProject = active.find((r) => r.projectId === projectId);
  if (sameProject) {
    throw new LaunchError(
      'This project already has an active run. Cancel it before starting another, so two sessions cannot mutate the same QA data at once.',
      409,
      { activeRunId: sameProject.id },
    );
  }
  if (active.length >= MAX_CONCURRENT) {
    throw new LaunchError(
      `The orchestrator is already running ${active.length} QA run(s), which is the configured maximum. Cancel one, or raise QA_MAX_CONCURRENT_RUNS.`,
      409,
      { activeRunIds: active.map((r) => r.id) },
    );
  }

  const { record, dir } = await createRun(projectId, envId, mode, scope, retryOf);
  const runId = record.id;

  try {
    // ---- stage: reading configuration
    await updateRun(runId, { stage: 'reading_config', stageDetail: 'Reading the saved project definition.' }, projectId);
    const fullSpec = await getFullSpec(projectId);

    // ---- stage: resolving accounts from the live catalog
    const catalog = resolveCatalog(project.spec, envId);
    let accounts: CatalogAccount[] = fullSpec.accounts.map((a) => ({ ...a }));
    let catalogUrl: string | undefined;

    if (catalog) {
      await updateRun(runId, {
        stage: 'resolving_accounts',
        stageDetail: `Fetching the live QA account catalog: ${catalog.url}`,
      }, projectId);
      const resolution = await fetchAccountCatalog(catalog);
      catalogUrl = catalog.url;
      if (!resolution.accounts.length) {
        throw new LaunchError(
          `QA accounts could not be resolved. ${resolution.error || 'The catalog returned no usable entries.'}`,
          502,
          { stage: 'resolving_accounts', runId },
        );
      }
      if (!resolution.ok) {
        throw new LaunchError(
          `The account catalog is missing personas this project requires. ${resolution.error}`,
          502,
          { stage: 'resolving_accounts', runId },
        );
      }
      accounts = mergeAccounts(fullSpec.accounts, resolution.accounts);
      // Non-secret record of what this run resolved, for the run view.
      await fs.writeFile(
        path.join(dir, 'accounts-resolved.json'),
        JSON.stringify({
          fetchedAt: resolution.fetchedAt,
          url: resolution.url,
          rolesAvailable: resolution.rolesAvailable,
          count: accounts.length,
          accounts: accounts.map((a) => ({
            id: a.id, role: a.role, label: a.label, loginType: a.loginType,
            credentialKeys: Object.keys(a.credentials || {}).sort(),
            tenant: a.tenant, mfaRequired: a.mfaRequired,
          })),
        }, null, 2),
      );
    }

    // ---- narrow accounts to the requested scope
    if (scope?.personas?.length) accounts = accounts.filter((a) => scope.personas!.includes(a.id));
    else if (scope?.roles?.length) accounts = accounts.filter((a) => scope.roles!.includes(a.role));

    // ---- stage: preflight
    await updateRun(runId, { stage: 'preflight', stageDetail: 'Running preflight checks.' }, projectId);
    const report = await preflight({ spec: project.spec, envId, mode, outputDir: dir });
    await updateRun(runId, { preflight: report }, projectId);

    if (!report.ok && enforcePreflight) {
      const failed = report.checks.filter((c) => c.required && c.status === 'fail');
      const first = failed[0];
      throw new LaunchError(
        `Preflight failed, so the QA run was not started: ${first?.label} — ${first?.detail || 'check failed'}`,
        424,
        { stage: 'preflight', runId, preflight: report },
      );
    }

    // ---- stage: OpenAPI freshness (a re-run must not trust a cached contract)
    if (env.openapiUrl && (mode === 'api' || mode === 'full' || mode === 'analyze')) {
      await updateRun(runId, {
        stage: 'fetching_openapi',
        stageDetail: `Confirming the live OpenAPI document: ${env.openapiUrl}`,
      }, projectId);
    }

    // ---- per-run browser: local Playwright MCP, isolated profile, run-scoped output
    const mcp = resolvePlaywrightMcp();
    const needsBrowser = mode === 'web' || mode === 'full';
    if (needsBrowser && !mcp.entry) {
      throw new LaunchError(
        `Browser QA was requested but Playwright MCP is not installed: ${mcp.error}`,
        424,
        { stage: 'starting_browser', runId },
      );
    }
    // Pin the browser executable. Playwright MCP otherwise defaults to the
    // "chrome" channel and looks for a Google Chrome installation, which fails
    // at browser startup on a machine that only has the Playwright build.
    const chromium = resolveChromiumExecutable();
    const mcpArgs = mcp.entry
      ? [
          mcp.entry,
          '--isolated',                    // fresh in-memory profile, nothing inherited
          '--output-dir', './evidence',    // evidence stays inside this run
          ...(chromium.path ? ['--executable-path', chromium.path] : []),
        ]
      : [];
    await fs.writeFile(
      path.join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: mcp.entry
          ? { playwright: { command: process.execPath, args: mcpArgs } }
          : {},
      }, null, 2),
    );
    if (needsBrowser && !chromium.path) {
      throw new LaunchError(
        `Browser QA was requested but no usable Chromium executable was found: ${chromium.error}. Run: npm run qa:browsers`,
        424,
        { stage: 'starting_browser', runId },
      );
    }

    // ---- prompt (carries credentials: 0600, and the supervisor deletes it on read)
    const prompt = buildAgentPrompt({ spec: fullSpec, envId, mode, scope, runDir: dir, accounts, catalogUrl });
    await fs.writeFile(path.join(dir, 'prompt.txt'), prompt, { mode: 0o600 });

    // ---- literals the supervisor must scrub out of logs
    await fs.writeFile(
      path.join(dir, '.secret-literals.json'),
      JSON.stringify(secretLiterals(accounts)),
      { mode: 0o600 },
    );

    // ---- spawn the supervisor as its own process-group leader
    const child = spawn(process.execPath, [path.join(process.cwd(), 'scripts/run-agent.mjs'), dir], {
      cwd: process.cwd(),
      detached: true,   // new process group => cancel can stop the whole tree
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();

    // status and pid land together: a run must never claim to be running while
    // there is no process recorded for the reconciler to check.
    const run = await updateRun(runId, {
      status: 'running',
      stage: 'starting_claude',
      stageDetail: 'Starting the QA session supervisor.',
      startedAt: new Date().toISOString(),
      pid: child.pid,
      pgid: child.pid,
    }, projectId);
    return { run, accountsResolved: accounts.length, catalogUrl };
  } catch (e) {
    // Any preparation failure is recorded on the run itself, so the UI explains it
    // instead of showing a bare "failed".
    const isLaunch = e instanceof LaunchError;
    const stage = (isLaunch && (e.payload.stage as any)) || 'preparing';
    await updateRun(runId, {
      status: 'failed',
      stage: 'failed',
      finishedAt: new Date().toISOString(),
      failure: {
        stage,
        message: redact(e instanceof Error ? e.message : String(e)),
        detail: isLaunch && e.payload.preflight
          ? (e.payload.preflight as any).checks
              .filter((c: any) => c.status === 'fail')
              .map((c: any) => `${c.label}: ${c.detail}${c.fix ? ` → ${c.fix}` : ''}`)
              .join('\n')
          : undefined,
        exitCode: null,
        occurredAt: new Date().toISOString(),
        retryable: true,
        observed: { claudeStarted: false },
      },
    }, projectId).catch(() => {});
    throw e;
  }
}

/** A retry always creates a new run so the original failure stays in history. */
export async function retryRun(runId: string): Promise<LaunchResult> {
  const prev = await readRunRecord(runId);
  if (prev.status === 'running' || prev.status === 'queued') {
    throw new LaunchError('That run is still active. Cancel it before retrying.', 409);
  }
  return launchRun({
    projectId: prev.projectId,
    envId: prev.envId,
    mode: prev.mode,
    scope: prev.scope,
    retryOf: prev.id,
  });
}

export async function latestFinishedRun(projectId: string, excludeRunId?: string) {
  const runs = await listRunsForProject(projectId, true);
  return runs.find((r) => r.id !== excludeRunId && (r.status === 'completed' || r.status === 'failed'));
}

export { runDir };
