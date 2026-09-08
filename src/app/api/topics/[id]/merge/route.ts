import { NextRequest, NextResponse } from 'next/server';
import { getTopic, mergeTopic, type Topic } from '@/lib/store';
import { publishTopic } from '@/lib/sse';
import { requireMember, UnauthorizedError, ForbiddenError, GithubUnavailableError } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Link-and-archive for duplicates (devhub#171 Phase 1): POST { intoId } marks
// the topic `dropped` with `merged_into_topic_id` pointing at the winner.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<{ topic: Topic } | { error: string }>> {
  try {
    await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    if (err instanceof GithubUnavailableError) return NextResponse.json({ error: 'github unavailable, try again' }, { status: 502 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }
  const { id } = await params;
  const topicId = Number(id);
  if (!Number.isInteger(topicId) || topicId <= 0) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  if (!getTopic(topicId)) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { intoId?: unknown };
  const intoId = Number(body.intoId);
  if (!Number.isInteger(intoId) || intoId <= 0) return NextResponse.json({ error: 'intoId is required' }, { status: 400 });
  if (intoId === topicId) return NextResponse.json({ error: 'cannot merge an idea into itself' }, { status: 400 });
  if (!getTopic(intoId)) return NextResponse.json({ error: 'unknown intoId' }, { status: 400 });

  const merged = mergeTopic(topicId, intoId);
  if (!merged) return NextResponse.json({ error: 'merge failed' }, { status: 400 });
  publishTopic(topicId);
  publishTopic(intoId);
  return NextResponse.json({ topic: merged });
}
