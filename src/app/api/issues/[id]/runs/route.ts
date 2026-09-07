import { NextRequest, NextResponse } from 'next/server';
import { getIssue, getRunsForIssue } from '@/lib/store';
import { requireMember, UnauthorizedError, ForbiddenError, GithubUnavailableError } from '@/lib/auth';
import type { DevelopRun } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Per-run timeline for the recap page + card PR chips (devhub#167).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<{ runs: DevelopRun[] } | { error: string }>> {
  try {
    await requireMember(_req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    if (err instanceof GithubUnavailableError) return NextResponse.json({ error: 'github unavailable, try again' }, { status: 502 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }
  const { id } = await params;
  const issueId = Number(id);
  if (!Number.isInteger(issueId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  if (!getIssue(issueId)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ runs: getRunsForIssue(issueId) });
}
