import { registerSkill } from './index';
import type { SkillContext, SkillResult } from './types';
import { appendIdeaMessage, getTopic } from '../store';
import { publishIdeaMessage } from '../sse';
import { runShapingRound } from '../shape-idea';

// Cockpit entry to the ideas-first shaping loop (devhub#171 Phase 2): runs
// one shaping round for a topic (project config + thread → summary +
// options). The idea page drives the same core via POST /api/topics (first
// round) and POST /api/topics/[id]/messages (replies).
registerSkill(
  {
    id: 'shape-idea',
    name: 'Shape idea',
    description: 'Propose shaped options for a topic idea',
    action: 'shape-idea',
    triggers: ['shape', 'options for', 'refine the idea'],
    requiredParams: ['topicId'],
    optionalParams: ['message'],
  },
  async (ctx: SkillContext): Promise<SkillResult> => {
    const topicId = Number(ctx.params.topicId);
    if (!Number.isInteger(topicId) || topicId <= 0) {
      return { success: false, summary: 'Need a topic to shape (params.topicId).' };
    }
    const topic = getTopic(topicId);
    if (!topic) return { success: false, summary: `Topic #${topicId} not found.` };
    if (typeof ctx.params.message === 'string' && (ctx.params.message as string).trim()) {
      const userMsg = appendIdeaMessage(topicId, 'user', (ctx.params.message as string).trim());
      publishIdeaMessage(topicId, userMsg);
    }
    ctx.onStatus(`Shaping "${topic.title}"...`);
    const assistant = await runShapingRound(topicId);
    if (!assistant) {
      return { success: false, summary: `Topic #${topicId} can no longer be shaped (status ${topic.status}).` };
    }
    const count = assistant.options?.length ?? 0;
    return {
      success: true,
      summary: `Shaped "${topic.title}" into ${count} option(s).`,
      details: { topicId, messageId: assistant.id, options: assistant.options },
    };
  }
);
