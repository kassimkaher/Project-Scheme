import type { QaAccount, QaAccountCatalog, QaLoginType } from '@/types/qa';

/**
 * Resolves QA accounts from a live catalog endpoint.
 *
 * The catalog is owned by the tested system, so its exact field names vary. This
 * resolver only understands *generic* key names — no project-specific persona ids
 * or roles are encoded here. A project that needs particular personas declares
 * them in its own definition via requiredPersonas / requiredRoles.
 */

const LIST_KEYS = ['personas', 'accounts', 'users', 'items', 'data', 'results', 'records'];
const ID_KEYS = ['persona_id', 'personaId', 'id', 'account_id', 'accountId', 'key', 'name', 'slug'];
const ROLE_KEYS = ['role', 'persona', 'type', 'kind', 'user_type', 'userType', 'group'];
const IDENTIFIER_KEYS = ['identifier', 'email', 'username', 'user', 'login', 'phone', 'msisdn', 'mobile'];
const PASSWORD_KEYS = ['password', 'passwd', 'pass', 'secret'];
const OTP_KEYS = ['totp', 'otp', 'mfa_code', 'mfaCode', 'totp_secret', 'totpSecret', 'two_factor', 'code'];
const LABEL_KEYS = ['label', 'title', 'display_name', 'displayName', 'description'];
const TENANT_KEYS = ['login_tenant_slug', 'tenant', 'tenant_slug', 'tenantSlug', 'workspace', 'institute', 'org', 'organization'];
const MFA_FLAG_KEYS = ['mfa_required', 'mfaRequired', 'requires_mfa', 'two_factor_required'];
const NOTE_KEYS = ['notes', 'note', 'seeded_scenario', 'expected_permissions', 'expected_denials', 'expected_landing', 'workspace_context'];

