import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runArtifactPath } from '@/lib/store';

export const runtime = 'nodejs';

export async function GET(_: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  try {
    const { id, file } = await params;
    const safe = path.basename(file);
    if (safe !== file) return new NextResponse('Bad path', { status: 400 });
    const data = await fs.readFile(await runArtifactPath(id, 'evidence', safe));
    const ext = path.extname(safe).toLowerCase();
    const type = ext === '.png' ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.webp' ? 'image/webp'
      : ext === '.pdf' ? 'application/pdf'
      : ext === '.txt' || ext === '.log' ? 'text/plain; charset=utf-8'
      : ext === '.json' ? 'application/json'
      : 'application/octet-stream';
    return new NextResponse(data, { headers: { 'content-type': type, 'cache-control': 'no-store' } });
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }
}
