# DevHub v2 Command-First Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the v1 board shell with the v2 command-first, phone-first UI while keeping the engine (opencode driver, store, GitHub sync, transitions, auth, #132 flow) unchanged.

**Architecture:** Additive backend first (`threads`/`thread_events` tables, `resolve` intent/mapping library, `plan` split library, serial work queue), then thin API routes over them, then a single-column UI (cards + bottom dock + detail view), then E2E, then delete the v1 shell in the same change.

**Tech Stack:** Next.js 15 App Router, better-sqlite3, vitest, Web Speech API (browser-only mic), existing opencode driver + SSE broadcaster.

---

### Task 1: Feature branch + thread schema (store)

**Files:**
- Modify: `src/lib/types.ts` (Thread, ThreadEvent types + serializers)
- Modify: `src/lib/store.ts` (migration + CRUD: createThread, getThread, listThreads, updateThread, appendThreadEvent, getThreadEvents)
- Test: `src/lib/threads.test.ts` (new — migration + CRUD + blocked_reason round-trip)

**Step 1: Write the failing test**

```typescript
// src/lib/threads.test.ts
import { describe, expect, test, beforeEach } from 'vitest';
// uses temp DB via ENV override like store.test.ts — read store.test.ts first for the pattern
describe('threads', () => {
  test('creates a work thread in refining state', () => {
    const t = createThread({ kind: 'work', title: 'Implement #132', issueIds: [] });
    expect(t.state).toBe('refining');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/threads.test.ts`
Expected: FAIL with "createThread is not defined"

**Step 3: Write minimal implementation**

