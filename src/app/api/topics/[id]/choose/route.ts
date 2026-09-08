import { NextRequest, NextResponse } from 'next/server';
import { chooseIdeaOption, getIdeaMessages, getTopic, updateTopic, type Topic } from '@/lib/store';
import { publishIdeaMessage, publishTopic } from '@/lib/sse';
import { requireMember, UnauthorizedError, ForbiddenError, GithubUnavailableError } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

// One-click Choose on a hub proposal: records the pick on the message and
// rewrites the shaped summary ("So far: …") to the chosen option. The topic
// stays shaping until the user marks it ready (POST .../ready) or realizes
// it (Phase 3).
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
    return NextResponse.json({ error: `topic is ${topic.status}, options are locked` }, { status: 400 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const optionId = typeof body.optionId === 'string' ? body.optionId.trim() : '';
  if (!optionId) return NextResponse.json({ error: 'optionId is required' }, { status: 400 });

  const messages = getIdeaMessages(topicId);
  const holder = [...messages].reverse().find((m) => m.options?.some((o) => o.id === optionId));
  if (!holder) return NextResponse.json({ error: 'unknown optionId' }, { status: 400 });
  const option = holder.options!.find((o) => o.id === optionId)!;
  const picked = chooseIdeaOption(holder.id, optionId);
  if (!picked) return NextResponse.json({ error: 'could not record the pick' }, { status: 400 });
  publishIdeaMessage(topicId, picked);

  const summary = [option.title, option.desc].filter(Boolean).join(' — ');
  const updated = updateTopic(topicId, {
    shapedSummary: summary,
    status: topic.status === 'new' ? 'shaping' : undefined,
  })!;
  publishTopic(topicId);
  return NextResponse.json({ topic: updated });
}
