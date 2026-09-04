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
//   POST /api/session/:id/abort  -> stop a running session (best-effort)
//   DELETE /api/session/:id      -> delete a session and its data
//
// The poll budget is the *entire* wall-clock window one session gets to
// explore, implement, lint, commit, push and open a PR — measured in tens of
// minutes, not seconds (see devhub#102). Overridable via
// OPENCODE_POLL_TIMEOUT_MS for per-deployment tuning.
// code.lehel.xyz fronts opencode with Basic auth (user `opencode`, password =
// the server password). Local opencode servers may instead use an `X-Api-Key`.
// Prefer Basic when a password is configured, otherwise fall back to the key.
function authHeaders(): Record<string, string> {
  if (ENV.opencodeBasicPassword) {
    const basic = Buffer.from(`${ENV.opencodeBasicUser}:${ENV.opencodeBasicPassword}`).toString('base64');
    return { Authorization: `Basic ${basic}` };
  }
  if (ENV.opencodeApiKey) {
    return { 'X-Api-Key': ENV.opencodeApiKey };
  }
  return {};
}

export interface OpencodeModel {
  id: string;
  providerID: string;
  // Registry metadata (present only when discovery supplies it): `active`
  // models are servable; `deprecated` ones are scheduled for removal.
  status?: string;
  enabled?: boolean;
}

export function modelKey(model: OpencodeModel): string {
  return `${model.providerID}:${model.id}`;
}

export interface OpencodeEvent {
  type?: string;
  kind?: string;
  [key: string]: unknown;
}

// Known-good models (dontforget perf test, 2026-08-21 + rediscovery
// 2026-08-30). Tried in order; a persistently unhealthy model fails over to
// the next on the same provider. This list is the last-resort fallback for
// the model picker (and the develop failover chain); discovery of the full
// server model list is preferred and includes paid/non-free models too.
// Only ids that still exist under the `opencode` provider are pinned — a
// stale pin (e.g. deepseek-v4-flash, now served only as opencode-go) makes
// every run fail server-side after the prompt is admitted, invisibly.
const MODEL_TIERS: OpencodeModel[] = [
  { id: 'mimo-v2.5-free', providerID: 'opencode' },
  { id: 'big-pickle', providerID: 'opencode' },
  { id: 'nemotron-3.5-lightning-free', providerID: 'opencode' },
];

export function defaultModels(): OpencodeModel[] {
  return MODEL_TIERS;
}

const MODELS_TTL_MS = 10 * 60 * 1000; // re-discover so new models show up without a restart
// How long a failed discovery suppresses re-probing. A failure must NOT be
// cached as truth for the full TTL: a seconds-long opencode outage (watchtower
// image update) otherwise left the model picker offering only the pinned
// tiers for ten minutes while the server exposed 200+ models.
const MODELS_FAILURE_TTL_MS = 30 * 1000;

// Last server-verified model list: served with the full TTL and kept (even
// stale) during discovery failures in preference to the pinned tiers.
let lastGoodModels: OpencodeModel[] | null = null;
let lastGoodAtMs = 0;
let lastFailureAtMs = 0;

