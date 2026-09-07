import { registerSkill } from './index';
import type { SkillContext, SkillResult } from './types';
import { getProject, getProjectByName } from '../store';
import { suggestFeatureForProject } from '../suggest';
import { remember } from '../knowledge';

// Suggests the next feature for a project and saves it as a one-click
// suggested topic. Core lives in lib/suggest.ts (shared with the
// POST /api/projects/[id]/suggest button).
registerSkill(
  {
    id: 'suggest-feature',
    name: 'Suggest feature',
    description: 'Propose the next feature for a project',
    action: 'suggest',
    triggers: ['suggest', 'what is next', 'next feature'],
    requiredParams: [],
    optionalParams: ['projectName', 'projectId'],
  },
  async (ctx: SkillContext): Promise<SkillResult> => {
    let projectId: number | null = null;
    if (typeof ctx.params.projectId === 'number' && Number.isInteger(ctx.params.projectId)) {
      const p = getProject(ctx.params.projectId as number);
      if (p) projectId = p.id;
    } else if (typeof ctx.params.projectName === 'string' && (ctx.params.projectName as string).trim()) {
      const p = getProjectByName((ctx.params.projectName as string).trim());
      if (p) projectId = p.id;
    }
    if (projectId == null) {
      return { success: false, summary: 'Need a project to suggest for (params.projectName or params.projectId).' };
    }
    ctx.onStatus('Suggesting the next feature...');
    const sessionIds: string[] = [];
    try {
      const topic = await suggestFeatureForProject(projectId, {
        models: ctx.models,
        onEvent: (e) => ctx.onEvent(e),
        onStartSession: (sid) => {
          sessionIds.push(sid);
          ctx.onStartSession(sid);
        },
      });
      remember('suggest', `Suggested: ${topic.title}`, { topicId: topic.id, projectId }, ctx.actionId);
      return { success: true, summary: `Suggested: ${topic.title}`, details: topic, sessionIds };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { success: false, summary: reason };
    }
  }
);
