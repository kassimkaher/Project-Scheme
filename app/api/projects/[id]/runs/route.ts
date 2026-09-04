import { NextResponse } from 'next/server';
import { startRunSchema } from '@/lib/schema';
import { listRunsForProject } from '@/lib/store';
import { LaunchError, launchRun, reconcileRuns } from '@/lib/launch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await reconcileRuns();
  const includeDismissed = new URL(req.url).searchParams.get('all') === 'true';
  return NextResponse.json({ runs: await listRunsForProject(id, includeDismissed) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = startRunSchema.parse(await req.json());
    const result = await launchRun({
      projectId: id,
      envId: body.envId,
      mode: body.mode,
      scope: body.scope,
      enforcePreflight: body.enforcePreflight,
    });
    return NextResponse.json({
      run: result.run,
      accountsResolved: result.accountsResolved,
      catalogUrl: result.catalogUrl,
    });
  } catch (e) {
    if (e instanceof LaunchError) {
      return NextResponse.json({ error: e.message, ...e.payload }, { status: e.status });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
