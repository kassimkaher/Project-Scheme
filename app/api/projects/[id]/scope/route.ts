import { NextResponse } from 'next/server';
import { getRunDetail, listRunsForProject } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Features and use case ids discovered by the most recent run that generated
 * them, so a re-run can be narrowed to a subset instead of the whole suite.
 */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const runs = await listRunsForProject(id, true);
    for (const r of runs) {
      const detail = await getRunDetail(r.id).catch(() => null);
      const raw = detail?.useCases;
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.useCases) ? raw.useCases : null;
      if (!list?.length) continue;
      const useCases = list
        .filter((u: any) => u && typeof u === 'object')
        .map((u: any) => ({
          id: String(u.id ?? ''), title: String(u.title ?? u.id ?? ''),
          role: u.role ? String(u.role) : undefined,
          feature: u.feature ? String(u.feature) : undefined,
          mode: u.mode ? String(u.mode) : undefined,
          priority: u.priority ? String(u.priority) : undefined,
        }))
        .filter((u: any) => u.id);
      return NextResponse.json({
        fromRunId: r.id,
        generatedAt: r.finishedAt || r.createdAt,
        features: [...new Set(useCases.map((u: any) => u.feature).filter(Boolean))].sort(),
        useCases,
      });
    }
    return NextResponse.json({ fromRunId: null, features: [], useCases: [] });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
