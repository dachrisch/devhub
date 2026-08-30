import { NextRequest, NextResponse } from 'next/server';
import { getIssue, setIssueState } from '@/lib/store';
import { publishIssue } from '@/lib/sse';
import { setIssueStateLabels } from '@/lib/github';
import { canTransition } from '@/lib/transitions';
import { isIssueState, type IssueState } from '@/lib/types';
import { UnauthorizedError, ForbiddenError, requireMember } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const issueId = Number(id);
  if (!Number.isInteger(issueId)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }

  let session;
  try {
    session = await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }

  const issue = getIssue(issueId);
  if (!issue) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as { state?: unknown };
  const target: IssueState | null = isIssueState(body.state) ? body.state : null;
  if (!target) {
    return NextResponse.json({ error: 'missing or invalid target state' }, { status: 400 });
  }
  if (!canTransition(issue.state, target)) {
    return NextResponse.json({ error: `cannot move '${issue.state}' → '${target}'` }, { status: 409 });
  }

  const updated = setIssueState(issue.id, target);
  if (updated) {
    publishIssue(updated);
    // Best-effort mirror of the DevHub state label on the GitHub issue.
    void setIssueStateLabels(issue.owner, issue.repo, issue.number, target, session.token).catch(() => {});
  }
  return NextResponse.json({ ok: true, issue: updated });
}