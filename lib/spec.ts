import crypto from 'node:crypto';
import YAML from 'yaml';
import { projectSpecSchema } from './schema';
import type { QaAccount, QaAccountRef, QaProjectSpec, QaProjectSpecSafe } from '@/types/qa';

export const MASK = '••••••••';

export function parseProjectSpec(raw: string): QaProjectSpec {
  let value: unknown;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      value = JSON.parse(trimmed);
    } catch (e) {
      throw new Error(`Definition looks like JSON but failed to parse: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    const match = raw.match(/```qa-config\s*\n([\s\S]*?)```/i);
    if (!match) {
      throw new Error('No ```qa-config fenced block found. Paste a QA definition, or download the example to see the expected structure.');
    }
    try {
      value = YAML.parse(match[1]);
    } catch (e) {
      throw new Error(`The qa-config block is not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const parsed = projectSpecSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`QA definition is invalid — ${first}`);
  }
  return parsed.data as QaProjectSpec;
}

/** Credential field names only, never values. */
function credentialKeys(a: QaAccount): string[] {
  return Object.keys(a.credentials || {}).sort();
}

export function toAccountRef(a: QaAccount, source: 'static' | 'catalog' = 'static'): QaAccountRef {
  return {
    id: a.id,
    role: a.role,
    label: a.label,
    loginType: a.loginType,
    credentialKeys: credentialKeys(a),
    notes: a.notes,
    source,
  };
}

/**
 * Splits an imported definition into the part that is safe to store in plaintext
 * (project.json) and the secret material (secrets.enc).
 */
export function splitSecrets(spec: QaProjectSpec): {
  safe: QaProjectSpecSafe;
  secrets: { accounts: Record<string, Record<string, string>> };
} {
  const secrets: Record<string, Record<string, string>> = {};
  for (const a of spec.accounts) {
    if (a.credentials && Object.keys(a.credentials).length) secrets[a.id] = { ...a.credentials };
  }
  const safe: QaProjectSpecSafe = {
    ...spec,
    accounts: spec.accounts.map((a) => toAccountRef(a, 'static')),
  };
  return { safe, secrets: { accounts: secrets } };
}

/** Rehydrates a full spec from the safe record + decrypted secrets. Used only by the runner. */
export function mergeSecrets(
  safe: QaProjectSpecSafe,
  secrets: { accounts: Record<string, Record<string, string>> },
): QaProjectSpec {
  return {
    ...safe,
    accounts: safe.accounts
      .filter((a) => a.source !== 'catalog')
      .map((a) => ({
        id: a.id,
        role: a.role,
        label: a.label,
        loginType: a.loginType,
        notes: a.notes,
        credentials: secrets.accounts?.[a.id] || {},
      })),
  };
}

/** Masks credential values for display. Kept for JSON definitions echoed back to the UI. */
export function maskSpec(spec: QaProjectSpec): QaProjectSpec {
  return {
    ...spec,
    accounts: spec.accounts.map((a) => ({
      ...a,
      credentials: Object.fromEntries(Object.keys(a.credentials || {}).map((k) => [k, MASK])),
    })),
  };
}

function norm(s: string | undefined): string {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * A stable identity for a project so a re-import updates rather than duplicates.
 * Prefers an author-declared projectId; otherwise derives from the normalized system
 * name plus the environment source URLs, which together are specific enough in practice.
 */
export function fingerprintSpec(spec: QaProjectSpec): string {
  if (spec.projectId) return `declared:${spec.projectId}`;
  const sources = spec.environments
    .flatMap((e) => [e.apiBaseUrl, e.openapiUrl, ...e.webApps.map((w) => w.url)])
    .filter(Boolean)
    .map((u) => norm(u))
    .sort();
  const basis = JSON.stringify([norm(spec.system.name), sources]);
  return `derived:${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 32)}`;
}

export function specStats(safe: QaProjectSpecSafe) {
  return {
    environments: safe.environments.length,
    accounts: safe.accounts.length,
    webApps: safe.environments.reduce((n, e) => n + e.webApps.length, 0),
    hasAccountCatalog: Boolean(safe.accountCatalog || safe.environments.some((e) => e.accountCatalog)),
  };
}

export function resolveCatalog(safe: QaProjectSpecSafe, envId: string) {
  const env = safe.environments.find((e) => e.id === envId);
  return env?.accountCatalog || safe.accountCatalog || null;
}
