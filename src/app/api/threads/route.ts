import { NextRequest, NextResponse } from 'next/server';
import { createWorkRequest, getIssue, getIssueByGithub, getIssues, listThreads } from '@/lib/store';
import { createThread, listQueuePositions, replyToThread, startStrategyThread, startWorkThread } from '@/lib/threads-run';
import { resolveCommand } from '@/lib/resolve';
import { deriveWorkRequestTitle } from '@/lib/work-requests';
import { canDevelop, getLiveIssueIds } from '@/lib/develop';
import { UnauthorizedError, ForbiddenError, GithubUnavailableError, requireMember } from '@/lib/auth';
import type { OpencodeModel } from '@/lib/opencode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authError(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
  if (err instanceof GithubUnavailableError)
    return NextResponse.json({ error: 'github unavailable, try again' }, { status: 502 });
  return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
}

async function fetchRepoNames(token: string): Promise<string[]> {
  try {
    const res = await fetch('https://api.github.com/user/repos?per_page=100', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) throw new Error(`repos fetch failed (${res.status})`);
    const repos = (await res.json()) as { full_name?: string }[];
    const names = repos.map((r) => r.full_name).filter((n): n is string => typeof n === 'string');
    if (names.length > 0) return names;
  } catch {
    // fall through to the local fallback
  }
  // Offline fallback: repos already seen on the board.
  return [...new Set(getIssues().map((i) => `${i.owner}/${i.repo}`))].sort();
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireMember(req);
  } catch (err) {
    return authError(err);
  }
  return NextResponse.json({
    threads: listThreads(),
    queuePositions: listQueuePositions(),
    liveIssueIds: getLiveIssueIds(),
  });
}

