import { NextResponse } from 'next/server';
import { projectPatchSchema } from '@/lib/schema';
import { specStats } from '@/lib/spec';
import {
  deleteProject, listRunsForProject, patchProject,
  projectRunStats, readProjectRecord, touchProjectOpened,
} from '@/lib/store';
import { reconcileRuns } from '@/lib/launch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Returns the project's definition with credentials already absent — project.json
 * only ever stores credential field *names*, so there is nothing to unmask here.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await reconcileRuns();
    const rec = await readProjectRecord(id);
    if (new URL(req.url).searchParams.get('touch') !== 'false') await touchProjectOpened(id);
    const runs = await listRunsForProject(id, true);
    const stats = await projectRunStats(id);
    return NextResponse.json({
      project: {
        id: rec.id, name: rec.name, description: rec.description,
        sourceFilename: rec.sourceFilename, fingerprint: rec.fingerprint,
        declaredId: rec.declaredId, migratedFrom: rec.migratedFrom,
        createdAt: rec.createdAt, updatedAt: rec.updatedAt,
        lastOpenedAt: rec.lastOpenedAt,
        spec: rec.spec,
        ...specStats(rec.spec),
        ...stats,
      },
      runs,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const patch = projectPatchSchema.parse(await req.json());
    const rec = await patchProject(id, patch);
    return NextResponse.json({ project: { id: rec.id, name: rec.name, spec: rec.spec, updatedAt: rec.updatedAt } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

/** Destructive: removes the definition, its encrypted secrets and every run artifact. */
export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const rec = await readProjectRecord(id);
    const runs = await listRunsForProject(id, true);
    const active = runs.find((r) => r.status === 'running' || r.status === 'queued');
    if (active) {
      return NextResponse.json({
        error: 'This project has an active run. Cancel it before deleting the project.',
        activeRunId: active.id,
      }, { status: 409 });
    }
    await deleteProject(id);
    return NextResponse.json({ deleted: { id, name: rec.name, runsRemoved: runs.length } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

/*
 * There is deliberately no endpoint that returns the original imported text.
 * source.enc holds the definition exactly as authored, credentials included, so
 * serving it would hand plaintext secrets to any caller — the opposite of the
 * masking every other route applies. To change a definition, import an updated
 * file: the library's "Import updated definition" action targets this project
 * and replaces its secrets, keeping the run history.
 */
