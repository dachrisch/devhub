import { NextRequest, NextResponse } from 'next/server';
import { getTopic } from '@/lib/store';
import { promoteTopicToIssue } from '@/lib/promote';
import { requireMember, UnauthorizedError, ForbiddenError, GithubUnavailableError } from '@/lib/auth';
import type { Issue } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Promote a topic idea to a real GitHub issue (devhub#167). Idempotent: a
// topic that already has a linked issue returns it instead of filing a
// duplicate — pass `{ force: true }` for a deliberate follow-up issue.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<{ issue: Issue; url: string } | { error: string }>> {
  let token: string;
  try {
    token = (await requireMember(req)).token;
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    if (err instanceof GithubUnavailableError) return NextResponse.json({ error: 'github unavailable, try again' }, { status: 502 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }
  const { id } = await params;
  const topicId = Number(id);
  if (!Number.isInteger(topicId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const topic = getTopic(topicId);
  if (!topic) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { title?: unknown; body?: unknown; force?: unknown };
  try {
    const result = await promoteTopicToIssue(topic, token, {
      title: typeof body.title === 'string' && body.title.trim() ? body.title : undefined,
      body: typeof body.body === 'string' && body.body ? body.body : undefined,
      createNew: body.force === true,
    });
    return NextResponse.json({ issue: result.issue, url: result.url });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
