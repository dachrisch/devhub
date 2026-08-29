import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { ENV } from './env';
import type { Issue } from './types';

// opencode on code.lehel.xyz uses a real cert in production; only the opt-in
// servyy-test deployment needs TLS verification disabled (mirrors dontforget).
const insecureDispatcher: Dispatcher | undefined =
  process.env.OPENCODE_ALLOW_INSECURE_TLS === 'true' ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;

// Contract confirmed live against code.lehel.xyz (see dontforget's
// opencodeClient.ts for the full verification history):
//   POST /api/session            -> {"data": {"id": "ses_..."}}
//   POST /api/session/:id/prompt -> ack ({"data": {"id": "msg_..."}})
//   GET  /api/session/:id/message -> {"data": [<newest first>]}
//   GET  /api/session/:id/event   -> SSE of live events
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

export interface OpencodeModel {
  id: string;
  providerID: string;
}

export interface OpencodeEvent {
  type?: string;
  kind?: string;
  [key: string]: unknown;
}

// Measured-good free models (dontforget perf test, 2026-08-21). Tried in order;
// a persistently unhealthy model fails over to the next on the same provider.
const MODEL_TIERS: OpencodeModel[] = [
  { id: 'mimo-v2.5-free', providerID: 'opencode' },
  { id: 'big-pickle', providerID: 'opencode' },
];

export function defaultModels(): OpencodeModel[] {
  return MODEL_TIERS;
}

// Best-effort model discovery at startup. If the listing endpoint path differs
// or is unavailable, fall back to the pinned known-good tiers (open item #3 in
// the plan). Never throws.
export async function discoverModels(): Promise<OpencodeModel[]> {
  const candidates = [
    `${ENV.opencodeBaseUrl}/api/model`,
    `${ENV.opencodeBaseUrl}/api/config`,
    `${ENV.opencodeBaseUrl}/api/model/list`,
  ];
  for (const url of candidates) {
    try {
      const res = await undiciFetch(url, {
        headers: { 'X-Api-Key': ENV.opencodeApiKey },
        dispatcher: insecureDispatcher,
      });
      if (!res.ok) continue;
      const json = (await res.json()) as unknown;
      const models = extractFreeModels(json);
      if (models.length > 0) return models;
    } catch {
      // try next candidate
    }
  }
  return MODEL_TIERS;
}

function extractFreeModels(json: unknown): OpencodeModel[] {
  const list = resolveModelList(json);
  if (!list) return [];
  return list
    .filter((m) => /free/i.test(`${m.id ?? ''}`) || /free/i.test(`${m.providerID ?? ''}`))
    .map((m) => ({ id: String(m.id), providerID: String(m.providerID) }));
}

function resolveModelList(json: unknown): Array<{ id?: string; providerID?: string }> | null {
  if (Array.isArray(json)) return json as Array<{ id?: string; providerID?: string }>;
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    if (Array.isArray(obj.data)) return obj.data as Array<{ id?: string; providerID?: string }>;
    if (Array.isArray(obj.models)) return obj.models as Array<{ id?: string; providerID?: string }>;
  }
  return null;
}

export async function createSession(model: OpencodeModel): Promise<string> {
  const res = await undiciFetch(`${ENV.opencodeBaseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': ENV.opencodeApiKey },
    body: JSON.stringify({ model }),
    dispatcher: insecureDispatcher,
  });
  if (!res.ok) {
    throw new Error(`opencode session create failed: ${res.status}`);
  }
  const data = (await res.json()) as { data: { id: string } };
  return data.data.id;
}

export async function sendPrompt(sessionId: string, text: string): Promise<void> {
  const res = await undiciFetch(`${ENV.opencodeBaseUrl}/api/session/${sessionId}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': ENV.opencodeApiKey },
    body: JSON.stringify({ prompt: { text } }),
    dispatcher: insecureDispatcher,
  });
  if (!res.ok) {
    throw new Error(`opencode prompt failed: ${res.status}`);
  }
}

interface OpencodeMessage {
  type: 'user' | 'assistant';
  finish?: string;
  content?: Array<{ type: string; text?: string }>;
  error?: { message: string };
}

