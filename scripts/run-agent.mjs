#!/usr/bin/env node
/**
 * QA run supervisor.
 *
 * Spawned detached by the API, so this process is the leader of a new process
 * group. Claude Code, the Playwright MCP server and the browser all inherit that
 * group, which is what makes "Cancel" able to stop the whole tree rather than
 * orphaning children behind a dead parent.
 *
 * Everything that needs the project definition (config, OpenAPI, account
 * resolution, prompt building) already happened in the API route, which reused
 * the typed lib. This process deliberately owns only supervision: launching,
 * streaming, stage tracking, cancellation and structured failure reporting.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const runDir = process.argv[2];
if (!runDir) {
  console.error('usage: run-agent.mjs <runDir>');
  process.exit(2);
}

const RUN_JSON = path.join(runDir, 'run.json');
const PROMPT_FILE = path.join(runDir, 'prompt.txt');
const LOG_FILE = path.join(runDir, 'agent.log');
const STREAM_FILE = path.join(runDir, 'agent-stream.ndjson');
const PROGRESS_FILE = path.join(runDir, 'progress.ndjson');
const MCP_FILE = path.join(runDir, '.mcp.json');
const SECRETS_FILE = path.join(runDir, '.secret-literals.json');

const TAIL_CHARS = 4000;
const AGENT_STAGES = new Set([
  'reading_config', 'fetching_openapi', 'resolving_accounts',
  'generating_system_analysis', 'generating_use_cases', 'starting_browser',
  'api_testing', 'web_testing', 'collecting_evidence', 'generating_report',
]);

// ------------------------------------------------------------------ redaction
// Mirrors lib/redact.ts. Duplicated deliberately so this supervisor stays
// dependency-free and cannot fail to start because of a TS/module boundary.
let SECRET_LITERALS = [];
try {
  SECRET_LITERALS = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  fs.rmSync(SECRETS_FILE, { force: true });
} catch { /* no resolved secrets for this run */ }

