import { NextRequest, NextResponse } from 'next/server';
import { getIssuesByTopic, getTopic, refreshTopicStatus, type Topic } from '@/lib/store';
import { publishTopic } from '@/lib/sse';
import { canRealize, isRealizeLive, realizeTopic } from '@/lib/realize';
import { requireMember, UnauthorizedError, ForbiddenError, GithubUnavailableError } from '@/lib/auth';
import type { OpencodeModel } from '@/lib/opencode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

// One-click Realize (devhub#171 Phase 3): single entry chaining promote →
// startWork → sweep wait. Returns 202 immediately; progress streams via the
// existing `issue`/`run`/`topic` SSE events and the idea page timeline.
export async function POST(
  req: NextRequest,
  ctx: RouteContext
): Promise<NextResponse<{ topic: Topic; mode: string } | { error: string }>> {
  let token: string;
  try {
    token = (await requireMember(req)).token;
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    if (err instanceof GithubUnavailableError) return NextResponse.json({ error: 'github unavailable, try again' }, { status: 502 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }
  const { id } = await ctx.params;
  const topicId = Number(id);
  if (!Number.isInteger(topicId) || topicId <= 0) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const topic = getTopic(topicId);
  if (!topic) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const decision = canRealize(topic, getIssuesByTopic(topicId), isRealizeLive(topicId));
  if (!decision.ok) {
    return NextResponse.json({ error: decision.error }, { status: decision.status });
  }
  if (decision.action === 'done') {
    const shipped = refreshTopicStatus(topicId) ?? getTopic(topicId)!;
    publishTopic(topicId);
    return NextResponse.json({ topic: shipped, mode: 'done' });
  }

  const body = (await req.json().catch(() => ({}))) as {
    command?: unknown;
    modelId?: unknown;
    providerID?: unknown;
  };
  const command = typeof body.command === 'string' ? body.command : '';
  const modelId = typeof body.modelId === 'string' && body.modelId ? body.modelId : null;
  const providerID = typeof body.providerID === 'string' && body.providerID ? body.providerID : null;
  const selectedModel: OpencodeModel | null = modelId ? { id: modelId, providerID: providerID ?? 'opencode' } : null;

  void realizeTopic(topicId, token, { command, selectedModel }).then((outcome) => {
    // Terminal observability for operators tailing the server log; the UI
    // follows the same transitions over SSE.
    if (outcome.mode !== 'delivered' && outcome.mode !== 'needs-input') {
      console.log(`[realize] topic #${topicId} ended: ${outcome.mode}`);
    }
  });
  return NextResponse.json({ topic, mode: decision.action }, { status: 202 });
}
