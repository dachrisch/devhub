import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = getSession(req);
  return NextResponse.json({
    user: session ? { login: session.login, avatarUrl: session.avatarUrl } : null,
  });
}