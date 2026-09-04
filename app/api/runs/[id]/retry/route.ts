import { NextResponse } from 'next/server';
import { LaunchError, retryRun } from '@/lib/launch';

export const runtime = 'nodejs';

/** Always creates a NEW run id; the failed run stays in history untouched. */
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await retryRun(id);
    return NextResponse.json({ run: result.run, retryOf: id });
  } catch (e) {
    if (e instanceof LaunchError) {
      return NextResponse.json({ error: e.message, ...e.payload }, { status: e.status });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
