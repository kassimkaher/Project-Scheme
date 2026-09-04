import { NextResponse } from 'next/server';
import { readProjectRecord } from '@/lib/store';
import { fetchAccountCatalog } from '@/lib/accounts';
import { resolveCatalog } from '@/lib/spec';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Resolves the personas available for an environment so the run screen can offer
 * a real scope picker. Returns metadata only — never a credential value.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const rec = await readProjectRecord(id);
    const envId = new URL(req.url).searchParams.get('envId') || rec.spec.environments[0]?.id || '';
    const catalog = resolveCatalog(rec.spec, envId);

    const staticAccounts = rec.spec.accounts.map((a) => ({
      id: a.id, role: a.role, label: a.label, loginType: a.loginType,
      credentialKeys: a.credentialKeys, source: 'static' as const,
    }));

    if (!catalog) {
      return NextResponse.json({
        source: 'static',
        accounts: staticAccounts,
        roles: [...new Set(staticAccounts.map((a) => a.role))].sort(),
      });
    }

    const res = await fetchAccountCatalog(catalog);
    const catalogAccounts = res.accounts.map((a) => ({
      id: a.id, role: a.role, label: a.label, loginType: a.loginType,
      credentialKeys: Object.keys(a.credentials || {}).sort(),
      tenant: a.tenant, mfaRequired: a.mfaRequired,
      meta: a.meta, source: 'catalog' as const,
    }));
    const byId = new Map<string, any>();
    for (const a of catalogAccounts) byId.set(a.id, a);
    for (const a of staticAccounts) byId.set(a.id, { ...byId.get(a.id), ...a });
    const accounts = [...byId.values()];

    return NextResponse.json({
      source: 'catalog',
      catalogUrl: catalog.url,
      fetchedAt: res.fetchedAt,
      ok: res.ok,
      error: res.error,
      missingPersonas: res.missingPersonas,
      missingRoles: res.missingRoles,
      accounts,
      roles: [...new Set(accounts.map((a) => a.role))].sort(),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
