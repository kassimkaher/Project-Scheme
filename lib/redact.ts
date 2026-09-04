/**
 * Secret scrubbing for anything that can reach a log file, a run record or the UI.
 * Applied to process output tails, error messages and sanitized launch arguments.
 */

const SECRET_ENV_HINT = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|TOTP|OTP)/i;

type Replacement = string | ((match: string, ...groups: string[]) => string);

const PATTERNS: Array<[RegExp, Replacement]> = [
  // Scheme-prefixed credentials FIRST. The generic Authorization rule below
  // consumes only one token, so if it ran first it would eat the word "Bearer"
  // or "Basic" and leave the actual credential behind — "Basic <base64>" decodes
  // straight back to user:password.
  [/\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [redacted]'],
  [/\bbasic\s+[A-Za-z0-9+/]{8,}={0,2}/gi, 'Basic [redacted]'],
  [/\b(negotiate|digest|hoba|mutual|aws4-hmac-sha256)\s+\S{8,}/gi, '$1 [redacted]'],
  // Any remaining Authorization value, quoted or a bare token.
  [/\b(authorization|proxy-authorization)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s"']+)/gi, '$1: [redacted]'],
  // Cookie / set-cookie
  [/\b(set-cookie|cookie)\s*[:=]\s*[^\n]+/gi, '$1: [redacted]'],
  // JSON or YAML key/value pairs for sensitive names
  [/("|')?(password|passwd|pass|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|totp|otp|mfa[_-]?code)("|')?\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,}\]]+)/gi,
    (_match: string, q1 = '', k = '', q2 = '') => `${q1}${k}${q2}: "[redacted]"`],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[redacted-jwt]'],
  // Long opaque hex/base64 blobs that look like keys
  [/\b[A-Fa-f0-9]{48,}\b/g, '[redacted-hex]'],
  // Private key blocks
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]'],
];

/** Extra literal values to scrub, e.g. the actual passwords resolved for this run. */
export function redact(input: string, extraLiterals: string[] = []): string {
  if (!input) return '';
  let out = String(input);
  for (const [re, rep] of PATTERNS) {
    out = typeof rep === 'string' ? out.replace(re, rep) : out.replace(re, rep);
  }
  for (const lit of extraLiterals) {
    const v = String(lit || '');
    // Only scrub values long enough to be meaningful; short ones cause false positives.
    if (v.length < 4) continue;
    out = out.split(v).join('[redacted]');
  }
  return out;
}

/** Keeps the last N characters of a stream, redacted. Used for bounded stdout/stderr tails. */
export function tail(input: string, max = 4000, extraLiterals: string[] = []): string {
  const red = redact(input, extraLiterals);
  return red.length > max ? `…(truncated ${red.length - max} chars)\n${red.slice(-max)}` : red;
}

/** Environment variables safe to record alongside a launch. Values are never included. */
export function sanitizedEnvKeys(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((k) => SECRET_ENV_HINT.test(k)).sort();
}

/** Arguments with anything secret-looking replaced. */
export function sanitizeArgs(args: string[]): string[] {
  return args.map((a) => redact(a));
}

export function isSecretEnvName(name: string): boolean {
  return SECRET_ENV_HINT.test(name);
}