- `types.ts`: `ThreadKind = 'work' | 'strategy'`, `ThreadState = 'refining' | 'planning' | 'ready' | 'blocked' | 'done'`, `Thread`, `ThreadEventRow`, `ThreadEvent` + serializers.
- `store.ts` `migrate()`: `CREATE TABLE IF NOT EXISTS threads (id, kind, issue_ids JSON default '[]', title, state, session_id NULL, summary_json NULL, created_at, updated_at)` + `thread_events (id, thread_id FK, kind, text, ts)`. No ALTER TABLE guards needed (new tables).
- CRUD: `createThread({kind,title,issueIds})` (work→`refining`, strategy→`planning`), `getThread`, `listThreads` (updated_at DESC), `updateThread(id, patch)`, `appendThreadEvent(threadId, kind, text)`, `getThreadEvents(threadId)`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/threads.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/store.ts src/lib/threads.test.ts
git commit -m "feat(v2): threads and thread_events schema + CRUD"
```

Note: create branch first: `git checkout -b v2-command-first`.

---

### Task 2: Resolve library (intent + repo mapping + chips)

**Files:**
- Create: `src/lib/resolve.ts`
- Test: `src/lib/resolve.test.ts`

**Step 1: Write the failing test**

```typescript
import { resolveCommand } from './resolve';
test('maps XY shorthand against the repo list', () => {
  const r = resolveCommand('implement login in XY', ['dachrisch/xy-app', 'bumbleflies/warehouse']);
  expect(r.intent).toBe('implement');
  expect(r.targets).toEqual(['dachrisch/xy-app']);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/resolve.test.ts`
Expected: FAIL with "resolveCommand is not defined"

**Step 3: Write minimal implementation**

Pure functions, no I/O:
- `parseIntent(text, openThreadCount)`: `implement` (default, one target) | `strategy` (keywords: strategy, combined, across, both repos, and between repos / 2+ repo mentions) | `question` (open thread exists AND text has no repo mention and is short follow-up — keep simple: explicit `openThreadId` param forces `question`).
- `mapRepos(text, repoList)`: case-insensitive shorthand match — last path segment match (`XY` → `xy-app` via normalized compare stripping `-app`/`-api` suffixes and non-alphanumerics), plus full `owner/repo` match, plus `#123` issue refs extracted. Returns `{ matched: string[], ambiguous: {chip, options}[], unmatched: string[] }`.
- `resolveCommand(text, repoList, opts)`: `{ intent, targets, chips }` where chips are `{ kind: 'repo-choice'|'issue-search'|'confirm', ... }` — never silently guess: unmatched/ambiguous → chips.
- `formatMention(owner, repo, number?)` for the "Command on / Combine" prefill (`Implement #132` style).

Cover: implement single, strategy multi, question-with-thread, unknown repo → chips, ambiguous shorthand → choose-one chip, issue-number extraction.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/resolve.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/resolve.ts src/lib/resolve.test.ts
git commit -m "feat(v2): command resolve — intent, repo mapping, chips"
```

---

### Task 3: Plan library (context brief + split shape + cap)

**Files:**
- Create: `src/lib/plan.ts`
- Test: `src/lib/plan.test.ts`

**Step 1: Write the failing test**

```typescript
import { buildContextBrief, capSplitProposal } from './plan';
test('caps split proposals at 10', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ repo: 'a/b', title: `t${i}`, body: '', why: '' }));
  const capped = capSplitProposal(items);
  expect(capped).toHaveLength(10);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/plan.test.ts`
Expected: FAIL with "capSplitProposal is not defined"

**Step 3: Write minimal implementation**

- `buildContextBrief(issues)`: groups open + recently-closed (~30d) issues per repo → `{ repo, items: [{number, title, gist}] }` where gist = first paragraph of body (≤200 chars), never raw bodies. Pure function over serialized Issues.
- `parseSplitProposal(text)`: extracts `{repo, title, body, why}` records from planner output — accept JSON array in a fenced block OR `### repo/title` sections; returns `[]` when nothing parses (caller sets blocked_reason).
- `capSplitProposal(items, cap = 10)`: slice + `{ capped: boolean, offered: number }`.
- `buildPlannerPrompt(brief, userText)`: instructs planner to end turns in strategy content, follow-up questions, or a split proposal, and to cap at 10.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/plan.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/plan.ts src/lib/plan.test.ts
git commit -m "feat(v2): plan library — context brief, split parse + cap"
```

---

### Task 4: Thread lifecycle + serial work queue

**Files:**
- Create: `src/lib/threads-run.ts` (lifecycle: startWorkThread, startStrategyThread, replyToThread, confirmSplit) — reuse `startWork`/`startDevelop` from `develop.ts`, `runDevelop` from `opencode.ts`, `buildContextBrief` from `plan.ts`
- Test: `src/lib/threads-run.test.ts` (state machine + queue with mocked opencode/github — follow `develop.test.ts` mock pattern)

**Step 1: Write the failing test**

```typescript
test('serial queue runs one developing issue at a time', async () => {
  // enqueue two confirmed split cards; assert queuePosition 1/2 and only one developing run live
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/threads-run.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

- Thread states: work `refining → developing → done` (+ `blocked_reason` on thread row? No — reuse issue `blocked_reason`; thread `blocked` state mirrors it). Strategy `planning → ready → done`; empty planner output → stays `planning` + blocked_reason on thread (add `blocked_reason TEXT` column? No — store it as a `system` thread_event with kind prefix `blocked:`; keeps schema to the design's two tables).
- `startWorkThread(threadId, issueId, command, token, model)`: creates card in `refining`, delegates to existing `startWork` — no new develop logic.
- `startStrategyThread(threadId, userText, targets, token)`: builds context brief from `getIssues()` filtered to targets, runs planner via `runDevelop` with 2× refinement poll budget, appends turns to `thread_events`, parses split proposals onto the last event.
- `replyToThread(threadId, text)`: appends `user` event, resumes planner/develop run (same pattern as Work resume).
- Serial queue: `enqueueWork(issueIds)` processes confirmed cards one at a time (`canDevelop` gate per issue); `getQueuePosition(issueId)` for the card badge. Process-local like `liveRefinementRuns`.
- Split confirm: `confirmSplit(threadId, acceptedIndices, editedTitles, token)` → creates GitHub issues (via existing `create-issue` skill path or `github.ts` create helper) topic-tagged, then enqueues.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/threads-run.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/threads-run.ts src/lib/threads-run.test.ts
git commit -m "feat(v2): thread lifecycle + serial work queue"
```

---

### Task 5: Thread API routes + SSE

**Files:**
- Create: `src/app/api/threads/route.ts` (GET list, POST command → resolve → create thread + start run, 202)
- Create: `src/app/api/threads/[id]/route.ts` (GET detail: thread + events + linked issues)
- Create: `src/app/api/threads/[id]/reply/route.ts` (POST reply → resume)
- Create: `src/app/api/threads/[id]/confirm/route.ts` (POST split confirm → create issues + enqueue)
- Modify: `src/lib/sse.ts` (add `thread` / `thread-event` ServerEvents + publishers)
- Test: extend `src/lib/threads.test.ts` or new `src/app/api/threads/route.test.ts`? Follow existing route-test pattern if any; else unit-test the handler logic via resolve/threads-run (no new HTTP test infra).

**Step 1: Write the failing test** (SSE publish + thread detail assembly)

**Step 2-4:** Implement with `export const runtime = 'nodejs'` + `export const dynamic = 'force-dynamic'`, session auth like `/api/issues*` (read an existing route first for the exact guard). POST command runs the single-opencode-call pipeline with the current refinement model.

**Step 5: Commit**

```bash
git add src/app/api/threads src/lib/sse.ts
git commit -m "feat(v2): thread API routes + SSE"
```

---

### Task 6: v2 UI — cards, dock, detail, mic

**Files:**
- Modify: `src/app/(board)/page.tsx` → replace with v2 home (single-column cards, active first; Needs-input banner; bottom dock with command bar + mic; selection prefill "Command on"/"Combine")
- Create: `src/components/threads/thread-card.tsx`, `src/components/threads/command-dock.tsx` (Web Speech API mic, transcript-only), `src/components/threads/thread-detail.tsx` (work thread: issue body + progress + reply; strategy thread: chat + split chips confirm/drop/edit)
- Killed in this task: batch mode UI, funnel/burnup, dashboard, taz tiles, per-stage nav from the home page.

Keep everything else rendering OK wide; phone-first CSS. Reuse `status-pill`, `markdown`, existing SSE hook pattern.

**Step 1-4:** No unit tests for UI (project has none for components) — verify via `typecheck` + `lint` + manual/headless pass. Verify: `npm run typecheck && npm run lint`.

**Step 5: Commit**

```bash
git add src/app src/components/threads
git commit -m "feat(v2): command-first UI — cards, dock, detail, mic"
```

---

### Task 7: E2E strategy-thread scenario

**Files:**
- Modify: `scripts/dev/mock-opencode.mjs` (add `planner` scenario: streams strategy turns + split proposal)
- Modify: `scripts/dev/e2e-workflow.mjs` (add S9: command → strategy thread → chips confirm (≤10 cap) → real GitHub issues → serial queue → pr; assert chip-confirm gate blocks auto-creation)

**Step 1:** Run existing E2E baseline first: `node scripts/dev/start-dev.mjs --port 3111` + `node scripts/dev/e2e-workflow.mjs --url http://localhost:3111` must PASS before changes.

**Step 2:** Implement mock + scenario, run full E2E, expect PASS.

**Step 3: Commit**

```bash
git add scripts/dev/mock-opencode.mjs scripts/dev/e2e-workflow.mjs
git commit -m "test(v2): e2e strategy-thread scenario with chip gate + serial queue"
```

---

### Task 8: Delete v1 shell + full verification

**Files:**
- Delete: board grid/columns (`kanban-board.tsx`, `batch-actions.tsx`, board toolbar/batch routes), funnel/burnup, summary dashboard, taz tiles, per-stage navigation pages, `POST /api/issues/batch-advance`, and their tests.
- Keep: `transitions.ts` (`backlog ⇄ refinement` expressible), all engine + engine tests.

**Step 1:** Delete files, fix imports until `npm run typecheck` passes.
**Step 2:** `npm run lint` passes.
**Step 3:** `npm test` (vitest) passes.
**Step 4:** `npm run build` passes.
**Step 5:** Full E2E passes.

```bash
git add -A
git commit -m "feat(v2)!: delete v1 board shell (one cut, schema additive)"
```

---

## Open risk (verify in first spike, before polishing strategy flow)

Auto-approve behavior on `code.lehel.xyz` and WORKSPACE_ROOT visibility are unverified — this determines whether v2 feels hands-off. Spike: trigger one real develop run against the checkout layout and confirm a PR opens without manual approval.