// Polls GET /api/session/:id/message until the newest assistant message has a
// `finish` set. Returns the assistant text. Used as the authoritative
// completion signal (the /event SSE runs concurrently for live UI updates).
export async function pollForFinish(sessionId: string): Promise<{ text: string; finish: string }> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await undiciFetch(`${ENV.opencodeBaseUrl}/api/session/${sessionId}/message`, {
      headers: { 'X-Api-Key': ENV.opencodeApiKey },
      dispatcher: insecureDispatcher,
    });
    if (!res.ok) {
      throw new Error(`opencode message poll failed: ${res.status}`);
    }
    const data = (await res.json()) as { data: OpencodeMessage[] };
    const latest = data.data[0];
    if (latest?.type === 'assistant' && latest.finish) {
      if (latest.finish === 'error') {
        throw new Error(`opencode generation failed: ${latest.error?.message ?? 'unknown error'}`);
      }
      const textPart = latest.content?.find((p) => p.type === 'text' && p.text);
      if (!textPart?.text) {
        throw new Error('opencode reply had no text content');
      }
      return { text: textPart.text, finish: latest.finish };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('opencode reply timed out');
}

// Subscribes to the opencode /event SSE and re-broadcasts each event via
// onEvent. Resolves when the connection closes or `signal` is aborted.
export async function streamEvents(
  sessionId: string,
  onEvent: (event: OpencodeEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await undiciFetch(`${ENV.opencodeBaseUrl}/api/session/${sessionId}/event`, {
    headers: { 'X-Api-Key': ENV.opencodeApiKey, Accept: 'text/event-stream' },
    dispatcher: insecureDispatcher,
    signal,
  });
  if (!res.ok) {
    throw new Error(`opencode event stream failed: ${res.status}`);
  }
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    if (signal?.aborted) break;
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const event = parseSseBlock(raw);
      if (event) onEvent(event);
    }
  }
}

function parseSseBlock(raw: string): OpencodeEvent | null {
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join('\n')) as OpencodeEvent;
  } catch {
    return null;
  }
}

// Orchestrates a full develop run against opencode with model failover and
// retry/backoff. Resolves with the final assistant message text; throws on
// unrecoverable failure. `onEvent` receives live opencode events for streaming.
export async function runDevelop(
  prompt: string,
  onEvent: (event: OpencodeEvent) => void,
  models: OpencodeModel[] = MODEL_TIERS,
  onSession?: (sessionId: string) => void
): Promise<string> {
  let lastError: unknown;
  for (const model of models) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const sessionId = await createSession(model);
        onSession?.(sessionId);
        const controller = new AbortController();
        const streamDone = streamEvents(sessionId, onEvent, controller.signal);
        try {
          await sendPrompt(sessionId, prompt);
          const { text } = await pollForFinish(sessionId);
          controller.abort();
          await streamDone;
          return text;
        } finally {
          controller.abort();
        }
      } catch (err) {
        lastError = err;
        if (attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_DELAY_MS * 2 ** (attempt - 1));
        }
      }
    }
  }
  throw lastError ?? new Error('opencode develop failed');
}

export function buildDevelopPrompt(issue: Issue, command: string): string {
  const repoPath = `${ENV.workspaceRoot}/${issue.owner}/${issue.repo}`;
  const parts = [
    `You are implementing a GitHub issue on a personal dev command board (DevHub).`,
    ``,
    `Repository checkout (already provisioned — do NOT clone): ${repoPath}`,
    `Owner: ${issue.owner}   Repo: ${issue.repo}   Issue #${issue.number}`,
    `Issue URL: ${issue.htmlUrl}`,
    ``,
    `Issue title: ${issue.title}`,
    ``,
    `Issue body:`,
    issue.body?.trim() ? issue.body.trim() : '(no description)',
    ``,
  ];
  if (command.trim()) {
    parts.push(`Additional instructions from the operator:`, command.trim(), '');
  }
  parts.push(
    `Steps:`,
    `1. Read the issue and the repo's contributing/test setup (package.json scripts, README, CI).`,
    `2. Use opencode dev skills as appropriate: using-git-worktrees, test-driven-development, writing-plans.`,
    `3. Implement the change in the checkout at ${repoPath}. Prefer a git worktree branch named like devhub/issue-${issue.number}.`,
    `4. Run the repo's lint and tests. Fix until they pass.`,
    `5. Open a Pull Request with the GitHub CLI using the env PAT for ${issue.owner === 'bumbleflies' ? 'the bumbleflies org' : 'dachrisch'}: \`gh pr create\`. Set the PR body to reference this issue.`,
    ``,
    `CRITICAL: End your final message with EXACTLY ONE of:`,
    `  - the full PR URL (e.g. https://github.com/${issue.owner}/${issue.repo}/pull/123), or`,
    `  - the line "CANNOT FULFILL: <reason>" if you cannot complete the work.`,
    `Never end without one of these two.`
  );
  return parts.join('\n');
}

// Extracts a GitHub PR URL from the assistant message, or null.
export function extractPrUrl(text: string): string | null {
  const m = text.match(/https?:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
  return m ? m[0] : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
