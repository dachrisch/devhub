import { NextRequest, NextResponse } from 'next/server';
import { getTopic, updateTopic, type Topic } from '@/lib/store';
import { publishIdeaStatus, publishTopic } from '@/lib/sse';
import { requireMember, UnauthorizedError, ForbiddenError, GithubUnavailableError } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

// Marks shaping done: the user is happy with "So far: …" and the idea is
// `ready` for one-click Realize (Phase 3). Idempotent.
export async function POST(
  req: NextRequest,
  ctx: RouteContext
): Promise<NextResponse<{ topic: Topic } | { error: string }>> {
  try {
    await requireMember(req);
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
  if (topic.status === 'dropped' || topic.status === 'shipped' || topic.status === 'realizing') {
    return NextResponse.json({ error: `topic is ${topic.status}, it cannot go back to ready` }, { status: 400 });
  }
  if (topic.status === 'ready') return NextResponse.json({ topic });
  const updated = updateTopic(topicId, { status: 'ready', readyAt: new Date().toISOString() })!;
  publishTopic(topicId);
  publishIdeaStatus(topicId, 'ready');
  return NextResponse.json({ topic: updated });
}
