import { NextRequest, NextResponse } from 'next/server';
import { getTopic, updateTopic, type Topic } from '@/lib/store';
import { promoteTopicToIssue } from '@/lib/promote';
import { publishIdeaStatus, publishTopic } from '@/lib/sse';
import { requireMember, UnauthorizedError, ForbiddenError, GithubUnavailableError } from '@/lib/auth';
import type { Issue } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

type Promotion =
  | { ok: true; issue: Issue; url: string; created: boolean }
  | { ok: false; error: string };

// Marks shaping done: the user is happy with "So far: …" and the idea is
// `ready`. Idempotent.
//
// Unified funnel: marking ready also files the GitHub issue (auto-promotion).
// The shaping decision stands even when filing fails (e.g. no service repo
// yet) — the response carries `promotion.ok: false` and re-clicking retries
// without filing a duplicate.
export async function POST(
  req: NextRequest,
  ctx: RouteContext
): Promise<NextResponse<{ topic: Topic; promotion: Promotion } | { error: string }>> {
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
  const existing = getTopic(topicId);
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (existing.status === 'dropped' || existing.status === 'shipped' || existing.status === 'realizing') {
    return NextResponse.json({ error: `topic is ${existing.status}, it cannot go back to ready` }, { status: 400 });
  }
  let topic = existing;
  if (topic.status !== 'ready') {
    topic = updateTopic(topicId, { status: 'ready', readyAt: new Date().toISOString() })!;
    publishTopic(topicId);
  }
  publishIdeaStatus(topicId, 'ready');
  try {
    const result = await promoteTopicToIssue(topic, token);
    const fresh = getTopic(topicId) ?? topic;
    return NextResponse.json({
      topic: fresh,
      promotion: { ok: true, issue: result.issue, url: result.url, created: result.created },
    });
  } catch (err) {
    const fresh = getTopic(topicId) ?? topic;
    return NextResponse.json({
      topic: fresh,
      promotion: { ok: false, error: err instanceof Error ? err.message : String(err) },
    });
  }
}
