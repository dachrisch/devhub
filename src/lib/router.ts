import { loadSkills } from './skills';
import { runDevelop, type OpencodeEvent, type OpencodeModel } from './opencode';
import type { ActionType } from './skills/types';

export interface ActionIntent {
  action: ActionType | 'unknown';
  confidence: number;
  params: Record<string, unknown>;
}

const ROUTER_PROMPT = `You are a command classifier for DevHub, a development cockpit.

The user can do 4 things:
- launch: Create something new and put it live (new service, new site, new worker)
- fix: Resolve a problem and open a PR (bugs, issues, errors)
- write: Create content and share it (blog posts, social media, tweets)
- show: See what's running, what's ready, what's next (status, list, query)

Classify the user's input into one of these 4 actions.

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "action": "<launch|fix|write|show|unknown>",
  "confidence": <0.0 to 1.0>,
  "params": { extracted parameters }
}

Rules:
- If the input clearly matches an action, set confidence > 0.8
- If ambiguous, set confidence < 0.5 and action "unknown"
- Extract key parameters: name, framework, host, issueId, topic, etc.
- "unknown" action for unrecognized inputs

User input: `;

export function buildRouterPrompt(userInput: string): string {
  return ROUTER_PROMPT + userInput;
}

export function parseIntent(raw: string): ActionIntent {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const action = typeof parsed.action === 'string' ? parsed.action : 'unknown';
    const validActions: string[] = ['launch', 'fix', 'write', 'show'];
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

export async function classifyInput(
  input: string,
  models: OpencodeModel[],
  onEvent: (event: OpencodeEvent) => void
): Promise<ActionIntent> {
  const prompt = buildRouterPrompt(input);
  const text = await runDevelop(prompt, onEvent, models);
  return parseIntent(text);
}
