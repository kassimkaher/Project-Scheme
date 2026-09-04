import { NextResponse } from 'next/server';
import { listProjects } from '@/lib/store';
import { reconcileRuns } from '@/lib/launch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  await reconcileRuns();
  return NextResponse.json({ projects: await listProjects() });
}