// Every bar/mic submission goes through this one pipeline: parse intent →
// resolve repos (never guessed — chips on miss) → create thread & start run.
export async function POST(req: NextRequest): Promise<NextResponse> {
  let session;
  try {
    session = await requireMember(req);
  } catch (err) {
    return authError(err);
  }

  const body = (await req.json().catch(() => ({}))) as {
    input?: unknown;
    modelId?: unknown;
    providerID?: unknown;
    openThreadId?: unknown;
    repoChoice?: unknown;
    issueId?: unknown;
    newWork?: unknown;
  };
  const input = typeof body.input === 'string' ? body.input.trim() : '';
  if (!input) return NextResponse.json({ error: 'input is required' }, { status: 400 });
  const modelId = typeof body.modelId === 'string' && body.modelId ? body.modelId : null;
  const providerID = typeof body.providerID === 'string' && body.providerID ? body.providerID : null;
  const selectedModel: OpencodeModel | null = modelId ? { id: modelId, providerID: providerID ?? 'opencode' } : null;
  const openThreadId = typeof body.openThreadId === 'number' ? body.openThreadId : undefined;

  const repoNames = await fetchRepoNames(session.token);
  const resolved = resolveCommand(input, repoNames, { openThread: openThreadId != null, openThreadId });

  // Explicit chip answers ride the same pathway: a confirmed repo or a
  // hand-selected issue skips resolution.
  if (typeof body.repoChoice === 'string' && repoNames.includes(body.repoChoice)) {
    resolved.targets = [body.repoChoice];
    resolved.chips = [];
    if (resolved.intent === 'question') resolved.intent = 'implement';
  }
  if (typeof body.issueId === 'number') {
    const issue = getIssue(body.issueId);
    if (!issue) return NextResponse.json({ error: 'issue not found' }, { status: 404 });
    if (!canDevelop(issue)) return NextResponse.json({ error: `issue is '${issue.state}' and cannot be worked` }, { status: 409 });
    const thread = createThread({ kind: 'work', title: input.slice(0, 80) });
    void startWorkThread(thread, issue.id, { text: input, token: session.token, model: selectedModel }).catch((err) => {
      console.error(`[threads] work thread #${thread.id} threw:`, err instanceof Error ? err.message : err);
    });
    return NextResponse.json({ ok: true, threadId: thread.id }, { status: 202 });
  }

  // "Start new work item": no matching issue exists (or the operator chose to
  // start fresh). Create a local, non-GitHub work request and run the normal
  // develop pipeline against it — the agent works the free-text request.
  if (body.newWork === true) {
    const repo =
      typeof body.repoChoice === 'string' && repoNames.includes(body.repoChoice)
        ? body.repoChoice
        : resolved.targets[0];
    if (!repo) {
      return NextResponse.json({
        needsChoice: true,
        intent: 'implement',
        chips: [{ kind: 'repo-choice', label: 'Which repo should this work go to?', options: repoNames }],
      });
    }
    const [owner, name] = repo.split('/');
    if (!owner || !name) return NextResponse.json({ error: `bad repo "${repo}"` }, { status: 400 });
    const request = createWorkRequest({ owner, repo: name, title: deriveWorkRequestTitle(input), body: input });
    const thread = createThread({ kind: 'work', title: input.slice(0, 80) });
    void startWorkThread(thread, request.id, { text: input, token: session.token, model: selectedModel }).catch((err) => {
      console.error(`[threads] new work request #${thread.id} threw:`, err instanceof Error ? err.message : err);
    });
    return NextResponse.json({ ok: true, threadId: thread.id }, { status: 202 });
  }

  // Follow-up inside an open thread — no new work.
  if (resolved.intent === 'question' && resolved.openThreadId != null) {
    const { getThread } = await import('@/lib/store');
    const thread = getThread(resolved.openThreadId);
    if (!thread) return NextResponse.json({ error: 'thread not found' }, { status: 404 });
    void replyToThread(thread, input, { text: input, token: session.token, model: selectedModel }).catch((err) => {
      console.error(`[threads] reply #${thread.id} threw:`, err instanceof Error ? err.message : err);
    });
    return NextResponse.json({ ok: true, threadId: thread.id }, { status: 202 });
  }

  // Repo mapping failed → chips, not a guess.
  if (resolved.chips.length > 0) {
    return NextResponse.json({ needsChoice: true, intent: resolved.intent, chips: resolved.chips });
  }

  // Multi-target implement is a strategy ask.
  const intent = resolved.intent === 'strategy' || resolved.targets.length > 1 ? 'strategy' : resolved.intent;
  if (intent === 'strategy') {
    const thread = createThread({ kind: 'strategy', title: input.slice(0, 80) });
    void startStrategyThread(thread, resolved.targets, { text: input, token: session.token, model: selectedModel }).catch(
      (err) => {
        console.error(`[threads] strategy #${thread.id} threw:`, err instanceof Error ? err.message : err);
      }
    );
    return NextResponse.json({ ok: true, threadId: thread.id }, { status: 202 });
  }

  // Single-target implement: needs a concrete issue — #ref precise, otherwise
  // hand-select (chips with fuzzy search come from the client over /api/issues).
  const [owner, repo] = resolved.targets[0]?.split('/') ?? [];
  const num = resolved.issueNumbers[0];
  const issue = owner && repo && num != null ? getIssueByGithub(owner, repo, num) : null;
  if (!issue) {
    return NextResponse.json({
      needsChoice: true,
      intent: 'implement',
      chips: [
        {
          kind: 'issue-search',
          label: `Work on an existing item in ${resolved.targets[0] ?? 'this repo'}, or start something new`,
          options: [],
          repos: resolved.targets,
        },
      ],
    });
  }
  if (!canDevelop(issue)) {
    return NextResponse.json({ error: `issue is '${issue.state}' and cannot be worked` }, { status: 409 });
  }
  const thread = createThread({ kind: 'work', title: input.slice(0, 80) });
  void startWorkThread(thread, issue.id, { text: input, token: session.token, model: selectedModel }).catch((err) => {
    console.error(`[threads] work thread #${thread.id} threw:`, err instanceof Error ? err.message : err);
  });
  return NextResponse.json({ ok: true, threadId: thread.id }, { status: 202 });
}
