import { registerSkill } from './index';
import type { SkillContext, SkillResult } from './types';
import { getIssuesByTopic, getTopic } from '../store';
import { canRealize, isRealizeLive, realizeTopic } from '../realize';

// Cockpit entry to one-click Realize (devhub#171 Phase 3): triggers the
// promote → Work → sweep-wait chain in the background and returns
// immediately — the idea page timeline (and Needs input banners) carry the
// progress from there.
registerSkill(
  {
    id: 'realize-idea',
    name: 'Realize idea',
    description: 'Realize a shaped idea hands-off (refine, build, merge, release)',
    action: 'realize-idea',
    triggers: ['realize', 'build my idea', 'make it real'],
    requiredParams: ['topicId'],
    optionalParams: ['command'],
  },
  async (ctx: SkillContext): Promise<SkillResult> => {
    const topicId = Number(ctx.params.topicId);
    if (!Number.isInteger(topicId) || topicId <= 0) {
      return { success: false, summary: 'Need an idea to realize (params.topicId).' };
    }
    const topic = getTopic(topicId);
    if (!topic) return { success: false, summary: `Topic #${topicId} not found.` };
    const decision = canRealize(topic, getIssuesByTopic(topicId), isRealizeLive(topicId));
    if (!decision.ok) return { success: false, summary: `Cannot realize "${topic.title}": ${decision.error}.` };
    if (decision.action === 'done') {
      return { success: true, summary: `"${topic.title}" is already delivered.` };
    }
    const command = typeof ctx.params.command === 'string' ? (ctx.params.command as string) : '';
    void realizeTopic(topicId, ctx.token, { command });
    return {
      success: true,
      summary: `Realizing "${topic.title}" hands-off — watch the idea page; I'll surface Needs input if anything blocks.`,
      details: { topicId, mode: decision.action },
    };
  }
);
