import { NextRequest, NextResponse } from 'next/server';
import { getIssue, getRunsForIssue, appendEvent } from '@/lib/store';
import { mergePullRequest } from '@/lib/github';
import { UnauthorizedError, ForbiddenError, GithubUnavailableError, requireMember } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function prNumberFromUrl(url: string | null): number | null {
  if (!url) return null;
  const m = url.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

// Resolve the PR to merge: prefer a run in `pr` state (multi-run issues),
// then the issue-level `resultPrUrl` / `linkedPrUrl` (legacy single-PR path).
function resolvePrTarget(issue: { resultPrUrl: string | null; linkedPrUrl: string | null; id: number; owner: string; repo: string }): {
  prNumber: number;
  prUrl: string;
  repoOwner: string;
  repoName: string;
} | null {
  const runs = getRunsForIssue(issue.id);
  const prRun = runs.find((r) => r.state === 'pr' && r.prUrl);
  if (prRun?.prUrl) {
    const num = prNumberFromUrl(prRun.prUrl);
    if (num) return { prNumber: num, prUrl: prRun.prUrl, repoOwner: prRun.repoOwner, repoName: prRun.repoName };
  }
  // Legacy path: issue-level PR URL
  const prUrl = issue.resultPrUrl ?? issue.linkedPrUrl;
  const prNumber = prNumberFromUrl(prUrl);
  if (prNumber && prUrl) return { prNumber, prUrl, repoOwner: issue.owner, repoName: issue.repo };
  return null;
}

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
    if (err instanceof GithubUnavailableError) return NextResponse.json({ error: 'github unavailable, try again' }, { status: 502 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }

  const issue = getIssue(issueId);
  if (!issue) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  if (issue.state !== 'pr') {
    return NextResponse.json({ error: `can only merge PRs for issues in 'pr' state (current: '${issue.state}')` }, { status: 409 });
  }

  const target = resolvePrTarget(issue);
  if (!target) {
    return NextResponse.json({ error: 'no pull request found to merge' }, { status: 404 });
  }

  try {
    const sha = await mergePullRequest(target.repoOwner, target.repoName, target.prNumber, session.token);
    appendEvent(issue.id, 'merged', { prUrl: target.prUrl, sha });
    return NextResponse.json({ ok: true, sha, prUrl: target.prUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
