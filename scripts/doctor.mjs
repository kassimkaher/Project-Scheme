#!/usr/bin/env node
/**
 * Dependency check. Runs the same gates a QA run runs, so a machine that passes
 * here can actually execute a run — the point being that a dependency problem
 * should surface now, not as a mystery run failure later.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const checks = [];
const add = (name, ok, detail = '', fix = '', level = 'required') =>
  checks.push({ name, ok, detail, fix, level });

function cmd(name, bin, args, fix) {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  add(name, r.status === 0, (r.stdout || r.stderr || '').trim().split('\n')[0] || `exit ${r.status}`, fix);
}

// --- toolchain
const nodeMajor = Number(process.versions.node.split('.')[0]);
add('Node.js 20+', nodeMajor >= 20, process.version, 'Install Node.js 20 or newer.');
cmd('Claude Code CLI', process.env.CLAUDE_BIN || 'claude', ['--version'],
  `Install Claude Code, or set CLAUDE_BIN to its absolute path.`);

// --- encryption key
const key = process.env.QA_MASTER_KEY || '';
let keyOk = false, keyDetail = 'not set';
if (!key || key === 'change-me-before-use') {
  keyDetail = key ? 'still the placeholder value' : 'not set';
} else if (/^[a-f0-9]{64}$/i.test(key)) {
  keyOk = true; keyDetail = '32-byte hex';
} else {
  const b = Buffer.from(key, 'base64');
  keyOk = true;
  keyDetail = b.length === 32 ? '32-byte base64' : `${b.length}-byte value, hashed to 32 bytes (a real 32-byte key is better)`;
}
add('QA_MASTER_KEY configured', keyOk, keyDetail,
  'Run: openssl rand -base64 32   then put it in QA_MASTER_KEY in .env.local');

// --- session arguments must be able to grant tool permissions
const replace = process.env.CLAUDE_ARGS_REPLACE === '1';
const extra = (process.env.CLAUDE_ARGS || '').trim().split(/\s+/).filter(Boolean);
const armed = !replace || extra.includes('--permission-mode') || extra.includes('--dangerously-skip-permissions');
add('QA session can grant tool permissions', armed,
  replace ? `CLAUDE_ARGS_REPLACE=1, args are exactly: ${extra.join(' ') || '(empty)'}`
          : 'defaults enforce --permission-mode; CLAUDE_ARGS is merged, not substituted',
  'Unset CLAUDE_ARGS_REPLACE, or include --permission-mode bypassPermissions in CLAUDE_ARGS.');

// --- browser stack, resolved the same way the app resolves it
function findPlaywrightMcp() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, 'node_modules', '@playwright', 'mcp', 'package.json');
    if (fs.existsSync(p)) return p;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
const mcpPkg = findPlaywrightMcp();
add('Playwright MCP installed', Boolean(mcpPkg),
  mcpPkg ? `@playwright/mcp ${JSON.parse(fs.readFileSync(mcpPkg, 'utf8')).version}` : 'not found in node_modules',
  'Run: npm install --save-dev @playwright/mcp@latest');

const browsersRoot = process.env.PLAYWRIGHT_BROWSERS_PATH
  || (process.platform === 'darwin'
    ? path.join(process.env.HOME || '', 'Library/Caches/ms-playwright')
    : path.join(process.env.HOME || '', '.cache/ms-playwright'));
const chromium = (await fsp.readdir(browsersRoot).catch(() => [])).filter((e) => e.startsWith('chromium'));
add('Chromium build installed', chromium.length > 0,
  chromium.length ? chromium.join(', ') : `nothing under ${browsersRoot}`,
  'Run: npm run qa:browsers');

// --- data directory writable
const dataDir = path.resolve(process.cwd(), process.env.QA_DATA_DIR || '.qa-data');
let writable = false, writeDetail = dataDir;
try {
  await fsp.mkdir(dataDir, { recursive: true });
  const probe = path.join(dataDir, '.doctor-probe');
  await fsp.writeFile(probe, 'ok');
  await fsp.rm(probe);
  writable = true;
} catch (e) {
  writeDetail = e instanceof Error ? e.message : String(e);
}
add('Data directory writable', writable, writeDetail, 'Check filesystem permissions on QA_DATA_DIR.');

// --- npm cache health: a root-owned cache breaks any npx-based tooling
const npmCache = path.join(process.env.HOME || '', '.npm', '_cacache');
if (fs.existsSync(npmCache)) {
  const r = spawnSync('find', [npmCache, '-maxdepth', '4', '!', '-user', String(process.getuid?.() ?? 0), '-print', '-quit'],
    { encoding: 'utf8' });
  const foreign = (r.stdout || '').trim();
  // Advisory only: runs use the locally installed Playwright MCP and never shell
  // out to npx, so a broken cache degrades tooling without blocking a QA run.
  add('npm cache owned by the current user', !foreign,
    foreign ? `entries owned by another user, e.g. ${foreign}` : 'ok',
    'A root-owned npm cache (from a past "sudo npm") breaks npx and npm install. '
      + 'Runs do not need npx, so this will not block QA. Fix with: sudo chown -R $(id -u):$(id -g) ~/.npm',
    'advisory');
}

// --- report
const pad = Math.max(...checks.map((c) => c.name.length));
let failed = 0, warned = 0;
for (const c of checks) {
  const tag = c.ok ? 'PASS' : c.level === 'advisory' ? 'WARN' : 'FAIL';
  if (!c.ok) (c.level === 'advisory' ? warned++ : failed++);
  console.log(`${tag}  ${c.name.padEnd(pad)}  ${c.detail}`);
  if (!c.ok && c.fix) console.log(`      → ${c.fix}`);
}
console.log();
if (failed) {
  console.log(`${failed} required check(s) failed. Browser QA needs Playwright MCP and Chromium; every mode needs the CLI and the key.`);
  process.exit(1);
}
if (warned) console.log(`${warned} advisory warning(s) above — these do not block a QA run.`);
console.log('Required checks passed. Next: npm run dev, then open http://127.0.0.1:4100');
