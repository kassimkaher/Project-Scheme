import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { PreflightCheck, PreflightReport, QaMode, QaProjectSpecSafe } from '@/types/qa';
import { fetchAccountCatalog } from './accounts';
import { resolveCatalog } from './spec';
import { redact } from './redact';

function check(c: PreflightCheck): PreflightCheck { return c; }

async function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string; err: string; spawnError?: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, out: '', err: '', spawnError: e instanceof Error ? e.message : String(e) });
      return;
    }
    let out = '', err = '', done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ code: null, out, err, spawnError: `timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.stderr?.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ code: null, out, err, spawnError: e.message });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

/**
 * A URL counts as reachable if the host answered at all. A 401/404 is a valid
 * answer from a live service, so only transport failures fail the check.
 */
async function reachable(url: string, timeoutMs = 15_000): Promise<{ ok: boolean; status?: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow', cache: 'no-store' });
    return { ok: true, status: res.status };
  } catch (e) {
    const err = e instanceof Error && e.name === 'AbortError'
      ? `no response within ${timeoutMs / 1000}s`
      : e instanceof Error ? e.message : String(e);
    return { ok: false, error: err };
  } finally {
    clearTimeout(timer);
  }
}

// A Claude Code session smoke test costs tokens, so its result is reused briefly.
let claudeSessionCache: { at: number; check: PreflightCheck } | null = null;
const SESSION_TTL_MS = 10 * 60 * 1000;

/**
 * Locates the locally installed Playwright MCP CLI by walking node_modules from
 * the working directory upward.
 *
 * Deliberately filesystem-based rather than require.resolve: this module is
 * bundled by Next, and a bundler rewrites require calls to internal module ids,
 * which made resolution fail at runtime with "Cannot find module '64608'".
 * Reading package.json off disk behaves the same in dev, in a production build
 * and in the standalone runner.
 */
export function resolvePlaywrightMcp(): { entry?: string; version?: string; error?: string } {
  const tried: string[] = [];
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth++) {
    const pkgPath = path.join(dir, 'node_modules', '@playwright', 'mcp', 'package.json');
    tried.push(pkgPath);
    if (fsSync.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fsSync.readFileSync(pkgPath, 'utf8'));
        const binRel = typeof pkg.bin === 'string'
          ? pkg.bin
          : pkg.bin?.['playwright-mcp'] || pkg.bin?.mcp || Object.values(pkg.bin || {})[0];
        if (!binRel || typeof binRel !== 'string') {
          return { error: `@playwright/mcp ${pkg.version} is installed but exposes no CLI entry point.` };
        }
        const entry = path.join(path.dirname(pkgPath), binRel);
        if (!fsSync.existsSync(entry)) {
          return { error: `@playwright/mcp ${pkg.version} is installed but its CLI file is missing: ${entry}` };
        }
        return { entry, version: pkg.version };
      } catch (e) {
        return { error: `@playwright/mcp package.json could not be read: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { error: `@playwright/mcp is not installed. Looked in: ${tried.slice(0, 3).join(', ')}` };
}

function chromiumDirs(): string[] {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH
    || (process.platform === 'darwin'
      ? path.join(process.env.HOME || '', 'Library/Caches/ms-playwright')
      : path.join(process.env.HOME || '', '.cache/ms-playwright'));
  return [base];
}

/**
 * Resolves the bundled Chromium executable.
 *
 * Playwright MCP's --browser flag only accepts chrome | firefox | webkit |
 * msedge, and it defaults to the "chrome" *channel*, which means a real Google
 * Chrome installation. On a machine without Chrome that default fails at browser
 * startup. Pointing --executable-path at the Playwright build we install
 * ourselves makes browser QA deterministic instead of dependent on what the
 * operator happens to have installed.
 */
