import { registerSkill } from './index';
import type { SkillContext, SkillResult } from './types';
import { getTopic } from '../store';
import { promoteTopicToIssue } from '../promote';
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
    ctx.onStatus(`Promoting "${topic.title}"...`);
    try {
      const result = await promoteTopicToIssue(topic, ctx.token, {
        title: typeof ctx.params.title === 'string' ? (ctx.params.title as string) : undefined,
        body: typeof ctx.params.body === 'string' ? (ctx.params.body as string) : undefined,
      });
      remember(
        'promote',
        `Promoted "${topic.title}" to ${result.url}`,
        { topicId: topic.id, issueNumber: result.issue.number, url: result.url },
        ctx.actionId
      );
      return {
        success: true,
        summary: result.created ? `Promoted to ${result.url}` : `Already promoted: ${result.url}`,
        details: { number: result.issue.number, htmlUrl: result.url },
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { success: false, summary: reason };
    }
  }
);
