import { NextRequest, NextResponse } from 'next/server';
import { getServices } from '@/lib/store';
import { requireMember, UnauthorizedError, ForbiddenError } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  let session;
  try {
    session = await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }

  const services = getServices();
  return NextResponse.json({ services });
}
