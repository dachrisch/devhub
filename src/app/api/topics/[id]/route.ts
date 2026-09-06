import { NextRequest, NextResponse } from 'next/server';
import { deleteTopic, getProject, getTopic, refreshTopicStatus, updateTopic, type Topic } from '@/lib/store';
import { getSession, requireMember, UnauthorizedError, ForbiddenError, GithubUnavailableError } from '@/lib/auth';
import { TOPIC_STATUSES, type TopicStatus } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse<{ topic: Topic } | { error: string }>> {
  if (!getSession(req)) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  const { id } = await ctx.params;
  const topicId = parseId(id);
  if (!topicId) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const topic = getTopic(topicId);
  if (!topic) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ topic });
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse<{ topic: Topic } | { error: string }>> {
  try {
    await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    if (err instanceof GithubUnavailableError) return NextResponse.json({ error: 'github unavailable, try again' }, { status: 502 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }
  const { id } = await ctx.params;
  const topicId = parseId(id);
  if (!topicId) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const existing = getTopic(topicId);
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (body.title !== undefined) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return NextResponse.json({ error: 'title cannot be empty' }, { status: 400 });
    patch.title = title;
  }
  if (body.notes !== undefined) patch.notes = body.notes === null ? null : String(body.notes);
  if (body.area !== undefined) patch.area = body.area === null ? null : String(body.area).trim() || null;
  if (body.projectId !== undefined) {
    if (body.projectId === null) {
      patch.projectId = null;
    } else {
      const projectId = Number(body.projectId);
      if (!Number.isInteger(projectId) || !getProject(projectId)) {
        return NextResponse.json({ error: 'unknown projectId' }, { status: 400 });
      }
      patch.projectId = projectId;
    }
  }
  if (body.status !== undefined) {
    if (!(TOPIC_STATUSES as readonly string[]).includes(String(body.status))) {
      return NextResponse.json({ error: 'invalid status' }, { status: 400 });
    }
    patch.status = body.status as TopicStatus;
  }

  // An explicit status change (e.g. drop) wins; only auto-derive otherwise.
  const topic = updateTopic(topicId, patch)!;
  const refreshed = patch.status !== undefined ? topic : (refreshTopicStatus(topicId) ?? topic);
  return NextResponse.json({ topic: refreshed });
}

export async function DELETE(req: NextRequest, ctx: RouteContext): Promise<NextResponse<{ ok: boolean } | { error: string }>> {
  try {
    await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    if (err instanceof GithubUnavailableError) return NextResponse.json({ error: 'github unavailable, try again' }, { status: 502 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }
  const { id } = await ctx.params;
  const topicId = parseId(id);
  if (!topicId) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  if (!getTopic(topicId)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  deleteTopic(topicId);
  return NextResponse.json({ ok: true });
}
