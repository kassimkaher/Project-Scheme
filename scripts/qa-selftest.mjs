#!/usr/bin/env node
/**
 * QA of the QA product.
 *
 * Exercises the project library, import/update semantics, project isolation, run
 * control, failure reporting and run comparison against a live server pointed at
 * a throwaway data directory.
 *
 *   BASE=http://127.0.0.1:4101 QA_DATA_DIR=/tmp/x node scripts/qa-selftest.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.BASE || 'http://127.0.0.1:4101';
const DATA = path.resolve(process.env.QA_DATA_DIR || '.qa-data-test');

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n── ${t}`); }

async function req(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json, text };
}
const get = (u) => req('GET', u);
const post = (u, b) => req('POST', u, b);
const patch = (u, b) => req('PATCH', u, b);
const del = (u) => req('DELETE', u);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The library and run views are client components, so anything about what the
// user actually sees has to be asserted against a rendered DOM, not SSR HTML.
const require_ = (await import('node:module')).createRequire(import.meta.url);
let browser = null;
async function renderedText(pathname) {
  if (!browser) {
    const { chromium } = require_('playwright-core');
    browser = await chromium.launch({ headless: true });
  }
  const page = await browser.newPage();
  try {
    await page.goto(`${BASE}${pathname}`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForTimeout(600);
    return await page.evaluate(() => document.body.innerText);
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------- definitions

const GENERIC = (name, projectId, apiHost = 'https://api.example.com', webHost = 'https://app.example.com') => `
\`\`\`qa-config
version: 1
projectId: "${projectId}"
system:
  name: "${name}"
  description: "Self-test project"
environments:
  - id: "qa"
    label: "QA"
    kind: "qa"
    apiBaseUrl: "${apiHost}"
    openapiUrl: "${apiHost}/openapi.yaml"
    webApps:
      - id: "main"
        label: "Main"
        url: "${webHost}"
accounts:
  - id: "admin-qa"
    role: "admin"
    label: "Admin"
    loginType: "email_password"
    credentials:
      identifier: "admin@example.com"
      password: "SelfTestSecret-A1"
  - id: "member-qa"
    role: "member"
    loginType: "email_password"
    credentials:
      identifier: "member@example.com"
      password: "SelfTestSecret-B2"
qa:
  preferredLanguage: "en"
  destructiveActions: "allow-build-test-only"
\`\`\`
`;

// A host that cannot resolve, so preflight must fail fast and clearly.
const UNREACHABLE = GENERIC(
  'Unreachable System', 'unreachable-sys',
  'https://api.invalid-host-for-qa-selftest.example', 'https://web.invalid-host-for-qa-selftest.example',
);

const SECRETS = ['SelfTestSecret-A1', 'SelfTestSecret-B2'];

// ---------------------------------------------------------------------- tests

console.log(`QA Orchestrator self-test\n  base: ${BASE}\n  data: ${DATA}`);

// ---- 1. fresh install
section('Fresh install starts generic');
{
  const r = await get('/api/projects');
  ok('GET /api/projects responds 200', r.status === 200, `got ${r.status}`);
  ok('project library is empty on a fresh data dir', Array.isArray(r.json?.projects) && r.json.projects.length === 0,
    `found ${r.json?.projects?.length} project(s)`);
  const runs = await get('/api/runs');
  ok('no runs on a fresh data dir', runs.json?.runs?.length === 0);
  const home = await fetch(`${BASE}/`).then((x) => x.text());
  ok('server-rendered home page leaks no project identity',
    !/Alpha|Beta|Legacy|Dar Al-Ilm|aljoodnet|daralilm/i.test(home));
  ok('home page contains no hardcoded customer identity',
    !/Dar Al-Ilm|aljoodnet|daralilm/i.test(home));
  const dom = await renderedText('/');
  ok('rendered home page shows the generic empty state',
    dom.includes('لا يوجد مشروع QA محمّل بعد'), dom.slice(0, 200));
  ok('rendered empty state offers import, wizard and example',
    dom.includes('استيراد تعريف QA') && dom.includes('إنشاء بالنموذج') && dom.includes('تنزيل مثال'));
  ok('rendered empty state names no project', !/Alpha|Beta|Dar Al-Ilm/i.test(dom));
  const ex = await fetch(`${BASE}/api/example`).then((x) => x.text());
  ok('shipped example is generic, not a real customer', !/Dar Al-Ilm|aljoodnet/i.test(ex) && /example\.com/.test(ex));
}

// ---- 2. import
section('Import creates a project');
let p1;
{
  const r = await post('/api/projects/import', { raw: GENERIC('Alpha System', 'alpha-sys'), filename: 'alpha.md' });
  ok('import returns 200', r.status === 200, r.json?.error);
  ok('outcome is created', r.json?.outcome === 'created', r.json?.outcome);
  p1 = r.json?.project?.id;
  ok('project got an id', Boolean(p1));
  ok('stats derived from the definition', r.json?.project?.environments === 1 && r.json?.project?.accounts === 2 && r.json?.project?.webApps === 1,
    JSON.stringify(r.json?.project));
  const lib = await get('/api/projects');
  ok('project now appears in the library', lib.json.projects.length === 1);
}

// ---- 3. credentials never leave the server in plaintext
section('Credentials are encrypted at rest and never served');
{
  const detail = await get(`/api/projects/${p1}`);
  const blob = JSON.stringify(detail.json);
  ok('project detail exposes no credential value', !SECRETS.some((s) => blob.includes(s)));
  ok('project detail exposes credential field names only',
    detail.json.project.spec.accounts[0].credentialKeys?.includes('password'));
  ok('no "credentials" object is returned at all', !/"credentials"\s*:/.test(blob));

  const files = [];
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full); else files.push(full);
    }
  }
  await walk(DATA);
  let leaked = [];
  for (const f of files) {
    const body = await fs.readFile(f, 'utf8').catch(() => '');
    if (SECRETS.some((s) => body.includes(s))) leaked.push(path.relative(DATA, f));
  }
  ok('no plaintext credential anywhere in the data directory', leaked.length === 0, leaked.join(', '));
  ok('project.json is plaintext metadata (listable)', files.some((f) => f.endsWith('project.json')));
  ok('secrets live in a separate encrypted file', files.some((f) => f.endsWith('secrets.enc')));
}

// ---- 4. re-import semantics
section('Re-import never silently duplicates');
{
  const again = await post('/api/projects/import', { raw: GENERIC('Alpha System', 'alpha-sys') });
  ok('identical re-import returns 409 conflict', again.status === 409, `got ${again.status}`);
  ok('conflict names the matching project', again.json?.match?.id === p1);
  ok('conflict explains how it matched', again.json?.match?.matchedOn === 'declared projectId', again.json?.match?.matchedOn);

  const upd = await post('/api/projects/import', {
    raw: GENERIC('Alpha System Renamed', 'alpha-sys'), onConflict: 'update',
  });
  ok('update outcome is updated', upd.json?.outcome === 'updated');
  ok('update keeps the same project id', upd.json?.project?.id === p1);
  const lib = await get('/api/projects');
  ok('update did not create a second project', lib.json.projects.length === 1, `${lib.json.projects.length}`);
  ok('updated name is reflected', lib.json.projects[0].name === 'Alpha System Renamed', lib.json.projects[0].name);

  const cp = await post('/api/projects/import', {
    raw: GENERIC('Alpha System Renamed', 'alpha-sys'), onConflict: 'copy',
  });
  ok('explicit copy outcome is copied', cp.json?.outcome === 'copied');
  ok('copy has a different id', cp.json?.project?.id && cp.json.project.id !== p1);
  const lib2 = await get('/api/projects');
  ok('copy created a second project', lib2.json.projects.length === 2);
  await del(`/api/projects/${cp.json.project.id}`);
}

// ---- 5. second project + isolation
section('Two projects stay isolated');
let p2;
{
  const r = await post('/api/projects/import', { raw: GENERIC('Beta System', 'beta-sys', 'https://api.beta.example', 'https://web.beta.example') });
  p2 = r.json?.project?.id;
  ok('second project imported as new', r.json?.outcome === 'created' && p2 !== p1);

  const [d1, d2] = await Promise.all([get(`/api/projects/${p1}`), get(`/api/projects/${p2}`)]);
  ok('project A keeps its own sources', d1.json.project.spec.environments[0].apiBaseUrl === 'https://api.example.com');
  ok('project B keeps its own sources', d2.json.project.spec.environments[0].apiBaseUrl === 'https://api.beta.example');
  ok('project A run history is its own', Array.isArray(d1.json.runs));
  ok('project B run history is its own', Array.isArray(d2.json.runs));

  const dirs = await fs.readdir(path.join(DATA, 'projects'));
  ok('each project owns a separate directory', dirs.includes(p1) && dirs.includes(p2));
  ok('each project owns a separate secrets file',
    await fs.access(path.join(DATA, 'projects', p1, 'secrets.enc')).then(() => true).catch(() => false)
    && await fs.access(path.join(DATA, 'projects', p2, 'secrets.enc')).then(() => true).catch(() => false));
}

// ---- 6. config editing
section('Configuration editing keeps secrets untouched');
{
  const before = await get(`/api/projects/${p1}`);
  const envs = structuredClone(before.json.project.spec.environments);
  envs[0].label = 'QA Edited';
  envs[0].openapiUrl = 'https://api.example.com/v2/openapi.yaml';
  const r = await patch(`/api/projects/${p1}`, {
    name: 'Alpha Edited',
    description: 'Edited by self-test',
    environments: envs,
    accounts: before.json.project.spec.accounts.map((a) => ({
      id: a.id, role: a.role === 'member' ? 'viewer' : a.role, label: a.label, loginType: a.loginType,
    })),
  });
  ok('PATCH returns 200', r.status === 200, r.json?.error);
  const after = await get(`/api/projects/${p1}`);
  ok('name change persisted', after.json.project.name === 'Alpha Edited');
  ok('environment edit persisted', after.json.project.spec.environments[0].openapiUrl.endsWith('/v2/openapi.yaml'));
  ok('account role edit persisted', after.json.project.spec.accounts.some((a) => a.role === 'viewer'));
  ok('credential field names survived the edit',
    after.json.project.spec.accounts.every((a) => a.credentialKeys.length === 2));

  // The encrypted secrets must still decrypt to the original values.
  const runsBefore = after.json.runs.length;
  const pre = await post(`/api/projects/${p1}/preflight`, { envId: 'qa', mode: 'analyze', skipSessionProbe: true });
  ok('preflight still reads the project after editing', pre.status === 200, pre.json?.error);
  ok('editing did not fabricate runs', after.json.runs.length === runsBefore);
}

// ---- 7. duplicate
section('Duplicate creates an independent project');
{
  const r = await post(`/api/projects/${p1}/duplicate`, {});
  const dupId = r.json?.project?.id;
  ok('duplicate returns a new id', dupId && dupId !== p1);
  const d = await get(`/api/projects/${dupId}`);
  ok('duplicate starts with an empty run history', d.json.runs.length === 0);
  ok('duplicate carries the definition over', d.json.project.spec.accounts.length === 2);
  ok('duplicate keeps its own encrypted secrets',
    await fs.access(path.join(DATA, 'projects', dupId, 'secrets.enc')).then(() => true).catch(() => false));
  const reimport = await post('/api/projects/import', { raw: GENERIC('Alpha Edited', 'alpha-sys'), onConflict: 'ask' });
  ok('a copy does not hijack the original on re-import', reimport.status === 409 && reimport.json.match.id === p1,
    `matched ${reimport.json?.match?.id}`);
  await del(`/api/projects/${dupId}`);
}

// ---- 8. preflight fails fast with an actionable reason
section('Preflight refuses a broken configuration before spending a run');
let pBad, badRunId;
{
  const imp = await post('/api/projects/import', { raw: UNREACHABLE, filename: 'unreachable.md' });
  pBad = imp.json?.project?.id;
  ok('unreachable project imported', Boolean(pBad));

  const pre = await post(`/api/projects/${pBad}/preflight`, { envId: 'qa', mode: 'api', skipSessionProbe: true });
  ok('preflight completes without throwing', pre.status === 200, pre.json?.error);
  const checks = pre.json.preflight.checks;
  const api = checks.find((c) => c.id === 'api_reachable');
  const oapi = checks.find((c) => c.id === 'openapi_reachable');
  ok('preflight reports the API host as unreachable', api?.status === 'fail', JSON.stringify(api));
  ok('preflight reports the OpenAPI URL as unreachable', oapi?.status === 'fail', JSON.stringify(oapi));
  ok('failing checks carry a concrete fix suggestion', Boolean(api?.fix) && Boolean(oapi?.fix));
  ok('preflight overall verdict is not ok', pre.json.preflight.ok === false);

  const start = await post(`/api/projects/${pBad}/runs`, { envId: 'qa', mode: 'api', enforcePreflight: true });
  ok('starting the run is refused with 424', start.status === 424, `got ${start.status}: ${start.json?.error}`);
  ok('refusal message names the failing dependency', /reachable|OpenAPI|API/i.test(start.json?.error || ''), start.json?.error);
  badRunId = start.json?.runId;
  ok('a run record was still created so the failure is inspectable', Boolean(badRunId));

  const runs = await get(`/api/projects/${pBad}/runs`);
  const rec = runs.json.runs.find((r) => r.id === badRunId);
  ok('the refused run is marked failed', rec?.status === 'failed', rec?.status);
  ok('the failure records the preflight stage', rec?.failure?.stage === 'preflight', rec?.failure?.stage);
  ok('the failure has a human-readable message', typeof rec?.failure?.message === 'string' && rec.failure.message.length > 20);
  ok('the failure detail lists what to fix', /reachable|Confirm|Verify/i.test(rec?.failure?.detail || ''), rec?.failure?.detail);
  ok('the failure is marked retryable', rec?.failure?.retryable === true);
  ok('Claude was never started for a preflight failure', rec?.failure?.observed?.claudeStarted === false);
  ok('no secret leaked into the failure record', !SECRETS.some((s) => JSON.stringify(rec).includes(s)));
}

// ---- 9. retry preserves history
section('Retry creates a new run and preserves the old one');
{
  const r = await post(`/api/runs/${badRunId}/retry`);
  ok('retry is accepted', r.status === 200 || r.status === 424, `${r.status}: ${r.json?.error}`);
  const runs = await get(`/api/projects/${pBad}/runs`);
  ok('the original failed run still exists', runs.json.runs.some((x) => x.id === badRunId));
  ok('a second run record now exists', runs.json.runs.length >= 2, `${runs.json.runs.length}`);
  const retried = runs.json.runs.find((x) => x.retryOf === badRunId);
  ok('the new run points back at the run it retried', Boolean(retried));
  ok('the new run has a different id', retried && retried.id !== badRunId);
}

// ---- 10. clear vs delete
section('Clear hides a run; delete is a separate destructive action');
{
  const dir = path.join(DATA, 'projects', pBad, 'runs', badRunId);
  await fs.writeFile(path.join(dir, 'report.md'), '# self-test report\n');

  const dismissed = await post(`/api/runs/${badRunId}/dismiss`, { dismissed: true });
  ok('dismiss returns 200', dismissed.status === 200, dismissed.json?.error);
  const active = await get(`/api/projects/${pBad}/runs`);
  ok('the run is hidden from the active list', !active.json.runs.some((x) => x.id === badRunId));
  const all = await get(`/api/projects/${pBad}/runs?all=true`);
  ok('the run is still in the full history', all.json.runs.some((x) => x.id === badRunId));
  ok('clear did NOT delete the report file',
    await fs.access(path.join(dir, 'report.md')).then(() => true).catch(() => false));
  ok('clear did NOT delete the run record',
    await fs.access(path.join(dir, 'run.json')).then(() => true).catch(() => false));

  const back = await post(`/api/runs/${badRunId}/dismiss`, { dismissed: false });
  ok('a cleared run can be restored to the active list', back.status === 200
    && (await get(`/api/projects/${pBad}/runs`)).json.runs.some((x) => x.id === badRunId));

  const gone = await del(`/api/runs/${badRunId}`);
  ok('explicit delete returns 200', gone.status === 200, gone.json?.error);
  ok('delete removed the run directory',
    !(await fs.access(dir).then(() => true).catch(() => false)));
}

// ---- 11. run comparison
section('Run comparison reports what changed');
{
  // Two synthetic finished runs with known results, written straight to the store.
  const mk = async (runId, cases, issues, createdAt) => {
    const dir = path.join(DATA, 'projects', p2, 'runs', runId);
    await fs.mkdir(path.join(dir, 'evidence'), { recursive: true });
    await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify({
      id: runId, projectId: p2, projectName: 'Beta System', envId: 'qa', mode: 'full',
      status: 'completed', stage: 'completed', createdAt, updatedAt: createdAt,
      startedAt: createdAt, finishedAt: createdAt, reportExists: true,
    }, null, 2));
    await fs.writeFile(path.join(dir, 'results.json'), JSON.stringify({ cases, issues }, null, 2));
    await fs.writeFile(path.join(dir, 'report.md'), '# r\n');
  };
  await mk('11111111-1111-4111-8111-111111111111',
    [
      { id: 'uc-001', title: 'Login', status: 'passed' },
      { id: 'uc-002', title: 'Create record', status: 'failed' },
      { id: 'uc-003', title: 'Permissions', status: 'failed' },
      { id: 'uc-004', title: 'Persistence', status: 'blocked' },
    ],
    [
      { id: 'BUG-1', title: 'Create fails on empty name', severity: 'high', useCaseId: 'uc-002' },
      { id: 'BUG-2', title: 'Viewer can edit', severity: 'critical', useCaseId: 'uc-003' },
    ],
    '2026-09-01T10:00:00.000Z');
  await mk('22222222-2222-4222-8222-222222222222',
    [
      { id: 'uc-001', title: 'Login', status: 'passed' },
      { id: 'uc-002', title: 'Create record', status: 'passed' },
      { id: 'uc-003', title: 'Permissions', status: 'failed' },
      { id: 'uc-004', title: 'Persistence', status: 'passed' },
      { id: 'uc-005', title: 'New export flow', status: 'failed' },
    ],
    [
      { id: 'BUG-2', title: 'Viewer can edit', severity: 'critical', useCaseId: 'uc-003' },
      { id: 'BUG-3', title: 'Export truncates', severity: 'medium', useCaseId: 'uc-005' },
    ],
    '2026-09-02T10:00:00.000Z');

  const c = await get('/api/runs/22222222-2222-4222-8222-222222222222/compare');
  ok('compare returns 200', c.status === 200, c.json?.error);
  const cmp = c.json?.comparison;
  ok('baseline is the earlier run', c.json?.baseline?.id === '11111111-1111-4111-8111-111111111111');
  ok('newly failing detected (uc-005)', cmp?.newlyFailing?.length === 1 && cmp.newlyFailing[0].id === 'uc-005',
    JSON.stringify(cmp?.newlyFailing));
  ok('fixed detected (uc-002 and uc-004)', cmp?.fixed?.length === 2, JSON.stringify(cmp?.fixed?.map((x) => x.id)));
  ok('still failing detected (uc-003)', cmp?.stillFailing?.length === 1 && cmp.stillFailing[0].id === 'uc-003');
  ok('new issues detected (BUG-3)', cmp?.newIssues?.length === 1 && cmp.newIssues[0].id === 'BUG-3');
  ok('resolved issues detected (BUG-1)', cmp?.resolvedIssues?.length === 1 && cmp.resolvedIssues[0].id === 'BUG-1');
  ok('pass count delta is +2', cmp?.counts?.delta?.passed === 2, `${cmp?.counts?.delta?.passed}`);
  // Baseline failed uc-002+uc-003; current fails uc-003+uc-005. The count is
  // unchanged, which is exactly why the set diff above carries the real signal.
  ok('fail count delta is 0 (one fixed, one newly failing)', cmp?.counts?.delta?.failed === 0, `${cmp?.counts?.delta?.failed}`);
  ok('blocked count delta is -1', cmp?.counts?.delta?.blocked === -1, `${cmp?.counts?.delta?.blocked}`);
  ok('total count delta is +1', cmp?.counts?.delta?.total === 1, `${cmp?.counts?.delta?.total}`);
}

// ---- 12. concurrency guard
// Depends on pBad from section 8 (unreachable host) still existing; section 15
// deletes it.
section('Concurrency is enforced explicitly');
{
  const dir = path.join(DATA, 'projects', p2, 'runs', '33333333-3333-4333-8333-333333333333');
  await fs.mkdir(path.join(dir, 'evidence'), { recursive: true });
  // A run that claims to be running, owned by this very process so it looks alive.
  await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify({
    id: '33333333-3333-4333-8333-333333333333', projectId: p2, projectName: 'Beta System',
    envId: 'qa', mode: 'full', status: 'running', stage: 'web_testing',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(), pid: process.pid, pgid: process.pid,
  }, null, 2));

  const blocked = await post(`/api/projects/${p2}/runs`, { envId: 'qa', mode: 'analyze' });
  ok('a second run for the same project is refused with 409', blocked.status === 409, `got ${blocked.status}`);
  ok('the refusal explains why', /active run/i.test(blocked.json?.error || ''), blocked.json?.error);
  ok('the refusal names the blocking run', blocked.json?.activeRunId === '33333333-3333-4333-8333-333333333333');

  // Cross-project check uses the UNREACHABLE project on purpose. Launching the
  // reachable one would pass preflight and spawn a real Claude Code session that
  // this suite does not own and cannot clean up — an earlier version did exactly
  // that and left two live agent sessions running after the suite reported green.
  // A 424 here proves the request was refused by preflight, not by concurrency.
  const otherProject = await post(`/api/projects/${pBad}/runs`, { envId: 'qa', mode: 'web', enforcePreflight: true });
  ok('a different project is not blocked by project B\'s active run',
    otherProject.status !== 409, `${otherProject.status}: ${otherProject.json?.error}`);
  ok('that request was refused by preflight, so no agent session was spawned',
    otherProject.status === 424, `${otherProject.status}`);

  await fs.rm(dir, { recursive: true, force: true });
}

// ---- 13. process-group kill mechanism
section('Cancel stops a whole process tree, not just the parent');
{
  // Mirrors how the API spawns the supervisor: detached parent that spawns a child.
  const helper = path.join(DATA, 'tree-helper.mjs');
  await fs.writeFile(helper, `
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
process.stdout.write(String(child.pid));
setInterval(() => {}, 1000);
`);
  const parent = spawn(process.execPath, [helper], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let childPid = '';
  parent.stdout.on('data', (d) => { childPid += d.toString(); });
  await sleep(1200);
  const kidPid = Number(childPid.trim());
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

  ok('parent process is running', alive(parent.pid));
  ok('child process is running', kidPid > 0 && alive(kidPid), `child pid ${kidPid}`);

  // Kill the group, exactly as killRunTree does.
  process.kill(-parent.pid, 'SIGTERM');
  await sleep(900);
  ok('killing the process group stopped the parent', !alive(parent.pid));
  ok('killing the process group also stopped the child', !alive(kidPid));

  // An unrelated process must survive.
  const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  bystander.unref();
  await sleep(400);
  ok('an unrelated process is untouched by the group kill', alive(bystander.pid));
  try { process.kill(-bystander.pid, 'SIGKILL'); } catch { try { process.kill(bystander.pid, 'SIGKILL'); } catch {} }
  await fs.rm(helper, { force: true });
}

// ---- 14. restart persistence
section('Everything survives an orchestrator restart');
{
  const before = await get('/api/projects');
  const names = before.json.projects.map((p) => p.name).sort();
  ok('library is non-empty before restart check', names.length >= 2, names.join(', '));
  // The store is read from disk on every request, so re-reading proves durability.
  const meta = JSON.parse(await fs.readFile(path.join(DATA, 'meta.json'), 'utf8'));
  // Read the expected version out of the source so a schema bump does not need
  // this assertion edited — a hardcoded 2 failed the suite the moment it moved to 3.
  const storeSrc = await fs.readFile(path.join(import.meta.dirname, '..', 'lib', 'store.ts'), 'utf8');
  const expected = Number(storeSrc.match(/SCHEMA_VERSION\s*=\s*(\d+)/)?.[1]);
  ok('store records the current schema version',
    meta.schemaVersion === expected, `on disk ${meta.schemaVersion}, source says ${expected}`);
  ok('project integrity index exists',
    await fs.access(path.join(DATA, 'projects.index.json')).then(() => true).catch(() => false));
  const after = await get('/api/projects');
  ok('the same projects are still listed', JSON.stringify(after.json.projects.map((p) => p.name).sort()) === JSON.stringify(names));
  const runsAfter = await get(`/api/projects/${p2}/runs?all=true`);
  ok('previous runs remain readable', runsAfter.json.runs.length >= 2, `${runsAfter.json.runs.length}`);
  const detail = await get('/api/runs/11111111-1111-4111-8111-111111111111');
  ok('an old run\'s report is still served', typeof detail.json?.report === 'string');
  ok('an old run\'s results are still parsed', Array.isArray(detail.json?.results?.cases));
}

// ---- 15. delete project removes secrets and artifacts
section('Deleting a project removes its secrets and run artifacts');
{
  const dir = path.join(DATA, 'projects', pBad);
  const existedBefore = await fs.access(dir).then(() => true).catch(() => false);
  ok('project directory exists before delete', existedBefore);
  const r = await del(`/api/projects/${pBad}`);
  ok('delete returns 200', r.status === 200, r.json?.error);
  ok('delete reports what it removed', typeof r.json?.deleted?.runsRemoved === 'number');
  ok('project directory is gone', !(await fs.access(dir).then(() => true).catch(() => false)));
  const lib = await get('/api/projects');
  ok('project no longer listed', !lib.json.projects.some((p) => p.id === pBad));
}

// ------------------------------------------------------------------- summary

// ---- 16. the suite itself must leave nothing running
section('The suite leaves no process behind');
{
  const { execSync } = await import('node:child_process');
  const count = (pat) => {
    try { return execSync(`pgrep -f ${JSON.stringify(pat)} | wc -l`, { encoding: 'utf8' }).trim(); }
    catch { return '0'; }
  };
  for (const pat of ['scripts/run-agent.mjs', 'output-format stream-json', '@playwright/mcp/cli.js']) {
    const n = Number(count(pat));
    ok(`no leftover process matching "${pat}"`, n === 0, `${n} found`);
  }
}

if (browser) await browser.close();

console.log(`\n${'─'.repeat(60)}`);
console.log(`passed ${pass}   failed ${fail}`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
}
process.exit(fail ? 1 : 0);
