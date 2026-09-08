import { NextRequest, NextResponse } from 'next/server';
import { assignIssue, getIssueByGithub, getProject, getTopic, refreshTopicStatus, updateTopic, upsertIssue } from '@/lib/store';
import { publishIssue, publishTopic } from '@/lib/sse';
import { createGithubIssue } from '@/lib/github';
import { requireMember, UnauthorizedError, ForbiddenError, GithubUnavailableError } from '@/lib/auth';
import type { Issue } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Promote a topic idea to a real GitHub issue (devhub#167). Always creates the
// issue (keeps the label/comment mirror) and links it back to the topic.
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
  const project = topic.projectId != null ? getProject(topic.projectId) : null;
  const owner = project?.serviceRepoOwner;
  const repo = project?.serviceRepoName;
  if (!owner || !repo) {
    return NextResponse.json({ error: 'topic has no service repo (assign it to a project first)' }, { status: 400 });
  }
  const body = (await req.json().catch(() => ({}))) as { title?: unknown; body?: unknown };
  const title = (typeof body.title === 'string' && body.title.trim()) || topic.title;
  const issueBody =
    (typeof body.body === 'string' && body.body) ||
    [topic.notes, topic.area ? `Area: ${topic.area}` : null].filter(Boolean).join('\n\n') ||
    null;
  try {
    const created = await createGithubIssue(owner, repo, title, issueBody, token);
    const stored = upsertIssue({
      githubIssueId: 0,
      owner,
      repo,
      number: created.number,
      title,
      body: issueBody,
      htmlUrl: created.htmlUrl,
    });
    const withLinks = assignIssue(stored.id, { projectId: project!.id, topicId: topic.id });
    publishIssue(withLinks ?? getIssueByGithub(owner, repo, created.number)!);
    updateTopic(topic.id, { status: 'realizing' });
    refreshTopicStatus(topic.id);
    publishTopic(topic.id);
    return NextResponse.json({ issue: withLinks ?? stored, url: created.htmlUrl });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
