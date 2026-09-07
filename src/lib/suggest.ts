import { createTopic, getIssuesByProject, getProject, type Topic } from './store';
import { getAvailableModels, resolveModels, runDevelop, sanitizeModels, type OpencodeEvent, type OpencodeModel } from './opencode';
import { publishTopic } from './sse';

// Shared suggest-feature core (devhub#167 Phase 5): proposes the next feature
// for a project and saves it as a suggested topic. Used by the
// `suggest-feature` cockpit skill and POST /api/projects/[id]/suggest.
export async function suggestFeatureForProject(
  projectId: number,
  opts: {
    models?: OpencodeModel[];
    selectedModel?: OpencodeModel | null;
    onEvent?: (event: OpencodeEvent) => void;
    onStartSession?: (sessionId: string) => void;
  } = {}
): Promise<Topic> {
  const project = getProject(projectId);
  if (!project) throw new Error(`project #${projectId} not found`);
  const models = opts.models ?? sanitizeModels(resolveModels(opts.selectedModel ?? null), await getAvailableModels());
  const issues = getIssuesByProject(project.id).slice(0, 10);
  const openList = issues.map((i) => `#${i.number} ${i.title} [${i.state}]`).join('\n') || '(no tracked issues)';
  const prompt = [
    `You are suggesting the next feature for the project "${project.name}".`,
    `Project config: ${JSON.stringify(project.config ?? {})}`,
    ``,
    `Open/tracked work (do not duplicate):`,
    openList,
    ``,
    `Reply with EXACTLY ONE JSON object (no markdown fences):`,
    `{"title": "short feature title", "notes": "2-3 sentences: why now + acceptance sketch"}`,
  ].join('\n');
  const sessionIds: string[] = [];
  const text = await runDevelop(
    prompt,
    (e) => opts.onEvent?.(e),
    models,
    (sid) => {
      sessionIds.push(sid);
      opts.onStartSession?.(sid);
    }
  );
  const m = text.match(/\{[\s\S]*\}/);
  let title = '';
  let notes: string | null = null;
  if (m) {
    try {
      const parsed = JSON.parse(m[0]) as { title?: unknown; notes?: unknown };
      if (typeof parsed.title === 'string') title = parsed.title.trim();
      if (typeof parsed.notes === 'string') notes = parsed.notes;
    } catch {
      /* fall through to the first-line fallback */
    }
  }
  if (!title) title = text.trim().split('\n')[0]?.slice(0, 120) || `Next feature for ${project.name}`;
  const topic = createTopic({ title, notes, projectId: project.id, origin: 'suggested' });
  publishTopic(topic.id);
  return topic;
}