export function resolveChromiumExecutable(): { path?: string; build?: string; error?: string } {
  const rel = process.platform === 'darwin'
    ? ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
       'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
       'chrome-mac/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? ['chrome-win/chrome.exe']
      : ['chrome-linux/chrome'];

  for (const root of chromiumDirs()) {
    let entries: string[] = [];
    try { entries = fsSync.readdirSync(root); } catch { continue; }
    // Prefer the full browser over the headless shell, newest build first.
    const builds = entries
      .filter((e) => /^chromium-\d+$/.test(e))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const build of builds) {
      for (const r of rel) {
        const full = path.join(root, build, r);
        if (fsSync.existsSync(full)) return { path: full, build };
      }
    }
    if (builds.length) {
      return { build: builds[0], error: `build ${builds[0]} is present but no executable matched ${rel[0]}` };
    }
  }
  return { error: `no chromium build found under ${chromiumDirs().join(', ')}` };
}

async function chromiumInstalled(): Promise<{ ok: boolean; detail: string }> {
  const exe = resolveChromiumExecutable();
  if (exe.path) return { ok: true, detail: `${exe.build} → ${exe.path}` };
  const shells: string[] = [];
  for (const dir of chromiumDirs()) {
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    shells.push(...entries.filter((e) => e.startsWith('chromium')));
  }
  return {
    ok: false,
    detail: exe.error || (shells.length
      ? `only ${shells.join(', ')} present; no full Chromium executable`
      : 'no chromium build found'),
  };
}

export type PreflightInput = {
  spec: QaProjectSpecSafe;
  envId: string;
  mode: QaMode;
  /** Directory the run will write into. */
  outputDir?: string;
  /** Skips the token-consuming Claude session smoke test. */
  skipSessionProbe?: boolean;
};

/**
 * Fails fast, before an expensive QA run starts, and says exactly what to fix.
 * Never throws: a broken check is reported as a failed check.
 */
