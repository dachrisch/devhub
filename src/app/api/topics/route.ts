import { NextRequest, NextResponse } from 'next/server';
import { createTopic, getProject, getTopics, type Topic } from '@/lib/store';
import { publishTopic } from '@/lib/sse';
import { getSession, requireMember, UnauthorizedError, ForbiddenError, GithubUnavailableError } from '@/lib/auth';
import { normalizeTopicStatus } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse<{ topics: Topic[] } | { error: string }>> {
  if (!getSession(req)) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  const url = new URL(req.url);
  const projectIdParam = url.searchParams.get('projectId');
  const statusParam = url.searchParams.get('status');
  const areaParam = url.searchParams.get('area');

  const filter: Parameters<typeof getTopics>[0] = {};
  if (projectIdParam === 'null') filter.projectId = null;
  else if (projectIdParam) {
    const projectId = Number(projectIdParam);
    if (!Number.isInteger(projectId)) return NextResponse.json({ error: 'invalid projectId' }, { status: 400 });
    filter.projectId = projectId;
  }
  if (statusParam) {
    const normalized = normalizeTopicStatus(statusParam);
    if (!normalized) {
      return NextResponse.json({ error: 'invalid status' }, { status: 400 });
    }
    filter.status = normalized;
  }
  if (areaParam) filter.area = areaParam;
  return NextResponse.json({ topics: getTopics(filter) });
}

export async function POST(req: NextRequest): Promise<NextResponse<{ topic: Topic } | { error: string }>> {
  try {
    await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    if (err instanceof GithubUnavailableError) return NextResponse.json({ error: 'github unavailable, try again' }, { status: 502 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return NextResponse.json({ error: 'title is required' }, { status: 400 });

  let projectId: number | null = null;
  if (body.projectId !== undefined && body.projectId !== null) {
    projectId = Number(body.projectId);
    if (!Number.isInteger(projectId) || !getProject(projectId)) {
      return NextResponse.json({ error: 'unknown projectId' }, { status: 400 });
    }
  }
  const origin = body.origin === 'suggested' ? 'suggested' : 'manual';
  const shapedSummary =
    typeof body.shapedSummary === 'string' && body.shapedSummary.trim()
      ? body.shapedSummary.trim()
      : typeof body.shaped_summary === 'string' && body.shaped_summary.trim()
        ? (body.shaped_summary as string).trim()
        : null;

  const topic = createTopic({
    title,
    notes: typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null,
    shapedSummary,
    projectId,
    area: typeof body.area === 'string' && body.area.trim() ? body.area.trim() : null,
    origin,
  });
  publishTopic(topic.id);
  return NextResponse.json({ topic });
}
