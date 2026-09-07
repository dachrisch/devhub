import { NextRequest, NextResponse } from 'next/server';
import { getIssue } from '@/lib/store';
import { markIssueShipped } from '@/lib/github';
import { requireMember, UnauthorizedError, ForbiddenError, GithubUnavailableError } from '@/lib/auth';
import type { Issue } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Manual "Mark shipped" (devhub#167): always allowed, wins over the sweep.
// Forces open runs (`pr`|`merged`) to `released` and rolls the issue out.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<{ issue: Issue } | { error: string }>> {
  try {
    await requireMember(req);
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
  const body = (await req.json().catch(() => ({}))) as { releaseTag?: unknown };
  const releaseTag = typeof body.releaseTag === 'string' ? body.releaseTag : undefined;
  const updated = markIssueShipped(issueId, releaseTag);
  if (!updated) return NextResponse.json({ error: 'could not mark shipped' }, { status: 500 });
  return NextResponse.json({ issue: updated });
}