function pick(obj: Record<string, any>, keys: string[]): any {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

function str(v: any): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/** Finds the array of account-like entries in an arbitrarily shaped payload. */
function extractEntries(payload: any): Array<Record<string, any>> {
  if (Array.isArray(payload)) return payload.filter((x) => x && typeof x === 'object');
  if (!payload || typeof payload !== 'object') return [];
  for (const k of LIST_KEYS) {
    if (Array.isArray(payload[k])) return payload[k].filter((x: any) => x && typeof x === 'object');
  }
  // A role -> account map, e.g. { "admin": {...}, "teacher": {...} }
  const values = Object.values(payload).filter((v) => v && typeof v === 'object' && !Array.isArray(v));
  if (values.length && values.every((v: any) => IDENTIFIER_KEYS.some((k) => v[k] !== undefined))) {
    return Object.entries(payload).map(([role, v]) => ({ role, ...(v as object) }));
  }
  // A nested single array anywhere one level down.
  for (const v of Object.values(payload)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v.filter((x: any) => x && typeof x === 'object');
  }
  return [];
}

function inferLoginType(identifier: string | undefined, entry: Record<string, any>): QaLoginType {
  const explicit = str(pick(entry, ['loginType', 'login_type', 'auth_type', 'authType']));
  if (explicit && ['email_password', 'phone_password', 'username_password', 'custom'].includes(explicit)) {
    return explicit as QaLoginType;
  }
  if (!identifier) return 'custom';
  if (identifier.includes('@')) return 'email_password';
  if (/^\+?\d[\d\s-]{5,}$/.test(identifier)) return 'phone_password';
  return 'username_password';
}

export type CatalogAccount = QaAccount & {
  tenant?: string;
  mfaRequired?: boolean;
  /** Everything non-secret we could learn, for the agent's benefit. */
  meta?: Record<string, string>;
};

export function normalizeCatalog(payload: any): CatalogAccount[] {
  return extractEntries(payload).map((entry, i) => {
    const id = str(pick(entry, ID_KEYS)) || `catalog-${i + 1}`;
    const role = str(pick(entry, ROLE_KEYS)) || 'unknown';
    const identifier = str(pick(entry, IDENTIFIER_KEYS));
    const password = str(pick(entry, PASSWORD_KEYS));
    const otp = str(pick(entry, OTP_KEYS));
    const credentials: Record<string, string> = {};
    if (identifier) credentials.identifier = identifier;
    if (password) credentials.password = password;
    if (otp) credentials.totp = otp;

    const meta: Record<string, string> = {};
    for (const k of NOTE_KEYS) {
      const v = str(entry[k]);
      if (v) meta[k] = v;
    }
    const tenant = str(pick(entry, TENANT_KEYS));
    if (tenant) meta.tenant = tenant;

    const mfaRaw = pick(entry, MFA_FLAG_KEYS);
    const mfaRequired = typeof mfaRaw === 'boolean' ? mfaRaw : mfaRaw === 'true' ? true : undefined;

    return {
      id,
      role,
      label: str(pick(entry, LABEL_KEYS)) || `${role} · ${id}`,
      loginType: inferLoginType(identifier, entry),
      credentials,
      notes: Object.keys(meta).length ? undefined : str(pick(entry, ['notes'])),
      tenant,
      mfaRequired,
      meta: Object.keys(meta).length ? meta : undefined,
    };
  });
}

export type CatalogResolution = {
  ok: boolean;
  url: string;
  fetchedAt: string;
  accounts: CatalogAccount[];
  rolesAvailable: string[];
  personasAvailable: string[];
  missingPersonas: string[];
  missingRoles: string[];
  error?: string;
};

export async function fetchAccountCatalog(
  catalog: QaAccountCatalog,
  timeoutMs = 20_000,
): Promise<CatalogResolution> {
  const base: CatalogResolution = {
    ok: false,
    url: catalog.url,
    fetchedAt: new Date().toISOString(),
    accounts: [],
    rolesAvailable: [],
    personasAvailable: [],
    missingPersonas: [],
    missingRoles: [],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(catalog.url, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) {
      return { ...base, error: `Account catalog responded ${res.status} ${res.statusText}` };
    }
    const payload = await res.json();
    const accounts = normalizeCatalog(payload);
    if (!accounts.length) {
      return { ...base, error: 'Account catalog was reachable but no account entries could be recognised in its payload.' };
    }
    const personasAvailable = accounts.map((a) => a.id);
    const rolesAvailable = [...new Set(accounts.map((a) => a.role))].sort();
    const missingPersonas = (catalog.requiredPersonas || []).filter((p) => !personasAvailable.includes(p));
    const missingRoles = (catalog.requiredRoles || []).filter((r) => !rolesAvailable.includes(r));
    return {
      ...base,
      ok: missingPersonas.length === 0 && missingRoles.length === 0,
      accounts,
      rolesAvailable,
      personasAvailable,
      missingPersonas,
      missingRoles,
      error: missingPersonas.length || missingRoles.length
        ? `Required personas/roles missing from the catalog: ${[...missingPersonas, ...missingRoles].join(', ')}`
        : undefined,
    };
  } catch (e) {
    const msg = e instanceof Error && e.name === 'AbortError'
      ? `Account catalog did not respond within ${timeoutMs / 1000}s`
      : `Account catalog fetch failed: ${e instanceof Error ? e.message : String(e)}`;
    return { ...base, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Static definitions win over catalog entries with the same id, so a project can
 * override a single persona without abandoning the live catalog.
 */
export function mergeAccounts(staticAccounts: QaAccount[], catalogAccounts: CatalogAccount[]): CatalogAccount[] {
  const out = new Map<string, CatalogAccount>();
  for (const a of catalogAccounts) out.set(a.id, a);
  for (const a of staticAccounts) {
    const prev = out.get(a.id);
    out.set(a.id, {
      ...prev,
      ...a,
      credentials: { ...(prev?.credentials || {}), ...(a.credentials || {}) },
    });
  }
  return [...out.values()];
}

/** Every secret value in the resolved set, so logs can be scrubbed of them. */
export function secretLiterals(accounts: CatalogAccount[]): string[] {
  const out: string[] = [];
  for (const a of accounts) {
    for (const [k, v] of Object.entries(a.credentials || {})) {
      if (k === 'identifier') continue; // identifiers appear in reports legitimately
      if (v) out.push(v);
    }
  }
  return [...new Set(out)];
}
