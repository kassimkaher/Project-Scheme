import { NextResponse } from 'next/server';
import { listAllRuns } from '@/lib/store';
import { reconcileRuns } from '@/lib/launch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  await reconcileRuns();
  const all = new URL(req.url).searchParams.get('all') === 'true';
  return NextResponse.json({ runs: await listAllRuns(all) });
}
