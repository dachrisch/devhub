import { NextRequest, NextResponse } from 'next/server';
import { destroySession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const clear = destroySession(req);
  if (!clear) return NextResponse.json({ ok: true });
  return NextResponse.json({ ok: true }, { headers: { 'Set-Cookie': clear } });
}