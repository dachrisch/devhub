import { runDevelop, type OpencodeEvent, type OpencodeModel } from './opencode';
import type { ActionType } from './skills/types';
import { getRouterLearnings } from './learning';

export interface ActionIntent {
  action: ActionType | 'unknown';
  confidence: number;
  params: Record<string, unknown>;
}

const ROUTER_PROMPT = `You are a command classifier for DevHub, a development cockpit.

The user can do 8 things:
- launch: Create something new and put it live (new service, new site, new worker)
- fix: Resolve a problem and open a PR (bugs, issues, errors)
- create: File a new GitHub issue (create issue, file bug, new issue in <repo>)
- write: Create content and share it (blog posts, social media, tweets)
- show: See what's running, what's ready, what's next (status, list, query)
- topic: Save a feature idea without filing a GitHub issue yet (idea for <project>, feature idea)
- suggest: Propose the next feature for a project (suggest, what's next for <project>)
- promote: Bring a saved idea to the board as a real GitHub issue (promote topic <id>)

Classify the user's input into one of these 8 actions.

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "action": "<launch|fix|create|write|show|topic|suggest|promote|unknown>",
  "confidence": <0.0 to 1.0>,
  "params": { extracted parameters }
}

Rules:
- If the input clearly matches an action, set confidence > 0.8
- If ambiguous, set confidence < 0.5 and action "unknown"
- Extract key parameters: name, framework, host, issueId, topic, repo, owner, issueTitle, description, projectName, projectId, topicId, title, notes, area, etc.
- "create" needs params.repo + params.issueTitle (params.owner optional, params.description optional)
- "topic" needs params.title (params.projectName or params.projectId optional, params.notes optional) — never file a GitHub issue for it
- "suggest" needs params.projectName or params.projectId
- "promote" needs params.topicId
- "unknown" action for unrecognized inputs. NEVER silently map free text to "topic": only explicit idea-like input is "topic".
`;

export function buildRouterPrompt(userInput: string): string {
  // Self-learning: past teach-by-rerun corrections bias the next
  // classification. Best-effort — recall never throws, and an empty block
  // leaves the prompt identical to the ungrounded version.
  let learnings = '';
  try {
    learnings = getRouterLearnings(userInput);
  } catch {
    learnings = '';
  }
  const grounding = learnings ? `\n${learnings}\n` : '';
  return `${ROUTER_PROMPT}${grounding}\nUser input: ${userInput}`;
}

export function parseIntent(raw: string): ActionIntent {
  // Models routinely ignore the "no markdown" rule and wrap the JSON in
  // ```json fences or prepend chatter (Action #3: confidence 0.85 lost to a
  // fence). Extract the first {...} block before parsing; fall back to the
  // raw string so plain JSON keeps working.
  const cleaned = extractJsonBlock(raw);
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const action = typeof parsed.action === 'string' ? parsed.action : 'unknown';
    const validActions: string[] = ['launch', 'fix', 'create', 'write', 'show', 'topic', 'suggest', 'promote'];
    return {
      action: validActions.includes(action) ? action as ActionType : 'unknown',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      params: typeof parsed.params === 'object' && parsed.params !== null
        ? (parsed.params as Record<string, unknown>)
        : {},
    };
  } catch {
    return { action: 'unknown', confidence: 0, params: {} };
  }
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

export async function classifyInput(
  input: string,
  models: OpencodeModel[],
  onEvent: (event: OpencodeEvent) => void
): Promise<ActionIntent> {
  const prompt = buildRouterPrompt(input);
  const text = await runDevelop(prompt, onEvent, models);
  return parseIntent(text);
}
