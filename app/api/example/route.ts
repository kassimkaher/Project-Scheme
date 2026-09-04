import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';

export const runtime = 'nodejs';
export async function GET() {
  const body = await fs.readFile(path.join(process.cwd(), 'templates/qa-system.example.md'), 'utf8');
  return new NextResponse(body, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': 'attachment; filename="qa-system.example.md"'
    }
  });
}
