import { NextRequest, NextResponse } from 'next/server';
import { getIssue, getThread, getThreadEvents } from '@/lib/store';
import { getLatestSplitProposal, getQueuePosition, getThreadBlockedReason } from '@/lib/threads-run';
import { UnauthorizedError, ForbiddenError, GithubUnavailableError, requireMember } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    if (err instanceof GithubUnavailableError)
      return NextResponse.json({ error: 'github unavailable, try again' }, { status: 502 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }

  const { id } = await params;
  const threadId = Number(id);
  if (!Number.isInteger(threadId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const thread = getThread(threadId);
  if (!thread) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const issues = thread.issueIds
    .map((issueId) => getIssue(issueId))
    .filter((i): i is NonNullable<typeof i> => i !== null);
  return NextResponse.json({
    thread,
    events: getThreadEvents(threadId),
    issues,
    blockedReason: getThreadBlockedReason(threadId),
    queuePositions: Object.fromEntries(thread.issueIds.map((issueId) => [issueId, getQueuePosition(issueId)])),
    splitProposal: getLatestSplitProposal(threadId),
  });
}
