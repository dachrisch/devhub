import { registerSkill } from './index';
import type { SkillContext, SkillResult } from './types';
import { createTopic, getProjectByName, getProject } from '../store';
import { publishTopic } from '../sse';
import { remember } from '../knowledge';

// Default cockpit behavior for free text: save a cheap native idea (no GitHub
// issue) that can be promoted later. Never files anything on GitHub.
registerSkill(
  {
    id: 'create-topic',
    name: 'Save idea',
    description: 'Save a feature idea as a native topic',
    action: 'topic',
    triggers: ['idea', 'feature idea', 'someday', 'maybe we should'],
    requiredParams: ['title'],
    optionalParams: ['projectName', 'projectId', 'notes', 'area'],
  },
  async (ctx: SkillContext): Promise<SkillResult> => {
    const title =
      (ctx.params.title as string) || (ctx.params.issueTitle as string) || ctx.input.slice(0, 256).trim();
    if (!title) {
      return { success: false, summary: 'Need a title to save the idea (params.title).' };
    }
    let projectId: number | null = null;
    if (typeof ctx.params.projectId === 'number' && Number.isInteger(ctx.params.projectId)) {
      const p = getProject(ctx.params.projectId as number);
      if (p) projectId = p.id;
    } else if (typeof ctx.params.projectName === 'string' && (ctx.params.projectName as string).trim()) {
      const p = getProjectByName((ctx.params.projectName as string).trim());
      if (p) projectId = p.id;
    }
    const notes =
      typeof ctx.params.notes === 'string'
        ? (ctx.params.notes as string)
        : typeof ctx.params.description === 'string'
          ? (ctx.params.description as string)
          : null;
    const area = typeof ctx.params.area === 'string' ? (ctx.params.area as string) : null;
    ctx.onStatus('Saving idea...');
    const topic = createTopic({ title: title.trim(), notes, projectId, area, origin: 'manual' });
    publishTopic(topic.id);
    remember(
      'topic',
      `Saved idea: ${title}${projectId ? ` (project #${projectId})` : ' (inbox)'}`,
      { topicId: topic.id, projectId, title },
      ctx.actionId
    );
    return { success: true, summary: `Idea saved${projectId ? ` for project #${projectId}` : ' in the inbox'}: ${title}`, details: topic };
  }
);
