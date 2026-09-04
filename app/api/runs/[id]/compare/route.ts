import { NextResponse } from 'next/server';
import { getRunDetail, listRunsForProject, readRunRecord } from '@/lib/store';
import { compareRuns, readResults } from '@/lib/compare';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Compares this run with a previous one from the same project. Without ?against=
 * it picks the most recent earlier run that produced results.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const current = await readRunRecord(id);
    const requested = new URL(req.url).searchParams.get('against');

    let baselineId = requested || undefined;
    if (!baselineId) {
      const runs = await listRunsForProject(current.projectId, true);
      const older = runs.filter((r) => r.id !== id && r.createdAt < current.createdAt);
      for (const candidate of older) {
        const d = await getRunDetail(candidate.id).catch(() => null);
        if (d?.results) { baselineId = candidate.id; break; }
      }
    }
    if (!baselineId) {
      return NextResponse.json({
        error: 'No earlier run with results is available for this project yet, so there is nothing to compare against.',
      }, { status: 404 });
    }

    const [curDetail, baseDetail] = await Promise.all([getRunDetail(id), getRunDetail(baselineId)]);
    if (!curDetail.results) {
      return NextResponse.json({ error: 'This run produced no results.json, so it cannot be compared.' }, { status: 404 });
    }
    const comparison = compareRuns(
      baselineId, readResults(baseDetail.results),
      id, readResults(curDetail.results),
    );
    return NextResponse.json({
      comparison,
      baseline: { id: baselineId, createdAt: baseDetail.createdAt, mode: baseDetail.mode, status: baseDetail.status },
      current: { id, createdAt: curDetail.createdAt, mode: curDetail.mode, status: curDetail.status },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
