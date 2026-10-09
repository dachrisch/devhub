import { NextRequest, NextResponse } from 'next/server';
import { requireMember, UnauthorizedError, ForbiddenError, GithubUnavailableError } from '@/lib/auth';
import { getActivitySnapshot } from '@/lib/activity/query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Current fleet + (devhub#273) history aggregates for the /activity page.
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    if (err instanceof GithubUnavailableError) return NextResponse.json({ error: 'github unavailable, try again' }, { status: 502 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }
  const snapshot = await getActivitySnapshot();
  return NextResponse.json({ ...snapshot, history: [] });
}
