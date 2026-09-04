import { NextResponse } from 'next/server';
import { deleteRun, getRunDetail } from '@/lib/store';
import { reconcileRuns } from '@/lib/launch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await reconcileRuns();
    return NextResponse.json(await getRunDetail(id));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
}

/**
 * Permanently deletes this run's report, logs and evidence. This is the separate
 * destructive action — "clear from active list" is POST /dismiss and keeps files.
 */
export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await deleteRun(id);
    return NextResponse.json({ deleted: id });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}
