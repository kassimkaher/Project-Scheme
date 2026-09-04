import { NextResponse } from 'next/server';
import { importSchema } from '@/lib/schema';
import { fingerprintSpec, parseProjectSpec, specStats } from '@/lib/spec';
import { createProject, findProjectByFingerprint, projectRunStats, updateProjectFromSpec } from '@/lib/store';

export const runtime = 'nodejs';

/**
 * Import is deliberately non-destructive. When a definition matches a project
 * already in the library the request comes back as a conflict describing the
 * options, and the user chooses update / new copy / cancel.
 */
export async function POST(req: Request) {
  try {
    const body = importSchema.parse(await req.json());
    const spec = parseProjectSpec(body.raw);
    const fingerprint = fingerprintSpec(spec);

    if (body.targetProjectId) {
      const rec = await updateProjectFromSpec(body.targetProjectId, spec, body.raw, body.filename);
      return NextResponse.json({ outcome: 'updated', project: await summary(rec) });
    }

    const existing = await findProjectByFingerprint(fingerprint);

    if (existing && body.onConflict === 'ask') {
      return NextResponse.json({
        outcome: 'conflict',
        match: {
          id: existing.id,
          name: existing.name,
          runCount: existing.runCount,
          lastRunAt: existing.lastRunAt,
          updatedAt: existing.updatedAt,
          matchedOn: spec.projectId ? 'declared projectId' : 'system name + source URLs',
        },
        incoming: { name: spec.system.name, ...specStats({ ...spec, accounts: [] } as any) },
      }, { status: 409 });
    }

    if (existing && body.onConflict === 'update') {
      const rec = await updateProjectFromSpec(existing.id, spec, body.raw, body.filename);
      return NextResponse.json({ outcome: 'updated', project: await summary(rec) });
    }

    const rec = await createProject(spec, body.raw, body.filename);
    return NextResponse.json({ outcome: existing ? 'copied' : 'created', project: await summary(rec) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

/** Run stats are derived from disk so an updated project reports its real history. */
async function summary(rec: any) {
  return {
    id: rec.id, name: rec.name, description: rec.description,
    ...specStats(rec.spec),
    createdAt: rec.createdAt, updatedAt: rec.updatedAt,
    ...(await projectRunStats(rec.id)),
  };
}
