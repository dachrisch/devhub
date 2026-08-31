# DevHub Cockpit — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend devhub from issue board into a cockpit where you say what you want ("Launch a service", "Fix this issue", "Write a post") and the system handles the rest.

**User-facing abstraction — 4 actions:**
| Action | What you say | What happens |
|--------|-------------|--------------|
| **Launch** | "Launch a new API" | Scaffold → infra → deploy → register |
| **Fix** | "Fix issue #42" | Read issue → implement → open PR |
| **Write** | "Write a blog post about X" | Draft → review → publish |
| **Show** | "What's deployed?" | Query status → display |

**Architecture:** Input bar → AI understands intent → Skill executes via opencode sessions → Knowledge captured. Plugs into existing store.ts, opencode.ts, sse.ts patterns.

**Tech Stack:** Next.js 16, TypeScript 5, better-sqlite3, undici (existing). No new dependencies until Phase 3+.

---

## Phase 1: The Foundation

Build the input bar, the AI understanding layer, and the action tracking system.

### Task 1: Add `actions` table to store.ts

**Files:**
- Modify: `src/lib/store.ts:18-59` (migrate function)
- Test: `src/lib/store.test.ts`

**Step 1: Write the failing test**

Add to `src/lib/store.test.ts`:

```typescript
describe('actions', () => {
  it('appends and retrieves actions', () => {
    const action = store.appendAction('Launch a new API', 'launch', { name: 'blog-api' });
    expect(action.id).toBeGreaterThan(0);
    expect(action.input).toBe('Launch a new API');
    expect(action.action).toBe('launch');
    expect(action.status).toBe('pending');

    store.setActionStatus(action.id, 'running');
    const updated = store.getAction(action.id);
    expect(updated?.status).toBe('running');

    store.setActionStatus(action.id, 'success', 'Deployed', 5000);
    const done = store.getAction(action.id);
    expect(done?.status).toBe('success');
    expect(done?.result).toBe('Deployed');
    expect(done?.durationMs).toBe(5000);
  });

  it('lists recent actions', () => {
    store.appendAction('action-a', 'launch', {});
    store.appendAction('action-b', 'fix', {});
    const list = store.getActions(5);
    expect(list.length).toBeGreaterThanOrEqual(2);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- src/lib/store.test.ts
```
Expected: FAIL — `appendAction` is not a function

**Step 3: Add types and migration**

In `src/lib/store.ts`, after the existing imports (line 3), add:

```typescript
export interface ActionRow {
  id: number;
  input: string;
  action: string;
  params: string;
  skillId: string | null;
  status: string;
  result: string | null;
  sessionIds: string;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
}
```

In `migrate()`, after the settings table creation (line 58), add:

```sql
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  input TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'unknown',
  params TEXT NOT NULL DEFAULT '{}',
  skill_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  session_ids TEXT NOT NULL DEFAULT '[]',
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Step 4: Add CRUD functions**

After `setDefaultModel` (line 301), add:

```typescript
export function appendAction(input: string, action: string, params: Record<string, unknown>): ActionRow {
  const info = getDb()
    .prepare(`INSERT INTO actions (input, action, params) VALUES (?, ?, ?)`)
    .run(input, action, JSON.stringify(params));
  return getAction(Number(info.lastInsertRowid))!;
}

