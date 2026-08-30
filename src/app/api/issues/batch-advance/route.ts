import { NextRequest, NextResponse } from 'next/server';
import { getIssue, setIssueState } from '@/lib/store';
import { publishIssue } from '@/lib/sse';
import { setIssueStateLabels } from '@/lib/github';
import { canBatchAdvance, getBatchAdvanceTarget } from '@/lib/transitions';
import { UnauthorizedError, ForbiddenError, requireMember } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  let session;
  try {
    session = await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { issueIds?: unknown };
  const issueIds = Array.isArray(body.issueIds) ? body.issueIds.filter((id): id is number => typeof id === 'number') : [];

  if (issueIds.length === 0) {
    return NextResponse.json({ error: 'no issue IDs provided' }, { status: 400 });
  }

  const results: Array<{ id: number; success: boolean; error?: string }> = [];

  for (const issueId of issueIds) {
    const issue = getIssue(issueId);
    if (!issue) {
      results.push({ id: issueId, success: false, error: 'not found' });
      continue;
    }

    if (!canBatchAdvance(issue.state)) {
      results.push({ id: issueId, success: false, error: `cannot advance from '${issue.state}'` });
      continue;
    }

    const target = getBatchAdvanceTarget(issue.state);
    if (!target) {
      results.push({ id: issueId, success: false, error: 'no target state' });
      continue;
    }

    const updated = setIssueState(issue.id, target);
    if (updated) {
      publishIssue(updated);
      void setIssueStateLabels(issue.owner, issue.repo, issue.number, target, session.token).catch(() => {});
      results.push({ id: issueId, success: true });
    } else {
      results.push({ id: issueId, success: false, error: 'update failed' });
    }
  }

  return NextResponse.json({ ok: true, results });
}
