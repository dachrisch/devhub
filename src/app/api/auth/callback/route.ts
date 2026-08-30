import { NextRequest, NextResponse } from 'next/server';
import { createSession, exchangeCode, fetchUser, verifyState, sessionClearCookie, STATE_COOKIE } from '@/lib/auth';
import { isAllowedMember } from '@/lib/github';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!verifyState(req)) {
    return NextResponse.redirect(new URL('/?auth=denied', req.url), {
      headers: { 'Set-Cookie': sessionClearCookie(STATE_COOKIE) },
    });
  }

  const code = new URL(req.url).searchParams.get('code');
  if (!code) {
    return NextResponse.redirect(new URL('/?auth=denied', req.url), {
      headers: { 'Set-Cookie': sessionClearCookie(STATE_COOKIE) },
    });
  }

  try {
    const token = await exchangeCode(code);
    const user = await fetchUser(token);

    if (!(await isAllowedMember(token))) {
      return NextResponse.redirect(new URL('/?auth=denied', req.url), {
        headers: { 'Set-Cookie': sessionClearCookie(STATE_COOKIE) },
      });
    }

    const { cookie } = createSession(token, user);
    return NextResponse.redirect(new URL('/', req.url), {
      headers: { 'Set-Cookie': [cookie, sessionClearCookie(STATE_COOKIE)].join(', ') },
    });
  } catch {
    return NextResponse.redirect(new URL('/?auth=denied', req.url), {
      headers: { 'Set-Cookie': sessionClearCookie(STATE_COOKIE) },
    });
  }
}