export function getAction(id: number): ActionRow | null {
  const row = getDb().prepare('SELECT * FROM actions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as number,
    input: row.input as string,
    action: row.action as string,
    params: row.params as string,
    skillId: row.skill_id as string | null,
    status: row.status as string,
    result: row.result as string | null,
    sessionIds: row.session_ids as string,
    durationMs: row.duration_ms as number | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function setActionStatus(id: number, status: string, result?: string, durationMs?: number): void {
  const sets = ['status = ?', `updated_at = datetime('now')`];
  const args: (string | number)[] = [status];
  if (result !== undefined) { sets.push('result = ?'); args.push(result); }
  if (durationMs !== undefined) { sets.push('duration_ms = ?'); args.push(durationMs); }
  args.push(id);
  getDb().prepare(`UPDATE actions SET ${sets.join(', ')} WHERE id = ?`).run(...args);
}

export function appendSessionId(actionId: number, sessionId: string): void {
  const row = getDb().prepare('SELECT session_ids FROM actions WHERE id = ?').get(actionId) as Record<string, unknown> | undefined;
  if (!row) return;
  const ids = JSON.parse(row.session_ids as string) as string[];
  ids.push(sessionId);
  getDb().prepare(`UPDATE actions SET session_ids = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(ids), actionId);
}

export function getActions(limit = 20): ActionRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM actions ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    input: r.input as string,
    action: r.action as string,
    params: r.params as string,
    skillId: r.skill_id as string | null,
    status: r.status as string,
    result: r.result as string | null,
    sessionIds: r.session_ids as string,
    durationMs: r.duration_ms as number | null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }));
}
```

**Step 5: Run test to verify it passes**

```bash
npm test -- src/lib/store.test.ts
```
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/store.ts src/lib/store.test.ts
git commit -m "feat: add actions table and CRUD to store"
```

---

### Task 2: Add SSE event type for actions

**Files:**
- Modify: `src/lib/sse.ts:4-7`
- Test: `src/lib/sse.test.ts`

**Step 1: Write the failing test**

Create `src/lib/sse.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { broadcaster, publishAction } from './sse';

describe('sse', () => {
  it('publishes action events', () => {
    const events: unknown[] = [];
    const unsub = broadcaster.subscribe((e) => events.push(e));
    publishAction(42, 'running', 'Scaffolding...');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'action', actionId: 42, status: 'running', detail: 'Scaffolding...' });
    unsub();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- src/lib/sse.test.ts
```
Expected: FAIL — `publishAction` is not exported

**Step 3: Extend `ServerEvent` type and add function**

In `src/lib/sse.ts`, change `ServerEvent` (lines 4-7):

```typescript
export type ServerEvent =
  | { type: 'issue'; issue: Issue }
  | { type: 'opencode-event'; issueId: number; event: OpencodeEvent }
  | { type: 'action'; actionId: number; status: string; detail: string }
  | { type: 'hello'; now: string };
```

After `publishOpencodeEvent` (line 41), add:

```typescript
export function publishAction(actionId: number, status: string, detail: string): void {
  broadcaster.publish({ type: 'action', actionId, status, detail });
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- src/lib/sse.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/sse.ts src/lib/sse.test.ts
git commit -m "feat: add action SSE event type"
```

---

### Task 3: Create skill types and registry

**Files:**
- Create: `src/lib/skills/types.ts`
- Create: `src/lib/skills/index.ts`
- Test: `src/lib/skills/index.test.ts`

**Step 1: Write the failing test**

Create `src/lib/skills/index.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { loadSkills, getByAction } from './index';

describe('skills', () => {
  it('returns empty array when no skills registered', () => {
    const skills = loadSkills();
    expect(Array.isArray(skills)).toBe(true);
  });

  it('getByAction returns null for unknown action', () => {
    const skill = getByAction('nonexistent_action_xyz');
    expect(skill).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- src/lib/skills/index.test.ts
```
Expected: FAIL — module not found

**Step 3: Create types file**

Create `src/lib/skills/types.ts`:

```typescript
import type { OpencodeEvent, OpencodeModel } from '../opencode';

export type ActionType = 'launch' | 'fix' | 'write' | 'show';

export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  action: ActionType;
  triggers: string[];
  requiredParams: string[];
  optionalParams: string[];
}

export interface SkillContext {
  actionId: number;
  input: string;
  params: Record<string, unknown>;
  token: string;
  models: OpencodeModel[];
  onEvent: (event: OpencodeEvent) => void;
  onStatus: (status: string) => void;
  onStartSession: (sessionId: string) => void;
}

export interface SkillResult {
  success: boolean;
  summary: string;
  details?: unknown;
  sessionIds?: string[];
}

export type SkillExecutor = (ctx: SkillContext) => Promise<SkillResult>;
```

**Step 4: Create registry file**

Create `src/lib/skills/index.ts`:

```typescript
import type { SkillManifest, SkillExecutor, ActionType } from './types';

interface RegisteredSkill {
  manifest: SkillManifest;
  execute: SkillExecutor;
}

const registry: RegisteredSkill[] = [];

export function registerSkill(manifest: SkillManifest, execute: SkillExecutor): void {
  registry.push({ manifest, execute });
}

export function loadSkills(): SkillManifest[] {
  return registry.map((s) => s.manifest);
}

export function getByAction(action: ActionType): RegisteredSkill | null {
  return registry.find((s) => s.manifest.action === action) ?? null;
}

export function getSkillById(id: string): RegisteredSkill | null {
  return registry.find((s) => s.manifest.id === id) ?? null;
}
```

**Step 5: Run test to verify it passes**

```bash
npm test -- src/lib/skills/index.test.ts
```
Expected: PASS

**Step 6: Commit**

```bash
mkdir -p src/lib/skills
git add src/lib/skills/types.ts src/lib/skills/index.ts src/lib/skills/index.test.ts
git commit -m "feat: add skill types and registry"
```

---

### Task 4: Create the router

**Files:**
- Create: `src/lib/router.ts`
- Test: `src/lib/router.test.ts`

**Step 1: Write the failing test**

Create `src/lib/router.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { parseIntent } from './router';

describe('router', () => {
  it('parses launch action', () => {
    const result = parseIntent(JSON.stringify({
      action: 'launch',
      confidence: 0.95,
      params: { name: 'blog-api', framework: 'fastapi' },
    }));
    expect(result.action).toBe('launch');
    expect(result.confidence).toBe(0.95);
    expect(result.params.name).toBe('blog-api');
  });

  it('parses fix action', () => {
    const result = parseIntent(JSON.stringify({
      action: 'fix',
      confidence: 0.92,
      params: { issueId: 42 },
    }));
    expect(result.action).toBe('fix');
    expect(result.params.issueId).toBe(42);
  });

  it('handles malformed JSON gracefully', () => {
    const result = parseIntent('not json at all');
    expect(result.action).toBe('unknown');
    expect(result.confidence).toBe(0);
  });

  it('handles missing fields gracefully', () => {
    const result = parseIntent('{}');
    expect(result.action).toBe('unknown');
    expect(result.confidence).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- src/lib/router.test.ts
```
Expected: FAIL — module not found

**Step 3: Create the router**

Create `src/lib/router.ts`:

```typescript
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
```

**Step 4: Run test to verify it passes**

```bash
npm test -- src/lib/router.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/router.ts src/lib/router.test.ts
git commit -m "feat: add action router with intent classification"
```

---

### Task 5: Create the `POST /api/action` route

**Files:**
- Create: `src/app/api/action/route.ts`
- Create: `src/app/api/action/[id]/route.ts`

**Step 1: Create the main route**

Create `src/app/api/action/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { appendAction, setActionStatus, getAction, getActions, appendSessionId } from '@/lib/store';
import { UnauthorizedError, ForbiddenError, requireMember } from '@/lib/auth';
import { classifyInput } from '@/lib/router';
import { getByAction } from '@/lib/skills';
import { resolveModels } from '@/lib/opencode';
import { publishAction } from '@/lib/sse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  let session;
  try {
    session = await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { input?: unknown; params?: unknown };
  const input = typeof body.input === 'string' ? body.input.trim() : '';
  if (!input) {
    return NextResponse.json({ error: 'input is required' }, { status: 400 });
  }

  const params = typeof body.params === 'object' && body.params !== null
    ? body.params as Record<string, unknown>
    : {};
  const action = appendAction(input, 'pending', params);
  publishAction(action.id, 'pending', 'Understanding what you want...');

  // Fire-and-forget
  void executeAction(action.id, input, params, session.token);

  return NextResponse.json({ ok: true, actionId: action.id, status: 'pending' }, { status: 202 });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  let session;
  try {
    session = await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get('limit')) || 20;
  const actions = getActions(limit);
  return NextResponse.json({ actions });
}

async function executeAction(
  actionId: number,
  input: string,
  params: Record<string, unknown>,
  token: string
): Promise<void> {
  const startTime = Date.now();

  try {
    setActionStatus(actionId, 'running');
    publishAction(actionId, 'running', 'Understanding what you want...');

    const models = resolveModels();
    const sessionIds: string[] = [];

    const onEvent = () => {};

    // Classify what the user wants
    const intent = await classifyInput(input, models, onEvent);

    if (intent.confidence < 0.5) {
      setActionStatus(actionId, 'failed', `Not sure what you mean. Could you rephrase?`);
      publishAction(actionId, 'failed', 'Could not understand');
      return;
    }

    // Find the skill that handles this action
    const skill = getByAction(intent.action);
    if (!skill) {
      setActionStatus(actionId, 'failed', `I can "${intent.action}" yet — that skill isn't built yet.`);
      publishAction(actionId, 'failed', `Not ready yet: ${intent.action}`);
      return;
    }

    publishAction(actionId, 'running', `Working on: ${skill.manifest.name}`);

    // Execute the skill
    const result = await skill.execute({
      actionId,
      input,
      params: intent.params,
      token,
      models,
      onEvent: () => {},
      onStatus: (detail) => { publishAction(actionId, 'running', detail); },
      onStartSession: (sid) => {
        sessionIds.push(sid);
        appendSessionId(actionId, sid);
      },
    });

    const duration = Date.now() - startTime;
    setActionStatus(actionId, result.success ? 'success' : 'failed', result.summary, duration);
    publishAction(actionId, result.success ? 'success' : 'failed', result.summary);

  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const duration = Date.now() - startTime;
    setActionStatus(actionId, 'failed', reason, duration);
    publishAction(actionId, 'failed', reason);
  }
}
```

**Step 2: Create the detail route**

Create `src/app/api/action/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getAction } from '@/lib/store';
import { UnauthorizedError, ForbiddenError, requireMember } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  let session;
  try {
    session = await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }

  const { id } = await params;
  const actionId = Number(id);
  if (!Number.isInteger(actionId)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }

  const action = getAction(actionId);
  if (!action) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  return NextResponse.json({ action });
}
```

**Step 3: Run typecheck**

```bash
npm run typecheck
```
Expected: PASS

**Step 4: Commit**

```bash
mkdir -p src/app/api/action/\[id\]
git add src/app/api/action/
git commit -m "feat: add POST /api/action and GET /api/action/[id] routes"
```

---

### Task 6: Add input bar to board UI

**Files:**
- Modify: `src/app/(board)/page.tsx`

**Step 1: Add input state and handler**

In the `BoardPage` component, add state variables:

```typescript
const [actionInput, setActionInput] = useState('');
const [actionHistory, setActionHistory] = useState<{id: number; input: string; status: string}[]>([]);
```

Add the submit handler:

```typescript
const submitAction = async () => {
  if (!actionInput.trim()) return;
  try {
    const res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: actionInput }),
    });
    const data = await res.json();
    if (data.ok) {
      setActionHistory((prev) => [{ id: data.actionId, input: actionInput, status: 'pending' }, ...prev]);
      setActionInput('');
    }
  } catch { /* ignore */ }
};
```

Add JSX before the column navigation:

```tsx
<div style={{ padding: '0 16px 12px' }}>
  <div style={{ display: 'flex', gap: 8 }}>
    <input
      type="text"
      value={actionInput}
      onChange={(e) => setActionInput(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && submitAction()}
      placeholder='Tell me what you want... (e.g. "Launch a new API", "Fix issue #42")'
      style={{
        flex: 1, padding: '10px 14px', borderRadius: 8,
        border: '1px solid var(--border)', background: 'var(--surface)',
        color: 'var(--text)', fontSize: 14, outline: 'none',
      }}
    />
    <button
      onClick={submitAction}
      style={{
        padding: '10px 20px', borderRadius: 8, border: 'none',
        background: 'var(--accent)', color: '#fff', fontWeight: 600,
        cursor: 'pointer', fontSize: 14,
      }}
    >
      Go
    </button>
  </div>
</div>
```

**Step 2: Verify it builds**

```bash
npm run build
```
Expected: BUILD passes

**Step 3: Commit**

```bash
git add src/app/\(board\)/page.tsx
git commit -m "feat: add input bar to board UI"
```

---

## Phase 2: First Actions — Launch & Fix

The two most common actions working end to end.

### Task 7: Add `knowledge` table

**Files:**
- Modify: `src/lib/store.ts`

**Step 1: Add migration**

In `migrate()`, after the actions table:

```sql
CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  summary TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  source_action_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(source_action_id) REFERENCES actions(id)
);
```

**Step 2: Add functions**

```typescript
export interface KnowledgeRow {
  id: number;
  domain: string;
  summary: string;
  details: string;
  sourceActionId: number | null;
  createdAt: string;
}

export function storeKnowledge(domain: string, summary: string, details: Record<string, unknown>, sourceActionId?: number): KnowledgeRow {
  const info = getDb()
    .prepare(`INSERT INTO knowledge (domain, summary, details, source_action_id) VALUES (?, ?, ?, ?)`)
    .run(domain, summary, JSON.stringify(details), sourceActionId ?? null);
  const row = getDb().prepare('SELECT * FROM knowledge WHERE id = ?').get(info.lastInsertRowid) as Record<string, unknown>;
  return {
    id: row.id as number, domain: row.domain as string, summary: row.summary as string,
    details: row.details as string, sourceActionId: row.source_action_id as number | null,
    createdAt: row.created_at as string,
  };
}

export function searchKnowledge(query: string, domain?: string, limit = 5): KnowledgeRow[] {
  let sql = 'SELECT * FROM knowledge WHERE (summary LIKE ? OR details LIKE ?)';
  const args: string[] = [`%${query}%`, `%${query}%`];
  if (domain) { sql += ' AND domain = ?'; args.push(domain); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  args.push(String(limit));
  const rows = getDb().prepare(sql).all(...args) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number, domain: r.domain as string, summary: r.summary as string,
    details: r.details as string, sourceActionId: r.source_action_id as number | null,
    createdAt: r.created_at as string,
  }));
}
```

**Step 3: Commit**

```bash
git add src/lib/store.ts
git commit -m "feat: add knowledge table for learned patterns"
```

---

### Task 8: Create `fix` skill (wraps existing develop flow)

**Files:**
- Create: `src/lib/skills/fix.ts`

**Step 1: Create the skill**

```typescript
import { registerSkill, type SkillContext, type SkillResult } from './types';
import { getIssue, appendEvent, setSessionId, setResult, storeKnowledge } from '../store';
import { buildDevelopPrompt, extractPrUrl, runDevelop, type OpencodeEvent } from '../opencode';
import { publishIssue, publishOpencodeEvent } from '../sse';
import { mirrorComment } from '../utils';
import { setIssueStateLabels } from '../github';

registerSkill(
  {
    id: 'fix',
    name: 'Fix Issue',
    description: 'Resolve a problem and open a PR',
    action: 'fix',
    triggers: ['fix', 'resolve', 'bug', 'issue', 'error', 'broken'],
    requiredParams: ['issueId'],
    optionalParams: ['command'],
  },
  async (ctx: SkillContext): Promise<SkillResult> => {
    const issueId = ctx.params.issueId as number;
    const issue = getIssue(issueId);
    if (!issue) {
      return { success: false, summary: `Issue #${issueId} not found` };
    }

    ctx.onStatus(`Fixing issue #${issue.number} in ${issue.repo}...`);

    try {
      const prompt = buildDevelopPrompt(issue, (ctx.params.command as string) || '');
      const sessionIds: string[] = [];

      const onEvent = (event: OpencodeEvent) => {
        appendEvent(issue.id, 'opencode', event);
        publishOpencodeEvent(issue.id, event);
        ctx.onEvent(event);
      };

      const text = await runDevelop(prompt, onEvent, ctx.models, (sid) => {
        sessionIds.push(sid);
        setSessionId(issue.id, sid);
        ctx.onStartSession(sid);
      });

      const prUrl = extractPrUrl(text);
      if (prUrl) {
        setResult(issue.id, 'pr', prUrl, text);
        const updated = getIssue(issue.id);
        if (updated) publishIssue(updated);
        try { await setIssueStateLabels(issue.owner, issue.repo, issue.number, 'pr', ctx.token); } catch {}
        void mirrorComment(issue, `DevHub opened a pull request: ${prUrl}`, ctx.token);

        storeKnowledge('fix',
          `Fixed issue #${issue.number} in ${issue.repo}: ${prUrl}`,
          { issueId: issue.id, owner: issue.owner, repo: issue.repo, number: issue.number, prUrl },
          ctx.actionId
        );

        return { success: true, summary: `PR opened: ${prUrl}`, sessionIds };
      } else {
        setResult(issue.id, 'blocked', null, text);
        const updated = getIssue(issue.id);
        if (updated) publishIssue(updated);

        storeKnowledge('fix',
          `Attempted issue #${issue.number} in ${issue.repo}: blocked`,
          { issueId: issue.id, owner: issue.owner, repo: issue.repo, number: issue.number },
          ctx.actionId
        );

        return { success: false, summary: text.slice(0, 500), sessionIds };
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      appendEvent(issue.id, 'error', { message: reason });
      setResult(issue.id, 'blocked', null, `CANNOT FULFILL: ${reason}`);
      const updated = getIssue(issue.id);
      if (updated) publishIssue(updated);
      return { success: false, summary: reason };
    }
  }
);
```

**Step 2: Commit**

```bash
git add src/lib/skills/fix.ts
git commit -m "feat: add fix skill wrapping existing develop flow"
```

---

### Task 9: Create `launch` skill

**Files:**
- Create: `src/lib/skills/launch.ts`

**Step 1: Create the skill**

```typescript
import { registerSkill, type SkillContext, type SkillResult } from './types';
import { storeKnowledge, upsertService } from '../store';
import { runDevelop } from '../opencode';

const SCAFFOLD_PROMPT = `You are scaffolding a new service called "{name}".

Tech stack: {framework}
Database: {database}

Create the following files in /home/cda/dev/{name}/:
1. Main application file (main.py for Python, main.go for Go, src/index.ts for Node)
2. Dockerfile (multi-stage, production-ready)
3. .gitignore
4. README.md with setup instructions
5. docker-compose.yml for local development
6. requirements.txt / go.mod / package.json as appropriate

Follow these conventions:
- Use non-root user in Dockerfile
- Include health check endpoint at /health
- Expose port 8000 (or appropriate default)
- Use environment variables for configuration

Do NOT create a git repo or push. Just create the files.
End with "SCAFFOLD COMPLETE" when done.`;

const INFRA_PROMPT = `You are adding a new service "{name}" to the servyy-container infrastructure.

Service details:
- Name: {name}
- Framework: {framework}
- Target host: {host}

Create these files:

1. infrastructure/container/{name}/docker-compose.yml
   Follow the exact pattern from devhub's docker-compose.yml:
   - Use {name} as the compose project name
   - Container naming: \${{COMPOSE_PROJECT_NAME}}.web
   - Include env_file, volumes, networks (proxy), healthcheck
   - Add Traefik labels for routing at {name}.{host}
   - Use watchtower label for auto-updates

2. infrastructure/container/ansible/plays/roles/docker_service/templates/{name}/.env.j2
   Template variables: COMPOSE_PROJECT_NAME, SERVICE_NAME, SERVICE_HOST, TRAEFIK_ENTRYPOINT, TRAEFIK_TLS, TRAEFIK_CERTRESOLVER

After creating files, verify they are valid:
- docker-compose config --quiet
- yamllint the files

End with "INFRA COMPLETE" when done.`;

const DEPLOY_PROMPT = `You are deploying the service "{name}" to {host}.

Run these commands:
1. cd /root/dev/infrastructure/container
2. ./servyy.sh --tags user.docker.{name}

If the deploy succeeds, you'll see "changed=0" or "changed=N" with "failed=0".
If it fails, capture the error output.

End with "DEPLOY COMPLETE" or "DEPLOY FAILED: <reason>" when done.`;

registerSkill(
  {
    id: 'launch',
    name: 'Launch Service',
    description: 'Create something new and put it live',
    action: 'launch',
    triggers: ['launch', 'create', 'new', 'scaffold', 'set up', 'deploy'],
    requiredParams: ['name'],
    optionalParams: ['framework', 'database', 'host'],
  },
  async (ctx: SkillContext): Promise<SkillResult> => {
    const name = ctx.params.name as string;
    const framework = (ctx.params.framework as string) || 'node';
    const database = (ctx.params.database as string) || 'none';
    const host = (ctx.params.host as string) || 'servy.lehel.xyz';
    const sessionIds: string[] = [];

    // Step 1: Scaffold
    ctx.onStatus(`Creating ${name}...`);

    const scaffoldPrompt = SCAFFOLD_PROMPT
      .replace(/{name}/g, name)
      .replace(/{framework}/g, framework)
      .replace(/{database}/g, database);

    const scaffoldText = await runDevelop(
      scaffoldPrompt,
      (e) => ctx.onEvent(e),
      ctx.models,
      (sid) => { sessionIds.push(sid); ctx.onStartSession(sid); }
    );

    if (!scaffoldText.includes('SCAFFOLD COMPLETE')) {
      return { success: false, summary: `Scaffolding failed: ${scaffoldText.slice(0, 500)}`, sessionIds };
    }

    // Step 2: Add to infrastructure
    ctx.onStatus('Setting up infrastructure...');

    const infraPrompt = INFRA_PROMPT
      .replace(/{name}/g, name)
      .replace(/{framework}/g, framework)
      .replace(/{host}/g, host);

    const infraText = await runDevelop(
      infraPrompt,
      (e) => ctx.onEvent(e),
      ctx.models,
      (sid) => { sessionIds.push(sid); ctx.onStartSession(sid); }
    );

    if (!infraText.includes('INFRA COMPLETE')) {
      return { success: false, summary: `Infrastructure setup failed: ${infraText.slice(0, 500)}`, sessionIds };
    }

    // Step 3: Deploy
    ctx.onStatus('Deploying...');

    const deployPrompt = DEPLOY_PROMPT
      .replace(/{name}/g, name)
      .replace(/{host}/g, host);

    const deployText = await runDevelop(
      deployPrompt,
      (e) => ctx.onEvent(e),
      ctx.models,
      (sid) => { sessionIds.push(sid); ctx.onStartSession(sid); }
    );

    if (!deployText.includes('DEPLOY COMPLETE')) {
      return { success: false, summary: `Deploy failed: ${deployText.slice(0, 500)}`, sessionIds };
    }

    // Step 4: Register and remember
    ctx.onStatus('Registering service...');

    upsertService({
      name,
      deployHost: host,
      deployDir: `/home/cda/dev/${name}`,
      domain: `${name}.${host}`,
      config: { framework, database },
    });

    storeKnowledge('launch',
      `Launched ${name} (${framework}) on ${host}`,
      { name, framework, database, host, steps: ['scaffold', 'infra', 'deploy'] },
      ctx.actionId
    );

    return {
      success: true,
      summary: `${name} is live at ${name}.${host}`,
      sessionIds,
    };
  }
);
```

**Step 2: Commit**

```bash
git add src/lib/skills/launch.ts
git commit -m "feat: add launch skill"
```

---

### Task 10: Wire up skills on startup

**Files:**
- Modify: `src/instrumentation.ts`

**Step 1: Import skills**

```typescript
import '@/lib/skills/fix';
import '@/lib/skills/launch';
```

**Step 2: Commit**

```bash
git add src/instrumentation.ts
git commit -m "feat: wire up skills on app startup"
```

---

## Phase 3: The Cockpit View

See what's running. The full picture.

### Task 11: Add `services` table

**Files:**
- Modify: `src/lib/store.ts`

**Step 1: Add migration**

```sql
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  repo_owner TEXT,
  repo_name TEXT,
  deploy_host TEXT,
  deploy_dir TEXT,
  domain TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_deploy_at TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Step 2: Add functions**

```typescript
export interface ServiceRow {
  id: number; name: string; repoOwner: string | null; repoName: string | null;
  deployHost: string | null; deployDir: string | null; domain: string | null;
  status: string; lastDeployAt: string | null; config: string; createdAt: string;
}

export function getServices(): ServiceRow[] {
  const rows = getDb().prepare('SELECT * FROM services ORDER BY name').all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number, name: r.name as string,
    repoOwner: r.repo_owner as string | null, repoName: r.repo_name as string | null,
    deployHost: r.deploy_host as string | null, deployDir: r.deploy_dir as string | null,
    domain: r.domain as string | null, status: r.status as string,
    lastDeployAt: r.last_deploy_at as string | null,
    config: r.config as string, createdAt: r.created_at as string,
  }));
}

export function getServiceByName(name: string): ServiceRow | null {
  const row = getDb().prepare('SELECT * FROM services WHERE name = ?').get(name) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as number, name: row.name as string,
    repoOwner: row.repo_owner as string | null, repoName: row.repo_name as string | null,
    deployHost: row.deploy_host as string | null, deployDir: row.deploy_dir as string | null,
    domain: row.domain as string | null, status: row.status as string,
    lastDeployAt: row.last_deploy_at as string | null,
    config: row.config as string, createdAt: row.created_at as string,
  };
}

export function upsertService(input: { name: string; repoOwner?: string; repoName?: string;
  deployHost?: string; deployDir?: string; domain?: string; config?: Record<string, unknown> }): ServiceRow {
  getDb().prepare(`INSERT INTO services (name, repo_owner, repo_name, deploy_host, deploy_dir, domain, config)
    VALUES (@name, @repoOwner, @repoName, @deployHost, @deployDir, @domain, @config)
    ON CONFLICT(name) DO UPDATE SET
      repo_owner = excluded.repo_owner, repo_name = excluded.repo_name,
      deploy_host = excluded.deploy_host, deploy_dir = excluded.deploy_dir,
      domain = excluded.domain, config = excluded.config
  `).run({
    name: input.name,
    repoOwner: input.repoOwner ?? null,
    repoName: input.repoName ?? null,
    deployHost: input.deployHost ?? null,
    deployDir: input.deployDir ?? null,
    domain: input.domain ?? null,
    config: JSON.stringify(input.config ?? {}),
  });
  return getServiceByName(input.name)!;
}
```

**Step 3: Commit**

```bash
git add src/lib/store.ts
git commit -m "feat: add services table and CRUD"
```

---

### Task 12: Create `GET /api/services` route

**Files:**
- Create: `src/app/api/services/route.ts`

**Step 1: Create route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getServices } from '@/lib/store';
import { requireMember, UnauthorizedError, ForbiddenError } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  let session;
  try {
    session = await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }

  const services = getServices();
  return NextResponse.json({ services });
}
```

**Step 2: Commit**

```bash
git add src/app/api/services/route.ts
git commit -m "feat: add GET /api/services route"
```

---

## Verification Checklist

After all phases:

```bash
npm run typecheck    # TypeScript compiles
npm run lint         # ESLint passes
npm test             # All tests pass
npm run build        # Next.js builds
```

**End-to-end test:**
1. Type "Launch a new blog API with FastAPI" in the input bar
2. Watch progress updates in real time
3. Confirm before deploy (or set AUTO_APPROVE)
4. See the service appear in the services list
5. Check knowledge table has the record

---

## Decisions (confirmed)

| Decision | Resolution |
|----------|------------|
| Knowledge | Agent-learned, improves over time |
| Scope | Full lifecycle — create through operations |
| Content | LinkedIn, X/Twitter, blog |
| Architecture | Plugin-based skill system |
| Deploy gate | Ask before prod (or AUTO_APPROVE=true) |
| Sessions | One orchestrator, spawns as needed |
| Infrastructure | Ansible + Docker, existing patterns |
| Auth | Same GitHub OAuth, no changes |
