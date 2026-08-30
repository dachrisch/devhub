import { NextResponse } from 'next/server';
import { buildLoginUrl } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const { url, stateCookie } = buildLoginUrl();
  return NextResponse.redirect(url, { headers: { 'Set-Cookie': stateCookie } });
}