#!/usr/bin/env node
/**
 * Redaction test.
 *
 * Loads the redaction patterns straight out of scripts/run-agent.mjs so the test
 * can never pass against a copy that has drifted from what actually ships.
 *
 * The base64 decode check exists because pattern ORDER was wrong once: a generic
 * "Authorization: <token>" rule ran before the Basic rule, ate the word "Basic",
 * and left the credential behind. Literal-matching missed it; decoding caught it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'run-agent.mjs'), 'utf8');
const patternSrc = src.slice(src.indexOf('const PATTERNS = ['), src.indexOf('function tailOf('));

let SECRET_LITERALS = ['QAtest!Admin1', '613987', 'SelfTestSecret-A1'];
const { PATTERNS, redact } = new Function(
  'SECRET_LITERALS',
  `${patternSrc}\nreturn { PATTERNS, redact };`,
)(SECRET_LITERALS);

const cases = [
  ['bearer jwt',        'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk'],
  ['basic in curl',     'curl -H "Authorization: Basic YWRtaW46c3VwZXJzZWNyZXQ=" https://api.example.com/x'],
  ['basic bare',        'Authorization: Basic YWRtaW46c3VwZXJzZWNyZXQ='],
  ['opaque auth',       'authorization: 8f4c2b91aa7d4e0f'],
  ['proxy auth',        'Proxy-Authorization: Basic dXNlcjpwYXNzd29yZDEyMw=='],
  ['negotiate',         'Authorization: Negotiate YIIZpQYGKwYBBQUCoIIZ'],
  ['set-cookie',        'set-cookie: session=9f8a7b6c5d4e3f2a1b0c; HttpOnly'],
  ['json password',     '{"identifier":"a@b.c","password":"QAtest!Admin1"}'],
  ['yaml totp',         'credentials:\n  totp: 613987'],
  ['literal password',  'auth failed using QAtest!Admin1'],
  ['pem',               '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKC\n-----END RSA PRIVATE KEY-----'],
];

// Anything that base64-decodes to something with a colon and printable text is
// treated as a surviving credential, which is how the Basic leak was found.
function looksLikeCredential(out) {
  for (const m of out.matchAll(/[A-Za-z0-9+/]{12,}={0,2}/g)) {
    try {
      const d = Buffer.from(m[0], 'base64').toString('utf8');
      if (/^[\x20-\x7e]+$/.test(d) && d.includes(':')) return d;
    } catch {}
  }
  return null;
}

let bad = 0;
for (const [name, input] of cases) {
  const out = redact(input);
  const problems = [];
  const leaked = SECRET_LITERALS.filter((s) => out.includes(s));
  if (leaked.length) problems.push(`literal ${leaked.join(',')}`);
  const decoded = looksLikeCredential(out);
  if (decoded) problems.push(`base64 decodes to "${decoded}"`);
  if (/eyJ[A-Za-z0-9_-]{5,}\./.test(out)) problems.push('jwt body');
  if (/session=9f8a/.test(out)) problems.push('cookie value');
  if (problems.length) bad++;
  console.log(`${problems.length ? '  LEAK' : '  OK  '} ${name.padEnd(18)} ${out.replace(/\n/g,' | ').slice(0,84)}`);
  if (problems.length) console.log(`        ↳ ${problems.join('; ')}`);
}
const kept = redact('logged in as teacher-independent-a (teacher@qa.example)');
const keptOk = kept.includes('teacher@qa.example');
if (!keptOk) bad++;
console.log(`${keptOk ? '  OK  ' : '  BAD '} identifier kept   ${kept.slice(0,84)}`);

// ---------------------------------------------------------------------------
// Static guard on the write paths.
//
// The pattern tests above all passed while the supervisor was still writing the
// Claude Code event stream verbatim — a real web run leaked 26 lines of persona
// passwords into a file the app serves. Patterns being correct is not enough if
// a write path skips them, so assert that every log write is redacted.
// ---------------------------------------------------------------------------
console.log('\n── write-path guard');
const writeCalls = [...src.matchAll(/(logStream|streamLog)\.write\(([^;]*?)\);/g)];
let unguarded = 0;
for (const [full, target, arg] of writeCalls) {
  const guarded = /redact\(/.test(arg);
  if (!guarded) unguarded++;
  console.log(`  ${guarded ? 'OK  ' : 'BARE'} ${target}.write(${arg.trim().slice(0, 62)})`);
}
console.log(`  ${writeCalls.length} write call(s), ${unguarded} without redact()`);
if (unguarded) bad += unguarded;

// The end-of-run sweep must exist and run on every terminal path.
const hasSweep = /function sweepSecrets\(/.test(src);
const sweepWired = /sweepSecrets\(runDir\)/.test(src.slice(src.indexOf('async function finish(')));
console.log(`  ${hasSweep ? 'OK  ' : 'MISSING'} sweepSecrets() defined`);
console.log(`  ${sweepWired ? 'OK  ' : 'MISSING'} sweep wired into finish()`);
if (!hasSweep || !sweepWired) bad++;

console.log(bad ? `\n${bad} problem(s)` : '\nno leaks');
process.exit(bad ? 1 : 0);