export async function preflight(input: PreflightInput): Promise<PreflightReport> {
  const { spec, envId, mode, outputDir, skipSessionProbe } = input;
  const checks: PreflightCheck[] = [];
  const env = spec.environments.find((e) => e.id === envId);
  const needsBrowser = mode === 'web' || mode === 'full';

  // ---- Claude Code CLI
  const bin = process.env.CLAUDE_BIN || 'claude';
  const cli = await run(bin, ['--version'], 20_000);
  checks.push(check({
    id: 'claude_cli',
    label: 'Claude Code CLI available',
    status: cli.code === 0 ? 'pass' : 'fail',
    detail: cli.code === 0 ? cli.out.trim().split('\n')[0] : redact(cli.spawnError || cli.err || `exit ${cli.code}`),
    fix: cli.code === 0 ? undefined : `Install Claude Code and make sure "${bin}" is on PATH, or set CLAUDE_BIN in .env.local.`,
    required: true,
  }));

  // ---- Effective session arguments must be able to answer a tool prompt.
  // A non-interactive session with no permission mode denies every prompt
  // silently, which is indistinguishable from a hung run.
  {
    const replace = process.env.CLAUDE_ARGS_REPLACE === '1';
    const extra = (process.env.CLAUDE_ARGS || '').trim().split(/\s+/).filter(Boolean);
    const effective = replace ? extra : [...extra, '--permission-mode'];
    const armed = effective.includes('--permission-mode') || effective.includes('--dangerously-skip-permissions');
    checks.push(check({
      id: 'session_permissions',
      label: 'QA session can grant itself tool permissions',
      status: armed ? 'pass' : 'fail',
      detail: replace
        ? `CLAUDE_ARGS_REPLACE=1, so arguments are exactly: ${extra.join(' ') || '(empty)'}`
        : 'Defaults enforce --permission-mode bypassPermissions; CLAUDE_ARGS is merged, not substituted.',
      fix: armed ? undefined : 'Add --permission-mode bypassPermissions to CLAUDE_ARGS, or unset CLAUDE_ARGS_REPLACE so the safe defaults apply.',
      required: true,
    }));
  }

  // ---- Claude Code session actually starts
  if (cli.code !== 0) {
    checks.push(check({
      id: 'claude_session', label: 'Claude Code session starts', status: 'skip',
      detail: 'Skipped because the CLI is unavailable.', required: true,
    }));
  } else if (skipSessionProbe) {
    checks.push(check({
      id: 'claude_session', label: 'Claude Code session starts', status: 'skip',
      detail: 'Session probe skipped by request.', required: false,
    }));
  } else if (claudeSessionCache && Date.now() - claudeSessionCache.at < SESSION_TTL_MS) {
    checks.push({ ...claudeSessionCache.check, detail: `${claudeSessionCache.check.detail || ''} (cached)`.trim() });
  } else {
    const args = (process.env.CLAUDE_ARGS || '-p').trim().split(/\s+/).filter(Boolean);
    if (process.env.CLAUDE_MODEL) args.push('--model', process.env.CLAUDE_MODEL);
    const probe = await new Promise<{ code: number | null; out: string; err: string; spawnError?: string }>((resolve) => {
      let child;
      try {
        child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        resolve({ code: null, out: '', err: '', spawnError: e instanceof Error ? e.message : String(e) });
        return;
      }
      let out = '', err = '', done = false;
      const timer = setTimeout(() => {
        if (done) return; done = true;
        try { child.kill('SIGKILL'); } catch {}
        resolve({ code: null, out, err, spawnError: 'session did not respond within 120s' });
      }, 120_000);
      child.stdout?.on('data', (d) => { out += d.toString(); });
      child.stderr?.on('data', (d) => { err += d.toString(); });
      child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: null, out, err, spawnError: e.message }); } });
      child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out, err }); } });
      child.stdin?.write('Reply with the single word READY and nothing else.');
      child.stdin?.end();
    });
    const ok = probe.code === 0 && /ready/i.test(probe.out);
    const c = check({
      id: 'claude_session',
      label: 'Claude Code session starts',
      status: ok ? 'pass' : 'fail',
      detail: ok
        ? `model ${process.env.CLAUDE_MODEL || 'default'} responded`
        : redact(probe.spawnError || probe.err.trim().split('\n').slice(-3).join(' ') || probe.out.trim().slice(-300) || `exit ${probe.code}`),
      fix: ok ? undefined : 'Run "claude" once interactively to finish authentication, and check CLAUDE_ARGS / CLAUDE_MODEL in .env.local.',
      required: true,
    });
    claudeSessionCache = { at: Date.now(), check: c };
    checks.push(c);
  }

  // ---- Environment exists
  checks.push(check({
    id: 'environment',
    label: 'Selected environment exists in the definition',
    status: env ? 'pass' : 'fail',
    detail: env ? `${env.label} (${env.kind})` : `No environment with id "${envId}"`,
    fix: env ? undefined : 'Pick a different environment, or re-import the definition with this environment declared.',
    required: true,
  }));

  // ---- Output directory writable
  if (outputDir) {
    let ok = true, detail = outputDir;
    try {
      await fs.mkdir(path.join(outputDir, 'evidence'), { recursive: true });
      const probe = path.join(outputDir, '.write-probe');
      await fs.writeFile(probe, 'ok');
      await fs.rm(probe, { force: true });
    } catch (e) {
      ok = false;
      detail = e instanceof Error ? e.message : String(e);
    }
    checks.push(check({
      id: 'output_writable', label: 'Run output directory writable',
      status: ok ? 'pass' : 'fail', detail,
      fix: ok ? undefined : 'Check filesystem permissions on QA_DATA_DIR.',
      required: true,
    }));
  }

  // ---- API base URL
  if (env?.apiBaseUrl) {
    const r = await reachable(env.apiBaseUrl);
    checks.push(check({
      id: 'api_reachable', label: 'API base URL reachable',
      status: r.ok ? 'pass' : 'fail',
      detail: r.ok ? `HTTP ${r.status} (any response proves the host is live)` : r.error,
      fix: r.ok ? undefined : 'Confirm the API host is up and reachable from this machine (VPN/DNS/firewall).',
      required: mode === 'api' || mode === 'full',
    }));
  }

  // ---- OpenAPI
  if (env?.openapiUrl) {
    const r = await reachable(env.openapiUrl, 30_000);
    const good = r.ok && r.status !== undefined && r.status < 400;
    checks.push(check({
      id: 'openapi_reachable', label: 'OpenAPI document reachable',
      status: good ? 'pass' : r.ok ? 'warn' : 'fail',
      detail: r.ok ? `HTTP ${r.status}` : r.error,
      fix: good ? undefined : 'Verify the OpenAPI URL serves the document without authentication, or remove it from the definition.',
      required: mode === 'api' || mode === 'full',
    }));
  }

  // ---- Web apps
  if (needsBrowser && env) {
    if (!env.webApps.length) {
      checks.push(check({
        id: 'web_apps', label: 'Web applications declared', status: 'fail',
        detail: 'This environment declares no web applications.',
        fix: 'Add a webApps entry to the environment, or run in API/Analyze mode instead.',
        required: true,
      }));
    } else {
      for (const app of env.webApps) {
        const r = await reachable(app.url);
        checks.push(check({
          id: `web_reachable:${app.id}`, label: `Web app reachable — ${app.label}`,
          status: r.ok ? 'pass' : 'fail',
          detail: r.ok ? `HTTP ${r.status} · ${app.url}` : `${app.url} — ${r.error}`,
          fix: r.ok ? undefined : 'Confirm the web app is deployed and reachable from this machine.',
          required: true,
        }));
      }
    }
  }

  // ---- Account catalog
  const catalog = env ? resolveCatalog(spec, envId) : null;
  if (catalog) {
    const res = await fetchAccountCatalog(catalog);
    checks.push(check({
      id: 'account_catalog', label: 'QA account catalog resolves',
      status: res.ok ? 'pass' : res.accounts.length ? 'warn' : 'fail',
      detail: res.accounts.length
        ? `${res.accounts.length} personas · roles: ${res.rolesAvailable.join(', ')}${res.error ? ` — ${res.error}` : ''}`
        : res.error,
      fix: res.ok ? undefined : 'Check the catalog URL and that every persona/role the definition requires is published.',
      required: true,
    }));
  } else {
    const withCreds = spec.accounts.filter((a) => a.credentialKeys.length);
    checks.push(check({
      id: 'accounts_static', label: 'QA accounts available',
      status: withCreds.length ? 'pass' : 'warn',
      detail: withCreds.length
        ? `${withCreds.length} static account(s) with stored credentials`
        : 'No account catalog and no stored credentials — authenticated scenarios cannot run.',
      fix: withCreds.length ? undefined : 'Add credentials to the definition, or point accountCatalog at a live persona endpoint.',
      required: needsBrowser || mode === 'api',
    }));
  }

  // ---- Browser integration
  if (needsBrowser) {
    const mcp = resolvePlaywrightMcp();
    checks.push(check({
      id: 'playwright_mcp', label: 'Playwright MCP available',
      status: mcp.entry ? 'pass' : 'fail',
      detail: mcp.entry ? `@playwright/mcp ${mcp.version} (local install, no network needed at run time)` : mcp.error,
      fix: mcp.entry ? undefined : 'Run: npm install --save-dev @playwright/mcp@latest',
      required: true,
    }));
    const chrome = await chromiumInstalled();
    checks.push(check({
      id: 'browser_binary', label: 'Chromium build installed',
      status: chrome.ok ? 'pass' : 'fail',
      detail: chrome.detail,
      fix: chrome.ok ? undefined : 'Run: node node_modules/playwright-core/cli.js install chromium',
      required: true,
    }));
  }

  const ok = checks.every((c) => !(c.required && c.status === 'fail'));
  return { ok, ranAt: new Date().toISOString(), checks };
}
