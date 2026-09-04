import { NextResponse } from 'next/server';
import { duplicateProject } from '@/lib/store';

export const runtime = 'nodejs';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const rec = await duplicateProject(id, body?.name);
    return NextResponse.json({ project: { id: rec.id, name: rec.name } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
