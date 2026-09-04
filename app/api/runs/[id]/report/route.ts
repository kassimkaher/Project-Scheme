import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import { runArtifactPath } from '@/lib/store';

export const runtime = 'nodejs';
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await fs.readFile(await runArtifactPath(id, 'report.md'), 'utf8');
    return new NextResponse(body, {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="qa-report-${id.slice(0, 8)}.md"`,
      },
    });
  } catch {
    return new NextResponse('Report not ready', { status: 404 });
  }
}