const PATTERNS = [
  // Scheme-prefixed credentials FIRST: the generic Authorization rule consumes
  // only one token, so running it first would eat "Bearer"/"Basic" and leave the
  // credential itself — "Basic <base64>" decodes straight back to user:password.
  [/\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [redacted]'],
  [/\bbasic\s+[A-Za-z0-9+/]{8,}={0,2}/gi, 'Basic [redacted]'],
  [/\b(negotiate|digest|hoba|mutual|aws4-hmac-sha256)\s+\S{8,}/gi, '$1 [redacted]'],
  [/\b(authorization|proxy-authorization)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s"']+)/gi, '$1: [redacted]'],
  [/\b(set-cookie|cookie)\s*[:=]\s*[^\n]+/gi, '$1: [redacted]'],
  [/("|')?(password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|totp|otp|mfa[_-]?code)("|')?\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,}\]]+)/gi, '$2: "[redacted]"'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[redacted-jwt]'],
  [/\b[A-Fa-f0-9]{48,}\b/g, '[redacted-hex]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]'],
];

function redact(input) {
  if (!input) return '';
  let out = String(input);
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  for (const lit of SECRET_LITERALS) {
    if (!lit || String(lit).length < 4) continue;
    out = out.split(String(lit)).join('[redacted]');
  }
  return out;
}

function tailOf(buf) {
  const red = redact(buf);
  return red.length > TAIL_CHARS
    ? `…(truncated ${red.length - TAIL_CHARS} chars)\n${red.slice(-TAIL_CHARS)}`
    : red;
}


/**
 * Final secret sweep over everything the run produced.
 *
 * The prompt forbids writing credentials into artifacts, but the agent is a
 * model and cannot be trusted to obey without a backstop: one real run wrote its
 * own qa-accounts-live.json containing live persona passwords. Anything the
 * orchestrator writes is already redacted at the writer; this catches files the
 * *agent* created.
 *
 * Only files that actually contain a resolved secret are rewritten, so ordinary
 * artifacts are left byte-identical.
 */
const SWEEP_EXT = /\.(ndjson|log|json|md|txt|yml|yaml|html|csv)$/i;

function sweepSecrets(dir, depth = 0) {
  if (depth > 4 || !SECRET_LITERALS.length) return [];
  const fixed = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return fixed; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { fixed.push(...sweepSecrets(full, depth + 1)); continue; }
    if (!SWEEP_EXT.test(e.name)) continue;
    try {
      if (fs.statSync(full).size > 80 * 1024 * 1024) continue;
      const before = fs.readFileSync(full, 'utf8');
      if (!SECRET_LITERALS.some((v) => v && String(v).length >= 4 && before.includes(String(v)))) continue;
      fs.writeFileSync(full, redact(before));
      fixed.push(path.relative(runDir, full));
    } catch { /* unreadable or binary; skip */ }
  }
  return fixed;
}

// -------------------------------------------------------------- run.json I/O

async function readRun() {
  return JSON.parse(await fsp.readFile(RUN_JSON, 'utf8'));
}

/** Atomic so the polling UI never reads a half-written record. */
async function patchRun(patch) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const current = await readRun();
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      const tmp = `${RUN_JSON}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(next, null, 2));
      await fsp.rename(tmp, RUN_JSON);
      return next;
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 120));
    }
  }
}

const nowIso = () => new Date().toISOString();

async function appendProgress(entry) {
  await fsp.appendFile(PROGRESS_FILE, `${JSON.stringify({ time: nowIso(), ...entry })}\n`).catch(() => {});
}

// ------------------------------------------------------------------ launching

const bin = process.env.CLAUDE_BIN || 'claude';
const configured = (process.env.CLAUDE_ARGS || '').trim();

/**
 * Defaults chosen for a non-interactive QA session:
 *  --output-format stream-json --verbose  → live events, and a final structured
 *                                            result we can surface as the error
 *  --mcp-config ./.mcp.json               → this run's own browser only
 *  --strict-mcp-config                    → ignore the operator's global MCP
 *                                            servers, so a broken global entry
 *                                            cannot poison a run
 *  --permission-mode bypassPermissions    → nothing can prompt; a prompt in -p
 *                                            mode is an invisible hang
 */
const DEFAULT_ARGS = [
  '-p',
  '--output-format', 'stream-json',
  '--verbose',
  '--mcp-config', './.mcp.json',
  '--strict-mcp-config',
  '--permission-mode', 'bypassPermissions',
];

/**
 * CLAUDE_ARGS is MERGED into the defaults, not substituted for them.
 *
 * This matters: an earlier version of this project shipped `CLAUDE_ARGS=-p` in
 * .env.example, which replaced the whole argument list. That silently dropped the
 * permission mode, so in non-interactive mode every tool prompt was auto-denied
 * and runs failed with "This command requires approval" and no report. Merging
 * means a partial override can no longer disarm the run.
 *
 * Set CLAUDE_ARGS_REPLACE=1 to opt into full replacement.
 */
function mergeArgs(defaults, extraRaw) {
  const extra = extraRaw ? extraRaw.split(/\s+/).filter(Boolean) : [];
  if (!extra.length) return [...defaults];
  if (process.env.CLAUDE_ARGS_REPLACE === '1') return extra;

  const out = [...defaults];
  const VALUED = new Set(['--output-format', '--permission-mode', '--model', '--mcp-config', '--input-format', '--agent']);
  for (let i = 0; i < extra.length; i++) {
    const tok = extra[i];
    if (!tok.startsWith('-')) { if (!out.includes(tok)) out.push(tok); continue; }
    const takesValue = VALUED.has(tok) && extra[i + 1] && !extra[i + 1].startsWith('-');
    const at = out.indexOf(tok);
    if (at >= 0) {
      // An explicit override of a default wins for its own value.
      if (takesValue) { out[at + 1] = extra[i + 1]; i++; }
    } else {
      out.push(tok);
      if (takesValue) { out.push(extra[i + 1]); i++; }
    }
  }
  return out;
}

const args = mergeArgs(DEFAULT_ARGS, configured);
if (process.env.CLAUDE_MODEL && !args.includes('--model')) args.push('--model', process.env.CLAUDE_MODEL);

// A run without a permission mode cannot answer a prompt and will hang or be denied.
if (!args.includes('--permission-mode') && !args.includes('--dangerously-skip-permissions')) {
  args.push('--permission-mode', 'bypassPermissions');
}

const streamingJson = args.includes('stream-json');

let prompt = '';
try {
  prompt = await fsp.readFile(PROMPT_FILE, 'utf8');
  // The prompt carries QA credentials; it exists on disk for as short a time as possible.
  await fsp.unlink(PROMPT_FILE).catch(() => {});
} catch (e) {
  await patchRun({
    status: 'failed', stage: 'failed', finishedAt: nowIso(),
    failure: {
      stage: 'preparing',
      message: 'The run prompt was missing, so the QA session was never started.',
      detail: redact(String(e)),
      occurredAt: nowIso(),
      retryable: true,
      observed: { claudeStarted: false },
    },
  });
  process.exit(1);
}

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const streamLog = fs.createWriteStream(STREAM_FILE, { flags: 'a' });

/*
 * Both writers redact internally, on purpose.
 *
 * An earlier version redacted at the call sites and wrote the Claude Code event
 * stream through verbatim. A web run then logged 26 lines containing real
 * persona passwords — the agent had filled a login form, and the tool_use input
 * was echoed in the stream. That file is downloadable via
 * /api/runs/[id]/artifact/agent-stream.ndjson, so the leak was reachable.
 *
 * Redacting in the writer means a forgotten call site cannot leak. The event
 * stream is therefore redacted, not verbatim; that is the correct trade for a
 * file the app serves.
 */
const logLine = (s) => logStream.write(`${redact(String(s))}\n`);
const streamLine = (s) => streamLog.write(`${redact(String(s))}\n`);

// ------------------------------------------------------------- observed state

const observed = {
  claudeStarted: false,
  browserStarted: false,
  openapiFetched: undefined,
  accountsResolved: undefined,
  outputWritable: true,
};
try {
  const pre = (await readRun()).preflight;
  if (pre) {
    const byId = Object.fromEntries(pre.checks.map((c) => [c.id, c.status]));
    observed.openapiFetched = byId.openapi_reachable ? byId.openapi_reachable === 'pass' : undefined;
    observed.accountsResolved = byId.account_catalog
      ? byId.account_catalog === 'pass'
      : byId.accounts_static ? byId.accounts_static === 'pass' : undefined;
  }
} catch { /* preflight is optional */ }

let mcpServersReported = null;
let sessionId = null;
let resolvedModel = null;
let lastAgentStage = null;
let lastToolName = null;
let claudeErrorMessage = null;   // from the final result event
let claudeErrorSubtype = null;
let cancelled = false;

let stdoutBuf = '';
let stderrBuf = '';
const keepTail = (buf, chunk) => (buf + chunk).slice(-(TAIL_CHARS * 3));

// ------------------------------------------------------- stream-json handling

function renderContentBlocks(blocks) {
  const out = [];
  for (const b of blocks || []) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && b.text) out.push(redact(b.text));
    else if (b.type === 'tool_use') {
      lastToolName = b.name || null;
      const target = b.input && (b.input.url || b.input.file_path || b.input.command || b.input.pattern);
      out.push(`[tool] ${b.name}${target ? ` → ${redact(String(target)).slice(0, 200)}` : ''}`);
      if (/playwright|browser|mcp__playwright/i.test(String(b.name))) observed.browserStarted = true;
    } else if (b.type === 'tool_result') {
      const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
      out.push(`[tool-result] ${redact(String(c)).slice(0, 600)}`);
    }
  }
  return out;
}

async function handleEvent(evt) {
  switch (evt.type) {
    case 'system':
      if (evt.subtype === 'init') {
        observed.claudeStarted = true;
        sessionId = evt.session_id || null;
        resolvedModel = evt.model || null;
        mcpServersReported = Array.isArray(evt.mcp_servers) ? evt.mcp_servers : [];
        const names = mcpServersReported.map((m) => `${m.name}:${m.status || 'unknown'}`).join(', ') || 'none';
        logLine(`[session] model=${resolvedModel} id=${sessionId} mcp=${names}`);
        const browserOk = mcpServersReported.some(
          (m) => /playwright|browser/i.test(String(m.name)) && String(m.status || '').toLowerCase() === 'connected',
        );
        if (browserOk) observed.browserStarted = true;
        await patchRun({
          stage: 'starting_claude',
          stageDetail: `Claude Code session started (model ${resolvedModel || 'default'}); MCP: ${names}`,
          launch: { ...(await readRun()).launch, model: resolvedModel, sessionId },
        });
      }
      break;

    case 'assistant': {
      const lines = renderContentBlocks(evt.message?.content);
      for (const l of lines) logLine(l);
      break;
    }

    case 'user': {
      const lines = renderContentBlocks(evt.message?.content);
      for (const l of lines) logLine(l);
      break;
    }

    case 'result':
      claudeErrorSubtype = evt.subtype || null;
      if (evt.is_error || (evt.subtype && evt.subtype !== 'success')) {
        claudeErrorMessage = redact(String(evt.result || evt.error || evt.subtype || 'Claude Code reported an error'));
      }
      logLine(`[result] subtype=${evt.subtype} is_error=${evt.is_error} turns=${evt.num_turns ?? '?'} duration=${evt.duration_ms ?? '?'}ms`);
      if (evt.result) logLine(`[result-text] ${redact(String(evt.result)).slice(0, 2000)}`);
      break;

    case 'rate_limit_event':
      // Informational; recorded in the raw stream only.
      break;

    default:
      break;
  }
}

let pending = '';
async function consumeStdout(chunk) {
  stdoutBuf = keepTail(stdoutBuf, chunk);
  if (!streamingJson) { logStream.write(redact(chunk)); return; }
  pending += chunk;
  const lines = pending.split('\n');
  pending = lines.pop() || '';
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    streamLine(t);
    let evt;
    try { evt = JSON.parse(t); } catch { logStream.write(`${redact(t)}\n`); continue; }
    try { await handleEvent(evt); } catch (e) { logLine(`[supervisor] event handling error: ${redact(String(e))}`); }
  }
}

// --------------------------------------------------------- agent stage poller

let stageTimer = null;
let progressOffset = 0;

async function pollAgentStages() {
  try {
    const stat = await fsp.stat(PROGRESS_FILE).catch(() => null);
    if (!stat || stat.size <= progressOffset) return;
    const fh = await fsp.open(PROGRESS_FILE, 'r');
    const len = stat.size - progressOffset;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, progressOffset);
    await fh.close();
    progressOffset = stat.size;
    const lines = buf.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.stage && AGENT_STAGES.has(e.stage)) {
        lastAgentStage = e.stage;
        const patch = { stage: e.stage, stageDetail: e.summary ? redact(String(e.summary)).slice(0, 300) : undefined };
        if (e.useCaseId) patch.activeUseCase = String(e.useCaseId);
        if (e.stage === 'starting_browser' || e.stage === 'web_testing') observed.browserStarted = true;
        await patchRun(patch);
      }
    }
  } catch { /* the agent may not have created the file yet */ }
}

// ------------------------------------------------------------------- classify

/** Maps whatever went wrong to the stage it went wrong in, plus a readable reason. */
function classifyFailure({ code, signal }) {
  const hay = `${stdoutBuf}\n${stderrBuf}\n${claudeErrorMessage || ''}`;
  const has = (re) => re.test(hay);

  if (!observed.claudeStarted) {
    if (has(/ENOENT|command not found|not recognized/i)) {
      return {
        stage: 'starting_claude',
        message: `Claude Code could not be launched — "${bin}" was not found on PATH.`,
        detail: 'Install Claude Code, or set CLAUDE_BIN in .env.local to its absolute path.',
      };
    }
    if (has(/not logged in|unauthor|authentication|invalid api key|credit balance|login/i)) {
      return {
        stage: 'starting_claude',
        message: 'Claude Code started but could not authenticate its session.',
        detail: 'Run "claude" once interactively to complete login, then retry this run.',
      };
    }
    return {
      stage: 'starting_claude',
      message: 'Claude Code exited before the QA session initialised.',
      detail: claudeErrorMessage || 'No session init event was received from the CLI.',
    };
  }

  const browserExpected = /web|full/.test(String(runRecordMode));
  const browserConnected = (mcpServersReported || []).some(
    (m) => /playwright|browser/i.test(String(m.name)) && String(m.status || '').toLowerCase() === 'connected',
  );
  if (browserExpected && mcpServersReported && !browserConnected) {
    const named = (mcpServersReported || []).map((m) => `${m.name}=${m.status}`).join(', ') || 'no servers reported';
    return {
      stage: 'starting_browser',
      message: 'The Playwright MCP browser never connected, so browser QA could not run.',
      detail: `Claude Code reported MCP servers: ${named}. Check that @playwright/mcp is installed locally and that a Chromium build is present.`,
    };
  }

  if (claudeErrorMessage) {
    return {
      // Claude's own error takes priority; attribute it to whatever stage was live.
      stage: lastAgentStage || 'starting_claude',
      message: `Claude Code reported an error${claudeErrorSubtype ? ` (${claudeErrorSubtype})` : ''}.`,
      detail: claudeErrorMessage.slice(0, 1200),
    };
  }

  if (signal) {
    return {
      stage: lastAgentStage || 'starting_claude',
      message: `The QA session was terminated by signal ${signal}.`,
      detail: 'This usually means the process was stopped externally or ran out of memory.',
    };
  }

  if (code === 0) {
    return {
      stage: 'generating_report',
      message: 'The QA session finished successfully but produced no report.md.',
      detail: `Last stage reported by the agent: ${lastAgentStage || 'none'}. The agent may have stopped before the report step, or written it elsewhere.`,
    };
  }

  return {
    stage: lastAgentStage || 'starting_claude',
    message: `The QA session exited with code ${code}.`,
    detail: claudeErrorMessage || `Last stage reported by the agent: ${lastAgentStage || 'none'}. Last tool used: ${lastToolName || 'none'}.`,
  };
}

// ------------------------------------------------------------------- lifecycle

let runRecordMode = 'analyze';
let child = null;
let finished = false;

async function finish(patch) {
  if (finished) return;
  finished = true;
  if (stageTimer) clearInterval(stageTimer);
  await pollAgentStages().catch(() => {});
  try {
    const scrubbed = sweepSecrets(runDir);
    if (scrubbed.length) {
      logLine(`[supervisor] secret sweep rewrote ${scrubbed.length} agent-written file(s): ${scrubbed.join(', ')}`);
    }
  } catch (e) {
    logLine(`[supervisor] secret sweep failed: ${redact(String(e))}`);
  }
  await patchRun(patch).catch(() => {});
  await new Promise((r) => { logStream.end(r); });
  await new Promise((r) => { streamLog.end(r); });
}

// SIGTERM is how the Cancel endpoint stops this group. Children get the same
// signal from the group kill; we just record the outcome and preserve artifacts.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (cancelled || finished) return;
    cancelled = true;
    logLine(`[supervisor] ${sig} received — cancelling run, preserving artifacts.`);
    await appendProgress({ stage: 'cancelled', status: 'info', summary: `Cancelled via ${sig}` });
    try { if (child?.pid) process.kill(child.pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { if (child?.pid) process.kill(child.pid, 'SIGKILL'); } catch {} }, 3000);
    const reportExists = fs.existsSync(path.join(runDir, 'report.md'));
    await finish({
      status: 'cancelled', stage: 'cancelled', finishedAt: nowIso(),
      signal: sig, reportExists,
      stageDetail: 'Cancelled by the operator. Logs and evidence produced so far are preserved.',
    });
    process.exit(0);
  });
}

try {
  const record = await readRun();
  runRecordMode = record.mode || 'analyze';

  await patchRun({
    status: 'running',
    stage: 'starting_claude',
    stageDetail: 'Launching the Claude Code QA session…',
    startedAt: nowIso(),
    pid: process.pid,
    pgid: process.pid, // spawned detached: this process leads its own group
    launch: {
      bin,
      args,                     // no secrets: credentials only ever live in prompt.txt
      cwd: runDir,
      model: process.env.CLAUDE_MODEL || undefined,
      startedAt: nowIso(),
    },
  });

  logLine(`[supervisor] ${nowIso()} pid=${process.pid} pgid=${process.pid}`);
  logLine(`[supervisor] cwd=${runDir}`);
  logLine(`[supervisor] launching: ${bin} ${args.join(' ')}`);
  logLine(`[supervisor] mcp config: ${fs.existsSync(MCP_FILE) ? MCP_FILE : 'MISSING'}`);
  await appendProgress({ stage: 'starting_claude', status: 'start', summary: 'Launching Claude Code QA session' });

  child = spawn(bin, args, {
    cwd: runDir,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    // Not detached: the child stays in this process group so cancelling the
    // group stops Claude, the MCP server and the browser together.
  });

  child.on('error', async (err) => {
    stderrBuf = keepTail(stderrBuf, `\n${String(err)}`);
    logLine(`[supervisor] spawn error: ${redact(String(err))}`);
    const c = classifyFailure({ code: null, signal: null });
    await finish({
      status: 'failed', stage: 'failed', finishedAt: nowIso(), exitCode: null,
      failure: {
        ...c, occurredAt: nowIso(), retryable: true, exitCode: null, signal: null,
        stdoutTail: tailOf(stdoutBuf), stderrTail: tailOf(stderrBuf), observed,
      },
    });
    process.exit(1);
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { consumeStdout(c).catch(() => {}); });
  child.stderr.on('data', (c) => {
    stderrBuf = keepTail(stderrBuf, c);
    logStream.write(redact(c));
  });

  child.stdin.on('error', () => { /* the CLI may close stdin early */ });
  child.stdin.write(prompt);
  child.stdin.end();
  prompt = '';

  stageTimer = setInterval(() => { pollAgentStages().catch(() => {}); }, 1500);

  child.on('close', async (code, signal) => {
    if (cancelled || finished) return;
    if (pending.trim()) await consumeStdout('\n').catch(() => {});
    logLine(`[supervisor] child exited code=${code} signal=${signal || 'none'}`);

    const reportExists = fs.existsSync(path.join(runDir, 'report.md'));
    const analyzeOnly = runRecordMode === 'analyze';
    const artifactsOk = analyzeOnly
      ? fs.existsSync(path.join(runDir, 'use-cases.json'))
      : reportExists;
    const ok = code === 0 && !claudeErrorMessage && artifactsOk;

    let evidenceCount = 0;
    try { evidenceCount = (await fsp.readdir(path.join(runDir, 'evidence'))).length; } catch {}

    if (ok) {
      await appendProgress({ stage: 'completed', status: 'pass', summary: 'QA run completed' });
      await finish({
        status: 'completed', stage: 'completed', finishedAt: nowIso(),
        exitCode: code, signal: signal || null, reportExists,
        stageDetail: analyzeOnly ? 'Analysis and use cases generated.' : 'Report generated.',
        counts: { evidence: evidenceCount },
      });
      process.exit(0);
    }

    const c = classifyFailure({ code, signal });
    // analyze mode has no report; say so accurately instead of blaming the report step
    if (analyzeOnly && code === 0 && !claudeErrorMessage && !artifactsOk) {
      c.stage = 'generating_use_cases';
      c.message = 'The analysis session finished but produced no use-cases.json.';
      c.detail = `Last stage reported by the agent: ${lastAgentStage || 'none'}.`;
    }
    await appendProgress({ stage: 'failed', status: 'fail', summary: c.message });
    await finish({
      status: 'failed', stage: 'failed', finishedAt: nowIso(),
      exitCode: code, signal: signal || null, reportExists,
      counts: { evidence: evidenceCount },
      failure: {
        ...c,
        occurredAt: nowIso(),
        retryable: true,
        exitCode: code,
        signal: signal || null,
        stdoutTail: tailOf(stdoutBuf),
        stderrTail: tailOf(stderrBuf),
        observed,
      },
    });
    process.exit(code === 0 ? 1 : code || 1);
  });
} catch (e) {
  logLine(`[supervisor] fatal: ${redact(String(e))}`);
  await finish({
    status: 'failed', stage: 'failed', finishedAt: nowIso(),
    failure: {
      stage: 'preparing',
      message: 'The run supervisor failed before the QA session started.',
      detail: redact(String(e && e.stack ? e.stack : e)).slice(0, 1200),
      occurredAt: nowIso(), retryable: true,
      stderrTail: tailOf(stderrBuf), observed,
    },
  });
  process.exit(1);
}
