import { NextRequest, NextResponse } from 'next/server';
import { getIssue, getThread, upsertIssue } from '@/lib/store';
import { confirmSplit, getLatestSplitProposal, setWorkRunner } from '@/lib/threads-run';
import { createGithubIssue } from '@/lib/github';
import { canDevelop, startWork } from '@/lib/develop';
import { ENV } from '@/lib/env';
import { UnauthorizedError, ForbiddenError, GithubUnavailableError, requireMember } from '@/lib/auth';
import type { OpencodeModel } from '@/lib/opencode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Split-confirm gate: nothing is created until confirm. Accepted cards become
// real GitHub issues (topic-tagged so sync already finds them) and enter the
// serial auto-Work queue.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  let session;
  try {
    session = await requireMember(req);
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
  if (thread.kind !== 'strategy') return NextResponse.json({ error: 'only strategy threads split' }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as {
    accepted?: unknown;
    titles?: unknown;
    modelId?: unknown;
    providerID?: unknown;
  };
  if (!Array.isArray(body.accepted) || body.accepted.some((n) => !Number.isInteger(n))) {
    return NextResponse.json({ error: 'accepted indices are required' }, { status: 400 });
  }
  const titleOverrides =
    body.titles && typeof body.titles === 'object'
      ? (body.titles as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const modelId = typeof body.modelId === 'string' && body.modelId ? body.modelId : null;
  const providerID = typeof body.providerID === 'string' && body.providerID ? body.providerID : null;
  const selectedModel: OpencodeModel | null = modelId ? { id: modelId, providerID: providerID ?? 'opencode' } : null;

  const proposal = getLatestSplitProposal(threadId);
  const accepted = (body.accepted as number[])
    .filter((n) => n >= 0 && n < proposal.length)
    .map((n) => {
      const item = proposal[n];
      const override = titleOverrides[String(n)];
      return typeof override === 'string' && override.trim() ? { ...item, title: override.trim() } : item;
    });
  if (accepted.length === 0) return NextResponse.json({ error: 'nothing accepted' }, { status: 400 });
  if (accepted.length > 10) return NextResponse.json({ error: 'at most 10 cards per confirm' }, { status: 400 });

  // The operator's topic tag so the next sync already finds these issues.
  const topicTag = ENV.githubTopics[0] ?? 'devhub';
  // Serial-queue runner bound to this operator token (see POST /api/threads).
  // Installed BEFORE confirmSplit: its trailing pump must see the runner or
  // the queue never starts.
  setWorkRunner(async (issueId: number) => {
    try {
      const queued = getIssue(issueId);
      if (!queued || !canDevelop(queued)) return;
      await startWork(queued, `Continuing confirmed split card: ${queued.title}`, session.token, selectedModel);
    } finally {
      const { pumpWorkQueue } = await import('@/lib/threads-run');
      void pumpWorkQueue();
    }
  });
  try {
    const ids = await confirmSplit(threadId, accepted, {
      createIssue: async (item) => {
        const [owner, repo] = item.repo.split('/');
        if (!owner || !repo) throw new Error(`bad repo "${item.repo}" — want owner/name`);
        const created = await createGithubIssue(
          owner,
          repo,
          item.title,
          `${item.body}\n\nWhy: ${item.why}\n\n[${topicTag}]`,
          session.token
        );
        const stored = upsertIssue({
          githubIssueId: Date.now(),
          owner,
          repo,
          number: created.number,
          title: item.title,
          body: item.body,
          htmlUrl: created.htmlUrl,
        });
        return stored.id;
      },
    });
    return NextResponse.json({ ok: true, threadId, issueIds: ids });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
