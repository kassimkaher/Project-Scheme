import { NextResponse } from 'next/server';
import { dismissRun } from '@/lib/store';

export const runtime = 'nodejs';

/**
 * Clears a finished run from the active list. Report, logs and evidence are kept
 * and the run stays in the project's run history — deleting artifacts is DELETE.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const run = await dismissRun(id, body?.dismissed !== false);
    return NextResponse.json({ run });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}
