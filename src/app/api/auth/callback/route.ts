import { NextRequest, NextResponse } from 'next/server';
import { createSession, exchangeCode, fetchUser, verifyState, sessionClearCookie, STATE_COOKIE } from '@/lib/auth';
import { isAllowedMember } from '@/lib/github';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const base = process.env.PUBLIC_BASE_URL;

  if (!verifyState(req)) {
    return NextResponse.redirect(new URL('/?auth=denied', base), {
      headers: { 'Set-Cookie': sessionClearCookie(STATE_COOKIE) },
    });
  }

  const code = new URL(req.url).searchParams.get('code');
  if (!code) {
    return NextResponse.redirect(new URL('/?auth=denied', base), {
      headers: { 'Set-Cookie': sessionClearCookie(STATE_COOKIE) },
    });
  }

  try {
    const { accessToken, refreshToken, expiresIn } = await exchangeCode(code);
    const user = await fetchUser(accessToken);

    if (!(await isAllowedMember(accessToken))) {
      console.error('[auth/callback] isAllowedMember returned false for user:', user.login);
      return NextResponse.redirect(new URL('/?auth=denied', base), {
        headers: { 'Set-Cookie': sessionClearCookie(STATE_COOKIE) },
      });
    }

    const { cookie } = createSession(accessToken, user, refreshToken, expiresIn);
    return NextResponse.redirect(new URL('/', base), {
      headers: { 'Set-Cookie': [cookie, sessionClearCookie(STATE_COOKIE)].join(', ') },
    });
  } catch (err) {
    console.error('[auth/callback] error:', err);
    return NextResponse.redirect(new URL('/?auth=denied', base), {
      headers: { 'Set-Cookie': sessionClearCookie(STATE_COOKIE) },
    });
  }
}