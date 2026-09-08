import { NextRequest, NextResponse } from 'next/server';
import { appendIdeaMessage, getIdeaMessages, getTopic, type IdeaMessage } from '@/lib/store';
import { publishIdeaMessage, publishTopic } from '@/lib/sse';
import { runShapingRound } from '@/lib/shape-idea';
import { getSession, requireMember, UnauthorizedError, ForbiddenError, GithubUnavailableError } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

// Only topics still being shaped accept replies. Realizing/shipped/dropped
// topics keep their thread read-only.
const REPLYABLE = new Set(['new', 'shaping', 'ready']);

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse<{ messages: IdeaMessage[] } | { error: string }>> {
  if (!getSession(req)) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  const { id } = await ctx.params;
  const topicId = Number(id);
  if (!Number.isInteger(topicId) || topicId <= 0) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  if (!getTopic(topicId)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ messages: getIdeaMessages(topicId) });
}

// Posts a free-text reply ("…or describe it your way") and triggers the next
// shaping round fire-and-forget. Returns 202 immediately; the assistant reply
// lands via `idea-message` SSE.
export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse<{ message: IdeaMessage } | { error: string }>> {
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
  if (!REPLYABLE.has(topic.status)) {
    return NextResponse.json({ error: `topic is ${topic.status}, the thread is read-only` }, { status: 400 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!text) return NextResponse.json({ error: 'body is required' }, { status: 400 });
  const message = appendIdeaMessage(topicId, 'user', text);
  publishIdeaMessage(topicId, message);
  publishTopic(topicId);
  void runShapingRound(topicId);
  return NextResponse.json({ message }, { status: 202 });
}
