import { NextRequest, NextResponse } from 'next/server';
import { assignIssue, getIssue, getProject, getTopic, refreshTopicStatus, type Issue } from '@/lib/store';
import { publishIssue, publishProject, publishTopic } from '@/lib/sse';
import { requireMember, UnauthorizedError, ForbiddenError, GithubUnavailableError } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Metadata-only re-assignment (project/topic). Board stage moves stay in
// /api/issues/[id]/transition; this never touches state.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse<{ issue: Issue } | { error: string }>> {
  try {
    await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    if (err instanceof GithubUnavailableError) return NextResponse.json({ error: 'github unavailable, try again' }, { status: 502 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }
  const { id } = await params;
  const issueId = Number(id);
  if (!Number.isInteger(issueId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const issue = getIssue(issueId);
  if (!issue) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const assignment: { projectId?: number | null; topicId?: number | null } = {};
  if (body.projectId !== undefined) {
    if (body.projectId === null) {
      assignment.projectId = null;
    } else {
      const projectId = Number(body.projectId);
      if (!Number.isInteger(projectId) || !getProject(projectId)) {
        return NextResponse.json({ error: 'unknown projectId' }, { status: 400 });
      }
      assignment.projectId = projectId;
    }
  }
  if (body.topicId !== undefined) {
    if (body.topicId === null) {
      assignment.topicId = null;
    } else {
      const topicId = Number(body.topicId);
      if (!Number.isInteger(topicId) || !getTopic(topicId)) {
        return NextResponse.json({ error: 'unknown topicId' }, { status: 400 });
      }
      assignment.topicId = topicId;
    }
  }
  if (assignment.projectId === undefined && assignment.topicId === undefined) {
    return NextResponse.json({ error: 'nothing to assign' }, { status: 400 });
  }

  const updated = assignIssue(issueId, assignment);
  const newTopicId = assignment.topicId;
  const oldTopicId = issue.topicId ?? null;
  if (newTopicId !== undefined && newTopicId !== null) refreshTopicStatus(newTopicId);
  if (oldTopicId !== null && newTopicId !== oldTopicId) refreshTopicStatus(oldTopicId);
  // The board card moved projects/topics: push the issue itself plus
  // id-notifications so project cards and the inbox re-fetch.
  if (updated) publishIssue(updated);
  const newProjectId = assignment.projectId;
  const oldProjectId = issue.projectId ?? null;
  if (newProjectId !== undefined && newProjectId !== null && newProjectId !== oldProjectId) {
    publishProject(newProjectId);
  }
  if (oldProjectId !== null && newProjectId !== oldProjectId) publishProject(oldProjectId);
  if (newTopicId !== undefined && newTopicId !== null && newTopicId !== oldTopicId) publishTopic(newTopicId);
  if (oldTopicId !== null && newTopicId !== oldTopicId) publishTopic(oldTopicId);
  return NextResponse.json({ issue: updated! });
}
