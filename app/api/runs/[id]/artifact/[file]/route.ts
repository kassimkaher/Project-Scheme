import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import { runArtifactPath } from '@/lib/store';

export const runtime = 'nodejs';

// Only artifacts the agent is asked to produce are downloadable, by exact name.
const ALLOWED = new Set([
  'report.md', 'results.json', 'use-cases.json', 'system-analysis.json',
  'progress.ndjson', 'agent.log', 'agent-stream.ndjson', 'accounts-resolved.json', 'run.json',
]);

export async function GET(_: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  try {
    const { id, file } = await params;
    if (!ALLOWED.has(file)) return new NextResponse('Not an exportable artifact', { status: 400 });
    const body = await fs.readFile(await runArtifactPath(id, file), 'utf8');
    const type = file.endsWith('.json') ? 'application/json'
      : file.endsWith('.md') ? 'text/markdown; charset=utf-8'
      : 'text/plain; charset=utf-8';
    return new NextResponse(body, {
      headers: { 'content-type': type, 'content-disposition': `attachment; filename="${id.slice(0, 8)}-${file}"` },
    });
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }
}
