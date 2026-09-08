import { registerSkill } from './index';
import type { SkillContext, SkillResult } from './types';
import { assignIssue, getIssueByGithub, getProject, getTopic, refreshTopicStatus, updateTopic, upsertIssue } from '../store';
import { publishIssue, publishTopic } from '../sse';
import { createGithubIssue } from '../github';
import { remember } from '../knowledge';

// Promotes a native topic to a real GitHub issue (keeps the label/comment
// mirror by always creating the issue; links it back to the topic).
registerSkill(
  {
    id: 'promote-topic',
    name: 'Promote idea',
    description: 'Promote a topic idea to a GitHub issue',
    action: 'promote',
    triggers: ['promote', 'make it an issue', 'bring forward'],
    requiredParams: ['topicId'],
    optionalParams: ['title', 'body'],
  },
  async (ctx: SkillContext): Promise<SkillResult> => {
    const topicId = Number(ctx.params.topicId);
    if (!Number.isInteger(topicId) || topicId <= 0) {
      return { success: false, summary: 'Need a topic to promote (params.topicId).' };
    }
    const topic = getTopic(topicId);
    if (!topic) return { success: false, summary: `Topic #${topicId} not found.` };
    const project = topic.projectId != null ? getProject(topic.projectId) : null;
    const owner = project?.serviceRepoOwner;
    const repo = project?.serviceRepoName;
    if (!owner || !repo) {
      return { success: false, summary: `Topic #${topicId} has no service repo to file into (assign it to a project first).` };
    }
    const title = (typeof ctx.params.title === 'string' && (ctx.params.title as string).trim()) || topic.title;
    const body =
      (typeof ctx.params.body === 'string' && (ctx.params.body as string)) ||
      [topic.notes, topic.area ? `Area: ${topic.area}` : null].filter(Boolean).join('\n\n') ||
      null;
    ctx.onStatus(`Promoting "${topic.title}" to ${owner}/${repo}...`);
    try {
      const created = await createGithubIssue(owner, repo, title, body, ctx.token);
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
      if (withLinks) publishIssue(withLinks);
      else publishIssue(getIssueByGithub(owner, repo, created.number)!);
      const promoted = updateTopic(topic.id, { status: 'realizing' }) ?? topic;
      refreshTopicStatus(topic.id);
      publishTopic(topic.id);
      remember(
        'promote',
        `Promoted "${topic.title}" to ${created.htmlUrl}`,
        { topicId: topic.id, issueNumber: created.number, url: created.htmlUrl },
        ctx.actionId
      );
      return { success: true, summary: `Promoted to ${created.htmlUrl}`, details: { ...created, topic: promoted } };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { success: false, summary: reason };
    }
  }
);
