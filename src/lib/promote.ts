import {
  assignIssue,
  getIssueByGithub,
  getIssuesByTopic,
  getProject,
  refreshTopicStatus,
  updateTopic,
  upsertIssue,
} from './store';
import { publishIssue, publishTopic } from './sse';
import { createGithubIssue } from './github';
import type { Issue, Topic } from './types';

// Shared promotion core (unified funnel, Phase 2): files a topic idea as a
// real GitHub issue and links it back. Previously triplicated across the
// promote route, the promote-topic skill, and realize's inline copy.
//
// Idempotent unless `createNew` is set: a topic that already has a linked
// issue returns the existing one instead of filing a duplicate (this is what
// makes "mark ready → auto-promote" safe to retry).
export interface PromoteOptions {
  title?: string;
  body?: string | null;
  createNew?: boolean;
}

export interface PromoteResult {
  issue: Issue;
  url: string;
  created: boolean;
}

export function promoteIssueBody(topic: Topic): string | null {
  return (
    [
      topic.notes,
      topic.shapedSummary ? `Shaped: ${topic.shapedSummary}` : null,
      topic.area ? `Area: ${topic.area}` : null,
    ]
      .filter(Boolean)
      .join('\n\n') || null
  );
}

export async function promoteTopicToIssue(
  topic: Topic,
  token: string,
  opts: PromoteOptions = {}
): Promise<PromoteResult> {
  const project = topic.projectId != null ? getProject(topic.projectId) : null;
  const owner = project?.serviceRepoOwner;
  const repo = project?.serviceRepoName;
  if (!owner || !repo) {
    throw new Error('topic has no service repo (assign it to a project first)');
  }
  if (!opts.createNew) {
    const existing = getIssuesByTopic(topic.id);
    if (existing.length > 0) {
      return { issue: existing[0], url: existing[0].htmlUrl, created: false };
    }
  }
  const title = opts.title?.trim() || topic.title;
  const body = opts.body ?? promoteIssueBody(topic);
  const created = await createGithubIssue(owner, repo, title, body, token);
  const stored = upsertIssue({
    githubIssueId: 0,
    owner,
    repo,
    number: created.number,
    title,
    body,
    htmlUrl: created.htmlUrl,
  });
  const withLinks = assignIssue(stored.id, { projectId: project!.id, topicId: topic.id });
  publishIssue(withLinks ?? getIssueByGithub(owner, repo, created.number)!);
  // `realizing` is immediately renormalized by refreshTopicStatus: a fresh
  // backlog issue reads as `ready`, started work as `realizing`.
  updateTopic(topic.id, { status: 'realizing' });
  refreshTopicStatus(topic.id);
  publishTopic(topic.id);
  return { issue: withLinks ?? stored, url: created.htmlUrl, created: true };
}
