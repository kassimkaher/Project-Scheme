import { NextResponse } from 'next/server';
import { listProjects, missingProjects } from '@/lib/store';
import { reconcileRuns } from '@/lib/launch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  await reconcileRuns();
  const [projects, missing] = await Promise.all([listProjects(), missingProjects()]);
  // `missing` names projects the index records but whose data is gone, so the
  // library reports the loss instead of quietly listing fewer projects.
  return NextResponse.json({ projects, missing });
}