function dedupeModels(models: OpencodeModel[]): OpencodeModel[] {
  const seen = new Set<string>();
  const out: OpencodeModel[] = [];
  for (const m of models) {
    const key = modelKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

// Best-effort discovery of the *full* server model list (any provider, free
// or paid). Resolves null when the listing endpoints are unavailable —
// callers decide the fallback. Never throws.
export async function discoverModels(): Promise<OpencodeModel[] | null> {
  const candidates = [
    `${ENV.opencodeBaseUrl}/api/model`,
    `${ENV.opencodeBaseUrl}/api/config`,
    `${ENV.opencodeBaseUrl}/api/model/list`,
  ];
  for (const url of candidates) {
    try {
      const res = await undiciFetch(url, {
        headers: { ...authHeaders() },
        dispatcher: insecureDispatcher,
      });
      if (!res.ok) continue;
      const json = (await res.json()) as unknown;
      const models = extractModels(json);
      if (models.length > 0) return models;
    } catch {
      // try next candidate
    }
  }
  return null;
}

// Returns the discovered models (ordered, deduped), cached for MODELS_TTL_MS
// and refreshed periodically. A failed discovery is never cached as truth:
// the last good list (even stale) is served in preference to the pinned
// tiers, and re-probing is suppressed only for MODELS_FAILURE_TTL_MS. Never
// throws.
export async function getAvailableModels(): Promise<OpencodeModel[]> {
  const now = Date.now();
  if (lastGoodModels && now - lastGoodAtMs < MODELS_TTL_MS) return lastGoodModels;
  if (lastFailureAtMs && now - lastFailureAtMs < MODELS_FAILURE_TTL_MS) {
    return lastGoodModels ?? MODEL_TIERS;
  }
  try {
    const discovered = await discoverModels();
    if (discovered && discovered.length > 0) {
      lastGoodModels = dedupeModels(discovered);
      lastGoodAtMs = now;
      return lastGoodModels;
    }
  } catch {
    // fall through to failure handling
  }
  lastFailureAtMs = now;
  return lastGoodModels ?? MODEL_TIERS;
}

// Builds the model list for a develop run. A user-selected model heads the list
// with the pinned tiers as failover candidates behind it; when omitted the
// default tiers are used unchanged. Never throws.
export function resolveModels(selected?: OpencodeModel | null): OpencodeModel[] {
  if (!selected?.id) return MODEL_TIERS;
  const key = modelKey(selected);
  return [selected, ...MODEL_TIERS.filter((m) => modelKey(m) !== key)];
}

// Drops chain models the server cannot currently serve, keeping order. A model
// missing from the registry (renamed, moved to another provider, retired) or
// marked deprecated/disabled fails server-side only AFTER the prompt is
// admitted — the failure never reaches the message poll or the session SSE
// (the server logs it, DevHub never sees it), so each attempt would silently
// burn its whole poll budget. Skipping such models up front lets failover
// reach a servable model in seconds. If discovery yielded nothing usable, the
// chain is returned unchanged.
export function sanitizeModels(models: OpencodeModel[], available: OpencodeModel[]): OpencodeModel[] {
  const usable = new Set(
    available
      .filter((m) => (m.status === undefined || m.status === 'active') && m.enabled !== false)
      .map(modelKey)
  );
  if (usable.size === 0) return models;
  const kept = models.filter((m) => usable.has(modelKey(m)));
  return kept.length > 0 ? kept : models;
}

// Pulls every listed model (any provider, free or paid). The picker should
// offer whatever the server exposes — filtering to free-only hid useful
// options (e.g. DeepSeek V4 Flash).
function extractModels(json: unknown): OpencodeModel[] {
  const list = resolveModelList(json);
  if (!list) return [];
  return list.map((m) => {
    const model: OpencodeModel = { id: String(m.id), providerID: String(m.providerID) };
    if (typeof m.status === 'string') model.status = m.status;
    if (typeof m.enabled === 'boolean') model.enabled = m.enabled;
    return model;
  });
}

function resolveModelList(
  json: unknown
): Array<{ id?: string; providerID?: string; status?: unknown; enabled?: unknown }> | null {
  if (Array.isArray(json)) {
    return json as Array<{ id?: string; providerID?: string; status?: unknown; enabled?: unknown }>;
  }
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    if (Array.isArray(obj.data)) {
      return obj.data as Array<{ id?: string; providerID?: string; status?: unknown; enabled?: unknown }>;
    }
    if (Array.isArray(obj.models)) {
      return obj.models as Array<{ id?: string; providerID?: string; status?: unknown; enabled?: unknown }>;
    }
  }
  return null;
}

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = ENV.opencodePollTimeoutMs;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;
// Infra-level unavailability (server restarting / edge lost the upstream) is
// not a model problem: retry gaps are stretched so the chain can ride out a
// container restart window (~10-30s with watchtower + traefik registration)
// instead of burning all failover models in a few seconds.
const INFRA_RETRY_FACTOR = 4;

// The edge (traefik) answered with its Go default "404 page not found", the
// upstream returned 5xx, or the connection was refused — the opencode server
// is briefly unavailable. Transient by nature (container restarts, e.g.
// watchtower image updates); see dontforget#142: a mid-run watchtower update
// killed the poll and the fast retry loop blocked the card within ~20s.
export class OpencodeUnavailableError extends Error {}

function isEdgeNotFound(status: number, body: string): boolean {
  return status === 404 && /page not found/i.test(body);
}

async function tagTransport(fetchCall: () => Promise<{ status: number; text: () => Promise<string> }>): Promise<{ status: number; body: string }> {
  let res;
  try {
    res = await fetchCall();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new OpencodeUnavailableError(`opencode server unreachable: ${reason}`);
  }
  const body = await res.text();
  if (res.status >= 500 || isEdgeNotFound(res.status, body)) {
    throw new OpencodeUnavailableError(
      `opencode server unavailable: ${res.status}: ${body.trim().slice(0, 120)} (likely restarting — click Work to retry)`
    );
  }
  return { status: res.status, body };
}

export async function createSession(model: OpencodeModel): Promise<string> {
  const { status, body } = await tagTransport(() =>
    undiciFetch(`${ENV.opencodeBaseUrl}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ model }),
      dispatcher: insecureDispatcher,
    })
  );
  if (status !== 200) {
    throw new Error(`opencode session create failed: ${status}: ${body.slice(0, 200)}`);
  }
  const data = JSON.parse(body) as { data: { id: string } };
  return data.data.id;
}

export async function sendPrompt(sessionId: string, text: string): Promise<void> {
  const { status } = await tagTransport(() =>
    undiciFetch(`${ENV.opencodeBaseUrl}/api/session/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ prompt: { text } }),
      dispatcher: insecureDispatcher,
    })
  );
  if (status !== 200) {
    throw new Error(`opencode prompt failed: ${status}`);
  }
}

