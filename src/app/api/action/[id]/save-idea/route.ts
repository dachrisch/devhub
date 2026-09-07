import { NextRequest, NextResponse } from 'next/server';
import { createTopic, getAction } from '@/lib/store';
import { publishTopic } from '@/lib/sse';
import { requireMember, UnauthorizedError, ForbiddenError, GithubUnavailableError } from '@/lib/auth';
import type { Topic } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// One-click "save as idea" for failed/low-confidence cockpit actions
// (devhub#167): explicit user opt-in, never silent rerouting.
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
  const actionId = Number(id);
  if (!Number.isInteger(actionId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const action = getAction(actionId);
  if (!action) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { projectId?: unknown; title?: unknown };
  const projectId =
    typeof body.projectId === 'number' && Number.isInteger(body.projectId) && body.projectId > 0
      ? body.projectId
      : null;
  const title =
    (typeof body.title === 'string' && body.title.trim()) || action.input.slice(0, 256).trim() || `Idea from action #${actionId}`;
  const topic = createTopic({ title, notes: action.input, projectId, origin: 'manual' });
  publishTopic(topic.id);
  return NextResponse.json({ topic });
}
