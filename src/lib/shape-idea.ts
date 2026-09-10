import {
  appendIdeaMessage,
  getIdeaMessages,
  getIssuesByProject,
  getProject,
  getTopic,
  markTopicShaping,
  updateTopic,
} from './store';
import { ENV } from './env';
import {
  getAvailableModels,
  resolveModels,
  runDevelop,
  sanitizeModels,
  type IdeaContext,
  type OpencodeModel,
} from './opencode';
import { publishIdeaMessage, publishIdeaStatus, publishTopic } from './sse';
import type { IdeaMessage, IdeaOption, Topic } from './types';

// Options skill core (devhub#171 Phase 2): prompt = project config + open
// issues + idea thread → `{summary, options[3-5], question}`. Uses the short
// poll budget like refinement (OPENCODE_REFINEMENT_POLL_TIMEOUT_MS).

export interface ShapeResult {
  summary: string;
  options: IdeaOption[];
  question: string;
}

// Statuses that may still be shaped. A topic that already moved to
// realizing/shipped/dropped never gets another shaping round.
const SHAPABLE = new Set(['new', 'shaping', 'ready']);

// One shaping session per topic; a reply posted while a round is live must
// not spawn a duplicate session (same rule as liveRefinementRuns).
const liveShapingRuns = new Set<number>();

export function isShapingLive(topicId: number): boolean {
  return liveShapingRuns.has(topicId);
}

export function buildShapePrompt(topic: Topic, messages: IdeaMessage[]): string {
  const project = topic.projectId != null ? getProject(topic.projectId) : null;
  const issues = topic.projectId != null ? getIssuesByProject(topic.projectId).slice(0, 10) : [];
  const openList =
    issues.map((i) => `#${i.number} ${i.title} [${i.state}]`).join('\n') || '(no tracked issues)';
  const thread =
    messages
      .map((m) => {
        const opts =
          m.options && m.options.length > 0
            ? `\nOptions offered: ${m.options.map((o) => `${o.id}: ${o.title} — ${o.desc}`).join(' | ')}${m.chosenOption ? `\nUser chose: ${m.chosenOption}` : ''}`
            : '';
        return `${m.role.toUpperCase()}: ${m.body}${opts}`;
      })
      .join('\n\n') || '(empty thread)';
  return [
    `You are shaping an idea for the project "${project?.name ?? 'Inbox'}".`,
    `Project config: ${JSON.stringify(project?.config ?? {})}`,
    ``,
    `Idea title: ${topic.title}`,
    topic.notes ? `Idea notes: ${topic.notes}` : null,
    topic.shapedSummary ? `Current shaped summary: ${topic.shapedSummary}` : null,
    ``,
    `Open/tracked work (do not propose duplicates):`,
    openList,
    ``,
    `Conversation so far:`,
    thread,
    ``,
    `Reply with EXACTLY ONE JSON object (no markdown fences):`,
    `{"summary": "one-paragraph shaped restatement of the idea so far", "options": [{"id": "opt-1", "title": "short label", "desc": "1-2 sentences", "tradeoff": "main cost (optional)"}, ... 3 to 5 options], "question": "one follow-up question for the user"}`,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

// Derives the idea's shaping hand-off from data that already exists (no new
// schema): the topic's rolling shaped summary, plus whichever options-bearing
// message is most recent (chosen/chosen_option lives on that same row — see
// chooseIdeaOption in store.ts). Returns null when the idea never completed
// a shaping round (buildDevelopPrompt then omits the section entirely).
export function buildIdeaContext(topic: Topic, messages: IdeaMessage[]): IdeaContext | null {
  if (!topic.shapedSummary) return null;
  const withOptions = [...messages].reverse().find((m) => m.options && m.options.length > 0);
  if (!withOptions?.options) return { summary: topic.shapedSummary, considered: [] };
  return {
    summary: topic.shapedSummary,
    considered: withOptions.options.map((o) => ({
      title: o.title,
      desc: o.desc,
      tradeoff: o.tradeoff ?? undefined,
      chosen: o.id === withOptions.chosenOption,
    })),
  };
}

function extractJsonBlock(raw: string): string {
  const withoutFences = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/g, '')
    .trim();
  if (withoutFences.startsWith('{')) {
    try {
      JSON.parse(withoutFences);
      return withoutFences;
    } catch {
      // fall through to brace matching below
    }
  }
  const start = withoutFences.indexOf('{');
  const end = withoutFences.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return withoutFences.slice(start, end + 1);
  }
  return raw;
}

export function parseShapeResult(text: string): ShapeResult {
  const cleaned = extractJsonBlock(text);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    throw new Error('shape-idea returned unparsable output');
  }
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  const question = typeof parsed.question === 'string' ? parsed.question.trim() : '';
  const rawOptions = Array.isArray(parsed.options) ? parsed.options : [];
  if (!summary) throw new Error('shape-idea returned no summary');
  if (rawOptions.length === 0) throw new Error('shape-idea returned no usable options');
  const options: IdeaOption[] = rawOptions.slice(0, 5).map((o, i) => {
    const rec = (o ?? {}) as Record<string, unknown>;
    const title = typeof rec.title === 'string' ? rec.title.trim() : '';
    if (!title) throw new Error('shape-idea returned an option without a title');
    return {
      id: typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : `opt-${i + 1}`,
      title,
      desc: typeof rec.desc === 'string' ? rec.desc : '',
      tradeoff: typeof rec.tradeoff === 'string' ? rec.tradeoff : null,
    };
  });
  return { summary, options, question };
}

// Runs one shaping round for a topic: prompt → opencode → summary + options
// message. Fire-and-forget (same pattern as startDevelop); the idea page
// learns the result via `idea-message`/`idea-status` SSE. Never throws —
// failures land as an assistant message so the user can reply to retry.
export async function runShapingRound(
  topicId: number,
  opts: { selectedModel?: OpencodeModel | null } = {}
): Promise<IdeaMessage | null> {
  const topic = getTopic(topicId);
  if (!topic || !SHAPABLE.has(topic.status)) return null;
  if (liveShapingRuns.has(topicId)) return null;
  liveShapingRuns.add(topicId);
  try {
    if (topic.status === 'new' && markTopicShaping(topicId)) {
      publishTopic(topicId);
      publishIdeaStatus(topicId, 'shaping');
    }
    const messages = getIdeaMessages(topicId);
    const fresh = getTopic(topicId) ?? topic;
    const prompt = buildShapePrompt(fresh, messages);
    const models = sanitizeModels(resolveModels(opts.selectedModel ?? null), await getAvailableModels());
    const text = await runDevelop(prompt, () => {}, models, undefined, ENV.opencodeRefinementPollTimeoutMs);
    const result = parseShapeResult(text);
    updateTopic(topicId, { shapedSummary: result.summary });
    const body = result.question ? `${result.summary}\n\n${result.question}` : result.summary;
    const assistant = appendIdeaMessage(topicId, 'assistant', body, result.options);
    publishIdeaMessage(topicId, assistant);
    publishTopic(topicId);
    return assistant;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const fallback = appendIdeaMessage(
      topicId,
      'assistant',
      `Shaping hiccup: ${reason} — reply below and I'll try again.`
    );
    publishIdeaMessage(topicId, fallback);
    publishTopic(topicId);
    return fallback;
  } finally {
    liveShapingRuns.delete(topicId);
  }
}
