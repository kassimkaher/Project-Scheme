import { NextResponse } from 'next/server';
import { preflight } from '@/lib/preflight';
import { readProjectRecord } from '@/lib/store';

export const runtime = 'nodejs';

/** Lets the run screen show dependency status before the user commits to a run. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const rec = await readProjectRecord(id);
    const report = await preflight({
      spec: rec.spec,
      envId: body.envId || rec.spec.environments[0]?.id,
      mode: body.mode || 'full',
      skipSessionProbe: body.skipSessionProbe === true,
    });
    return NextResponse.json({ preflight: report });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
