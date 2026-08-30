import { NextRequest, NextResponse } from 'next/server';
import { getIssue, setIssueState } from '@/lib/store';
import { publishIssue } from '@/lib/sse';
import { setIssueStateLabels } from '@/lib/github';
import { canBatchAdvance, getBatchAdvanceTarget } from '@/lib/transitions';
import { UnauthorizedError, ForbiddenError, requireMember } from '@/lib/auth';
import { startValidation } from '@/lib/validate';
import { startDevelop } from '@/lib/develop';

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

  const body = (await req.json().catch(() => ({}))) as { 
    issueIds?: unknown;
    mode?: unknown;
    command?: unknown;
  };
  const issueIds = Array.isArray(body.issueIds) ? [...new Set(body.issueIds.filter((id): id is number => typeof id === 'number'))] : [];
  const mode = body.mode === 'develop' ? 'develop' : body.mode === 'validate' ? 'validate' : 'advance';
  const command = typeof body.command === 'string' ? body.command : '';

  if (issueIds.length === 0) {
    return NextResponse.json({ error: 'no issue IDs provided' }, { status: 400 });
  }

  if (issueIds.length > 50) {
    return NextResponse.json({ error: 'batch size limit exceeded (max 50)' }, { status: 400 });
  }

  const results: Array<{ id: number; success: boolean; error?: string; mode?: string }> = [];

  for (const issueId of issueIds) {
    const issue = getIssue(issueId);
    if (!issue) {
      results.push({ id: issueId, success: false, error: 'not found' });
      continue;
    }

    if (mode === 'develop' && (issue.state === 'backlog' || issue.state === 'refinement')) {
      const developing = setIssueState(issue.id, 'developing');
      if (developing) {
        publishIssue(developing);
        void setIssueStateLabels(issue.owner, issue.repo, issue.number, 'developing', session.token).catch(() => {});
        
        void startDevelop(issue, command, session.token);
        
        results.push({ id: issueId, success: true, mode: 'developing' });
      } else {
        results.push({ id: issueId, success: false, error: 'failed to start development' });
      }
      continue;
    }

    if (mode === 'validate') {
      if (issue.state !== 'backlog') {
        results.push({ id: issueId, success: false, error: 'validate only supports backlog issues', mode: 'validate' });
        continue;
      }
      const validating = setIssueState(issue.id, 'refinement');
      if (validating) {
        publishIssue(validating);
        void setIssueStateLabels(issue.owner, issue.repo, issue.number, 'refinement', session.token).catch(() => {});
        
        void startValidation(issue, session.token);
        
        results.push({ id: issueId, success: true, mode: 'validating' });
      } else {
        results.push({ id: issueId, success: false, error: 'failed to start validation' });
      }
      continue;
    }

    if (!canBatchAdvance(issue.state)) {
      results.push({ id: issueId, success: false, error: `cannot advance from '${issue.state}'` });
      continue;
    }

    const target = getBatchAdvanceTarget(issue.state)!;
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