// Stops an abandoned session so it cannot keep running its tool-call loop
// (and mutating the shared worktree) after DevHub has given up on it. First
// aborts the run, then deletes the session and its data so it stops consuming
// quota. Best-effort: never throws — a 404 (already gone) or transient network
// failure must not break the retry/failover path.
export async function cancelSession(sessionId: string): Promise<void> {
  const attempts: Array<{ method: 'POST' | 'DELETE'; url: string }> = [
    { method: 'POST', url: `${ENV.opencodeBaseUrl}/api/session/${sessionId}/abort` },
    { method: 'DELETE', url: `${ENV.opencodeBaseUrl}/api/session/${sessionId}` },
  ];
  for (const { method, url } of attempts) {
    try {
      const res = await undiciFetch(url, {
        method,
        headers: { ...authHeaders() },
        dispatcher: insecureDispatcher,
      });
      // Non-2xx (e.g. 404 for an already-gone session) is fine: the goal is a
      // stopped session, and it may already be stopped.
      void res;
    } catch {
      // never throw — cancellation is best-effort
    }
  }
}

interface OpencodeMessage {
  type: 'user' | 'assistant';
  finish?: string;
  content?: Array<{ type: string; text?: string }>;
  error?: { message: string };
}

function messageText(msg: OpencodeMessage | undefined): string {
  if (!msg?.content) return '';
  return msg.content
    .map((p) => p.text ?? '')
    .join('\n')
    .trim();
}

function lastAssistantText(messages: OpencodeMessage[]): string {
  for (const m of messages) {
    if (m.type === 'assistant') {
      const t = messageText(m);
      if (t) return t;
    }
  }
  return '';
}

