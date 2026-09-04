import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readRunRecord, runDir, updateRun } from '@/lib/store';
import { killRunTree } from '@/lib/procs';

export const runtime = 'nodejs';

/**
 * Stops one run's whole process tree — supervisor, Claude Code, the Playwright MCP
 * server and its browser — by signalling the run's own process group, so no other
 * run is affected. Logs and evidence produced so far are preserved.
 */
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const run = await readRunRecord(id);

    if (run.status !== 'running' && run.status !== 'queued') {
      return NextResponse.json({
        error: `This run is already ${run.status}; there is nothing to cancel.`,
        run,
      }, { status: 409 });
    }

    const outcome = await killRunTree({ pid: run.pid, pgid: run.pgid, graceMs: 4000 });

    // The supervisor writes its own cancelled record when it receives SIGTERM.
    // Give it a moment, then make sure the run cannot be left marked active.
    await new Promise((r) => setTimeout(r, 700));
    let current = await readRunRecord(id);
    if (current.status === 'running' || current.status === 'queued') {
      const reportExists = await fs
        .access(path.join(runDir(run.projectId, id), 'report.md'))
        .then(() => true).catch(() => false);
      current = await updateRun(id, {
        status: 'cancelled',
        stage: 'cancelled',
        finishedAt: new Date().toISOString(),
        reportExists,
        stageDetail: outcome.alreadyGone
          ? 'The run process had already exited; the run was marked cancelled.'
          : 'Cancelled by the operator. Logs and evidence produced so far are preserved.',
      }, run.projectId);
    }

    return NextResponse.json({ run: current, processStop: outcome });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
