import { NextResponse } from 'next/server';
import { migrationNotes } from '@/lib/store';
import { resolvePlaywrightMcp } from '@/lib/preflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Orchestrator-level status. Never exposes secret values, only whether they are set. */
export async function GET() {
  const mcp = resolvePlaywrightMcp();
  const meta = await migrationNotes();
  return NextResponse.json({
    schema: { migratedAt: meta.migratedAt, notes: meta.notes || [] },
    dataDir: process.env.QA_DATA_DIR || '.qa-data',
    masterKeyConfigured: Boolean(process.env.QA_MASTER_KEY && process.env.QA_MASTER_KEY !== 'change-me-before-use'),
    claudeBin: process.env.CLAUDE_BIN || 'claude',
    claudeModel: process.env.CLAUDE_MODEL || null,
    playwrightMcp: mcp.entry ? { available: true, version: mcp.version } : { available: false, error: mcp.error },
    maxConcurrentRuns: Number(process.env.QA_MAX_CONCURRENT_RUNS || 2),
  });
}