// Polls GET /api/session/:id/message until the newest assistant message has a
// `finish` set to a terminal state (stop/error). Returns the assistant text.
// Used as the authoritative completion signal (the /event SSE runs concurrently
// for live UI updates).
export async function pollForFinish(sessionId: string, timeoutMs: number = POLL_TIMEOUT_MS): Promise<{ text: string; finish: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status, body } = await tagTransport(() =>
      undiciFetch(`${ENV.opencodeBaseUrl}/api/session/${sessionId}/message`, {
        headers: { ...authHeaders() },
        dispatcher: insecureDispatcher,
      })
    );
    if (status !== 200) {
      throw new Error(`opencode message poll failed: ${status}: ${body.slice(0, 200)}`);
    }
    const data = JSON.parse(body) as { data: OpencodeMessage[] };
    const latest = data.data[0];
    if (latest?.type === 'assistant' && latest.finish) {
      // Only treat terminal finishes as done; tool-calls means the agent
      // is still working (it issued tool calls and will continue).
      if (latest.finish === 'tool-calls') {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (latest.finish === 'error') {
        throw new Error(`opencode generation failed: ${latest.error?.message ?? 'unknown error'}`);
      }
      // Conclusions may live in `reasoning` blocks, not only `text`, so gather
      // all content text and fall back to the most recent assistant answer.
      const text = messageText(latest) || lastAssistantText(data.data);
      if (!text) {
        throw new Error('opencode reply had no text content');
      }
      return { text, finish: latest.finish };
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
  try {
    const res = await undiciFetch(`${ENV.opencodeBaseUrl}/api/session/${sessionId}/event`, {
      headers: { ...authHeaders(), Accept: 'text/event-stream' },
      dispatcher: insecureDispatcher,
      signal,
    });
    if (!res.ok) return;
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
  } catch {
    // SSE is best-effort live UI; the /message poll is authoritative for
    // completion. Aborts/network errors during teardown are expected.
    return;
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
// Every session DevHub gives up on (timeout or error) is explicitly cancelled
// before the next attempt, so abandoned agents cannot keep racing the shared
// worktree or burning quota in the background. `timeoutMs` overrides the
// module-level poll budget (mainly for tests).
export async function runDevelop(
  prompt: string,
  onEvent: (event: OpencodeEvent) => void,
  models: OpencodeModel[] = MODEL_TIERS,
  onSession?: (sessionId: string) => void,
  timeoutMs?: number
): Promise<string> {
  let lastError: unknown;
  for (const model of models) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let sessionId: string | null = null;
      try {
        sessionId = await createSession(model);
        onSession?.(sessionId);
        const controller = new AbortController();
        const streamDone = streamEvents(sessionId, onEvent, controller.signal);
        try {
          await sendPrompt(sessionId, prompt);
          const { text } = await pollForFinish(sessionId, timeoutMs);
          controller.abort();
          await streamDone;
          return text;
        } finally {
          controller.abort();
        }
      } catch (err) {
        lastError = err;
        if (sessionId) await cancelSession(sessionId);
        if (attempt < MAX_ATTEMPTS) {
          const infraRetry = err instanceof OpencodeUnavailableError;
          await sleep(RETRY_DELAY_MS * 2 ** (attempt - 1) * (infraRetry ? INFRA_RETRY_FACTOR : 1));
        }
      }
    }
  }
  throw lastError ?? new Error('opencode develop failed');
}

export function buildDevelopPrompt(issue: Issue, command: string): string {
  const repoPath = `${ENV.openWorkspaceRoot}/${issue.repo}`;
  const worktreePath = `${repoPath}/.worktrees/${issue.id}`;
  const branch = `devhub/issue-${issue.number}`;

  const parts = [
    `You are implementing a GitHub issue on a personal dev command board (DevHub).`,
    `You have access to opencode skills — use the opencode-contribution skill for code changes, testing, and PR workflow.`,
    ``,
    `## Repository`,
    `Checkout (already provisioned — do NOT clone): ${repoPath}`,
    `Owner: ${issue.owner}   Repo: ${issue.repo}   Issue #${issue.number}`,
    `Issue URL: ${issue.htmlUrl}`,
    ``,
    `## Issue`,
    `Title: ${issue.title}`,
    ``,
    `Body:`,
    issue.body?.trim() ? issue.body.trim() : '(no description)',
    ``,
  ];

  if (command.trim()) {
    parts.push(`## Additional instructions from the operator`, command.trim(), '');
  }

  parts.push(
    `## Steps`,
    ``,
    `### 0. Check if work is needed`,
    `Before doing anything, verify whether this issue is already resolved:`,
    `\`\`\`bash`,
    `cd ${repoPath}`,
    `# Check if the issue is closed on GitHub`,
    `gh issue view ${issue.number} --repo ${issue.owner}/${issue.repo} --json state,stateReason`,
    `\`\`\``,
    `- If the issue is **closed**, do NOT implement. Clean up any leftover worktree and branch, then end with \`ALREADY RESOLVED: Issue #${issue.number} is already closed\`.`,
    `- Also search for a linked or merged PR: \`gh pr list --repo ${issue.owner}/${issue.repo} --state all --search "${issue.number} in:title,body"\``,
    `- If a merged PR addresses this issue, end with \`ALREADY RESOLVED: PR already merged for this issue\`.`,
    ``,
    `### 1. Set up an isolated worktree`,
    `A previous attempt may have left the worktree or branch behind — adopt it in place instead of failing or creating duplicates:`,
    `\`\`\`bash`,
    `cd ${repoPath}`,
    `git fetch origin`,
    `if [ -d ".worktrees/${issue.id}" ]; then`,
    `  cd .worktrees/${issue.id}`,
    `  git checkout ${branch} 2>/dev/null || true`,
    `else`,
    `  git worktree add .worktrees/${issue.id} -b ${branch}`,
    `  cd .worktrees/${issue.id}`,
    `fi`,
    `\`\`\``,
    ``,
    `### 2. Work only inside the worktree`,
    `\`\`\`bash`,
    `cd ${worktreePath}`,
    `\`\`\``,
    `All file edits, commits, and command execution happen here.`,
    ``,
    `### 3. Understand the project`,
    `- Read CONTRIBUTING.md, README.md, package.json (or equivalent) for project conventions.`,
    `- Check recent commits: \`git log --oneline -10\``,
    `- Identify lint, test, and build commands.`,
    ``,
    `### 4. Implement the change`,
    `- Make focused, minimal changes that address the issue.`,
    `- Follow existing code style and conventions.`,
    `- Commit with descriptive messages using the project's convention.`,
    ``,
    `### 5. Verify`,
    `- Run lint and tests. Fix until they pass.`,
    `- Do not submit a PR with failing checks.`,
    ``,
    `### 6. Open a Pull Request`,
    `\`\`\`bash`,
    `gh pr create --base master --head ${branch} \\`,
    `  --title "<type>: <short description>" \\`,
    `  --body "Fixes #${issue.number}"`,
    `\`\`\``,
    `Use your authenticated \`gh\` (GitHub CLI) — the checkout is already provisioned for the correct owner.`,
    ``,
    `### 7. Clean up the worktree`,
    `\`\`\`bash`,
    `cd ${repoPath}`,
    `git worktree remove .worktrees/${issue.id}`,
    `\`\`\``,
    ``,
    `## CRITICAL: Final message format`,
    `End your final message with EXACTLY ONE of:`,
    `- the full PR URL (e.g. https://github.com/${issue.owner}/${issue.repo}/pull/123), or`,
    `- "ALREADY RESOLVED: <reason>" if the issue is already closed or has a merged PR — do NOT attempt implementation,`,
    `- "CANNOT FULFILL: <reason>" if you cannot complete the work.`,
    `Never end without one of these three.`
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
