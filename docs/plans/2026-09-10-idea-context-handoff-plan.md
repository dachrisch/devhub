# Idea Context Hand-off (Tier 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thread the full idea-shaping thread (summary + which options were considered/chosen) into the *first* develop prompt for a freshly-promoted issue, instead of the lossy one-paragraph snapshot the issue body already gets.

**Architecture:** A new pure function `buildIdeaContext(topic, messages)` derives an `IdeaContext` (summary + considered options) from data that already exists (`topic.shapedSummary`, `idea_messages.options_json`/`chosen_option`) — no new schema. `promoteTopicForRealize` computes it once, right after creating the GitHub issue. It threads through the existing call chain as one new optional parameter per function — `realizeTopic` → `startWork` → `runRefinement` → `runRefinementInner` → `startDevelop` → `runSingleChildRun` → `buildDevelopPrompt` — landing in a new `## Why this idea was shaped this way` prompt section, placed the same way `## Carry-over from the previous run` already is. Only the very first `startDevelop` call for a freshly-promoted issue ever receives a non-null `ideaContext`; every other caller passes nothing, so the parameter defaults away.

**Tech Stack:** TypeScript, Next.js 15 (App Router), vitest, better-sqlite3. No new dependencies.

**Spec:** `docs/plans/2026-09-09-hub-context-management-design.md` (Tier 2 section, lines 62-96, plus the Data model / Error handling / Testing sections' Tier 2 bullets).

## Global Constraints

- No new DB schema/columns — `IdeaContext` is computed on the fly, never persisted (spec: "Data model changes" → Tier 2: none).
- `buildIdeaContext` is a pure function: no I/O, no DB calls inside it — callers pass already-loaded `Topic`/`IdeaMessage[]`.
- `ideaContext` is optional everywhere it's threaded (`ideaContext?: IdeaContext | null`) — every existing caller of `startWork`/`runRefinement`/`startDevelop` that doesn't pass it keeps working unchanged.
- Only the first develop run for a freshly-promoted issue receives `ideaContext`; retries/later runs never do (spec: "Error handling" / rollout note). This falls out naturally: `realizeTopic` only ever computes a non-null `ideaContext` inside its `issues.length === 0` (freshly-promoted) branch.
- `npm run typecheck` and `npm run lint` must stay clean after every task; `npm test` must stay green (currently 203 passing — see Task 5).
- Follow existing code style: no comments beyond WHY-level, no new abstractions beyond what's specified here.
- Every commit ends with:
  ```
  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Q7E5uvic9H2i27jms4iHWG
  ```

---

### Task 1: `IdeaContext` type + `buildDevelopPrompt` rendering

**Files:**
- Modify: `src/lib/opencode.ts:485-533` (add the `IdeaContext` interface next to `DevelopCarryOver`; extend `buildDevelopPrompt`)
- Test: `src/lib/opencode.test.ts`

**Interfaces:**
- Produces: `export interface IdeaContext { summary: string; considered: { title: string; desc: string; tradeoff?: string; chosen: boolean }[] }` (exported from `src/lib/opencode.ts`)
- Produces: `buildDevelopPrompt(issue, command, run?, carryOver?, ideaContext?: IdeaContext | null): string` — new 5th optional parameter

- [ ] **Step 1: Write the failing test**

Add to `src/lib/opencode.test.ts`, right after the existing `'builds a per-run prompt with the run repo, project branch prefix and carry-over'` test:

```typescript
  it('renders the idea-context section when ideaContext is passed, omits it otherwise', () => {
    const ideaContext = {
      summary: 'Add OAuth login with refresh tokens.',
      considered: [
        { title: 'Session cookies', desc: 'Simple', tradeoff: 'Harder to scale', chosen: false },
        { title: 'OAuth + refresh tokens', desc: 'Industry standard', chosen: true },
      ],
    };
    const withContext = buildDevelopPrompt(sampleIssue as never, '', undefined, undefined, ideaContext);
    expect(withContext).toContain('## Why this idea was shaped this way');
    expect(withContext).toContain('Add OAuth login with refresh tokens.');
    expect(withContext).toContain('[CHOSEN] OAuth + refresh tokens: Industry standard');
    expect(withContext).toContain('Session cookies: Simple (tradeoff: Harder to scale)');

    const withoutContext = buildDevelopPrompt(sampleIssue as never, '');
    expect(withoutContext).not.toContain('## Why this idea was shaped this way');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/opencode.test.ts`
Expected: FAIL — `buildDevelopPrompt` has no 5th parameter yet, so the rendered prompt never contains `## Why this idea was shaped this way` (the `toContain` assertions fail).

- [ ] **Step 3: Write minimal implementation**

In `src/lib/opencode.ts`, change:

```typescript
export interface DevelopCarryOver {
  prUrl: string;
  summary: string;
}

export function buildDevelopPrompt(
  issue: Issue,
  command: string,
  run?: DevelopRun | DevelopRunContext | null,
  carryOver?: DevelopCarryOver | null
): string {
```

to:

```typescript
export interface DevelopCarryOver {
  prUrl: string;
  summary: string;
}

export interface IdeaContext {
  summary: string;
  considered: { title: string; desc: string; tradeoff?: string; chosen: boolean }[];
}

export function buildDevelopPrompt(
  issue: Issue,
  command: string,
  run?: DevelopRun | DevelopRunContext | null,
  carryOver?: DevelopCarryOver | null,
  ideaContext?: IdeaContext | null
): string {
```

Then, right after the existing carry-over block —

```typescript
  if (carryOver?.prUrl) {
    parts.push(
      `## Carry-over from the previous run`,
      `A previous child run in this chain already opened: ${carryOver.prUrl}`,
      carryOver.summary ? `Summary: ${carryOver.summary}` : '',
      `Align with it (shared types, naming, migration order) — do not duplicate its changes here.`,
      '',
    );
  }
```

— add:

```typescript
  if (ideaContext) {
    const optionLines = ideaContext.considered.map(
      (o) => `- ${o.chosen ? '[CHOSEN] ' : ''}${o.title}: ${o.desc}${o.tradeoff ? ` (tradeoff: ${o.tradeoff})` : ''}`
    );
    parts.push(
      `## Why this idea was shaped this way`,
      ideaContext.summary,
      ...(optionLines.length > 0 ? ['', 'Options considered:', ...optionLines] : []),
      ''
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/opencode.test.ts`
Expected: PASS (all tests in the file, including the pre-existing carry-over test).

- [ ] **Step 5: Commit**

```bash
git add src/lib/opencode.ts src/lib/opencode.test.ts
git commit -m "$(cat <<'EOF'
feat(opencode): add IdeaContext type and prompt section

Part of Tier 2 (idea-level context hand-off, see
docs/plans/2026-09-09-hub-context-management-design.md). buildDevelopPrompt
gains an optional ideaContext parameter rendering a new "## Why this idea
was shaped this way" section, placed like the existing carry-over block.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Q7E5uvic9H2i27jms4iHWG
EOF
)"
```

---

### Task 2: `buildIdeaContext` pure function

**Files:**
- Modify: `src/lib/shape-idea.ts` (add function + import)
- Test: `src/lib/shape-idea.test.ts`

**Interfaces:**
- Consumes: `IdeaContext` from `./opencode` (Task 1); `IdeaMessage`, `Topic` from `./types` (already defined: `Topic.shapedSummary: string | null`; `IdeaMessage.options: IdeaOption[] | null`, `IdeaMessage.chosenOption: string | null`; `IdeaOption { id, title, desc, tradeoff?: string | null }`)
- Produces: `export function buildIdeaContext(topic: Topic, messages: IdeaMessage[]): IdeaContext | null`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/shape-idea.test.ts` (this file already imports `store` and dynamically imports `./shape-idea.js` — add `buildIdeaContext` to that existing destructured import, and add a `Topic`/`IdeaMessage` type import from `./types.js`):

```typescript
import type { IdeaMessage, Topic } from './types.js';
```

```typescript
const { buildShapePrompt, parseShapeResult, runShapingRound, buildIdeaContext } = await import('./shape-idea.js');
```

Then add a new `describe` block (anywhere at the top level of the file, alongside the existing ones):

```typescript
describe('buildIdeaContext', () => {
  const baseTopic: Topic = {
    id: 1,
    projectId: null,
    area: null,
    title: 'Add auth',
    notes: null,
    shapedSummary: null,
    status: 'ready',
    mergedIntoTopicId: null,
    readyAt: null,
    origin: 'manual',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
  };

  it('returns null when there is no shaped summary (empty/unshaped thread)', () => {
    expect(buildIdeaContext(baseTopic, [])).toBeNull();
  });

  it('marks the chosen option from the most recent options-bearing message', () => {
    const topic = { ...baseTopic, shapedSummary: 'Add OAuth login with refresh tokens.' };
    const messages: IdeaMessage[] = [
      {
        id: 1,
        topicId: 1,
        role: 'user',
        body: 'how should we do auth?',
        options: null,
        chosenOption: null,
        createdAt: '2026-09-01T00:00:00Z',
      },
      {
        id: 2,
        topicId: 1,
        role: 'assistant',
        body: 'Here are three approaches...',
        options: [
          { id: 'opt-1', title: 'Session cookies', desc: 'Simple, no refresh needed', tradeoff: 'Harder to scale across services' },
          { id: 'opt-2', title: 'OAuth + refresh tokens', desc: 'Industry standard', tradeoff: null },
          { id: 'opt-3', title: 'Magic links', desc: 'No passwords', tradeoff: 'Requires email deliverability' },
        ],
        chosenOption: 'opt-2',
        createdAt: '2026-09-01T00:05:00Z',
      },
    ];
    const result = buildIdeaContext(topic, messages);
    expect(result?.summary).toBe('Add OAuth login with refresh tokens.');
    expect(result?.considered).toEqual([
      { title: 'Session cookies', desc: 'Simple, no refresh needed', tradeoff: 'Harder to scale across services', chosen: false },
      { title: 'OAuth + refresh tokens', desc: 'Industry standard', tradeoff: undefined, chosen: true },
      { title: 'Magic links', desc: 'No passwords', tradeoff: 'Requires email deliverability', chosen: false },
    ]);
  });

  it('returns an empty considered list when no message ever offered options', () => {
    const topic = { ...baseTopic, shapedSummary: 'Just a plain idea, no options offered.' };
    const messages: IdeaMessage[] = [
      {
        id: 1,
        topicId: 1,
        role: 'user',
        body: 'do X',
        options: null,
        chosenOption: null,
        createdAt: '2026-09-01T00:00:00Z',
      },
    ];
    expect(buildIdeaContext(topic, messages)).toEqual({
      summary: 'Just a plain idea, no options offered.',
      considered: [],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/shape-idea.test.ts`
Expected: FAIL with `buildIdeaContext is not a function` (or a TS compile error naming it undefined) — the function doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/shape-idea.ts`, change the top-of-file imports from:

```typescript
import {
  getAvailableModels,
  resolveModels,
  runDevelop,
  sanitizeModels,
  type OpencodeModel,
} from './opencode';
```

to:

```typescript
import {
  getAvailableModels,
  resolveModels,
  runDevelop,
  sanitizeModels,
  type IdeaContext,
  type OpencodeModel,
} from './opencode';
```

Then add this function (anywhere at module scope — e.g. right after `buildShapePrompt`):

```typescript
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
```

`Topic` and `IdeaMessage` are already imported in this file via `import type { IdeaMessage, IdeaOption, Topic } from './types';` (line 19) — no import change needed there.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/shape-idea.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/lib/shape-idea.ts src/lib/shape-idea.test.ts
git commit -m "$(cat <<'EOF'
feat(shape-idea): add buildIdeaContext pure function

Derives IdeaContext (summary + considered options, marking the chosen
one) from the topic's shapedSummary and the most recent options-bearing
idea_messages row — no new schema, computed on demand. Part of Tier 2
(see docs/plans/2026-09-09-hub-context-management-design.md).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Q7E5uvic9H2i27jms4iHWG
EOF
)"
```

---

### Task 3: Thread `ideaContext` through the develop chain in `develop.ts`

**Files:**
- Modify: `src/lib/develop.ts` (5 functions: `runSingleChildRun`, `startDevelop`, `runRefinement`, `runRefinementInner`, `startWork`)

**Interfaces:**
- Consumes: `IdeaContext` type from `./opencode` (Task 1); `buildDevelopPrompt`'s new 5th parameter (Task 1)
- Produces: `startWork(issue, command, token, selectedModel?, ideaContext?: IdeaContext | null): Promise<void>` — new 5th optional parameter (this is the only one of the 5 changed functions called from outside `develop.ts`; the other 4 are module-private and only need to match each other)

No new test in this task — `develop.ts`'s orchestration layer (`startWork`/`runRefinement`/`startDevelop`/`runSingleChildRun`) has no existing unit-test coverage of its opencode-calling behavior (confirmed: only `canDevelop`/`planRunsForIssue`, both pure, are tested in `develop.test.ts`; the `DevelopCarryOver` threading added earlier has the same lack of coverage at this layer). This matches the spec's own Testing section, which lists only `buildIdeaContext` and `buildDevelopPrompt` as needing new tests. Verify via the full suite + typecheck in Task 5 instead.

- [ ] **Step 1: Add the import**

In `src/lib/develop.ts`, change:

```typescript
import {
  buildDevelopPrompt,
  extractPrUrl,
  getAvailableModels,
  repoPathFor,
  resolveModels,
  runDevelop,
  sanitizeModels,
  type DevelopCarryOver,
  type OpencodeEvent,
  type OpencodeModel,
} from './opencode';
```

to:

```typescript
import {
  buildDevelopPrompt,
  extractPrUrl,
  getAvailableModels,
  repoPathFor,
  resolveModels,
  runDevelop,
  sanitizeModels,
  type DevelopCarryOver,
  type IdeaContext,
  type OpencodeEvent,
  type OpencodeModel,
} from './opencode';
```

- [ ] **Step 2: Thread through `runSingleChildRun`**

Change:

```typescript
async function runSingleChildRun(
  issue: Issue,
  run: DevelopRun,
  command: string,
  token: string,
  models: OpencodeModel[],
  projectId: number | null,
  carryOver: DevelopCarryOver | null,
  onCarryOver: (next: DevelopCarryOver) => void
): Promise<void> {
```

to:

```typescript
async function runSingleChildRun(
  issue: Issue,
  run: DevelopRun,
  command: string,
  token: string,
  models: OpencodeModel[],
  projectId: number | null,
  carryOver: DevelopCarryOver | null,
  onCarryOver: (next: DevelopCarryOver) => void,
  ideaContext: IdeaContext | null = null
): Promise<void> {
```

and its `buildDevelopPrompt` call from:

```typescript
    const prompt = buildDevelopPrompt(
      issue,
      command,
      { role: run.role, repoOwner: run.repoOwner, repoName: run.repoName, projectId },
      carryOver
    );
```

to:

```typescript
    const prompt = buildDevelopPrompt(
      issue,
      command,
      { role: run.role, repoOwner: run.repoOwner, repoName: run.repoName, projectId },
      carryOver,
      ideaContext
    );
```

- [ ] **Step 3: Thread through `startDevelop`**

Change the signature from:

```typescript
export async function startDevelop(
  issue: Issue,
  command: string,
  token: string,
  selectedModel?: OpencodeModel | null
): Promise<void> {
```

to:

```typescript
export async function startDevelop(
  issue: Issue,
  command: string,
  token: string,
  selectedModel?: OpencodeModel | null,
  ideaContext?: IdeaContext | null
): Promise<void> {
```

Change the run loop from:

```typescript
  try {
    for (const run of runs) {
      const fresh = getRunsForIssue(issue.id).find((r) => r.id === run.id) ?? run;
      // Skip runs that already produced a PR — retry touches only failed/missing.
      if (fresh.state === 'pr' || fresh.state === 'merged' || fresh.state === 'released') {
        if (fresh.prUrl) carryOver = { prUrl: fresh.prUrl, summary: (fresh.resultText ?? '').slice(0, 2000) };
        continue;
      }
      await runSingleChildRun(issue, fresh, command, token, models, projectId, carryOver, (next) => {
        carryOver = next;
      });
```

to:

```typescript
  try {
    for (const [index, run] of runs.entries()) {
      const fresh = getRunsForIssue(issue.id).find((r) => r.id === run.id) ?? run;
      // Skip runs that already produced a PR — retry touches only failed/missing.
      if (fresh.state === 'pr' || fresh.state === 'merged' || fresh.state === 'released') {
        if (fresh.prUrl) carryOver = { prUrl: fresh.prUrl, summary: (fresh.resultText ?? '').slice(0, 2000) };
        continue;
      }
      await runSingleChildRun(
        issue,
        fresh,
        command,
        token,
        models,
        projectId,
        carryOver,
        (next) => {
          carryOver = next;
        },
        index === 0 ? (ideaContext ?? null) : null
      );
```

(Only the first entry in the run plan ever receives `ideaContext` — correct because `ideaContext` is only ever non-null when `startDevelop` is called for a issue that was *just* promoted, i.e. its runs were just freshly created by `ensureRuns` a few lines above and none can already be in a completed state.)

- [ ] **Step 4: Thread through `runRefinement` and `runRefinementInner`**

Change:

```typescript
async function runRefinement(
  issue: Issue,
  command: string,
  token: string,
  selectedModel?: OpencodeModel | null
): Promise<void> {
  if (liveRefinementRuns.has(issue.id)) return;
  liveRefinementRuns.add(issue.id);
  try {
    await runRefinementInner(issue, command, token, selectedModel);
  } finally {
    liveRefinementRuns.delete(issue.id);
  }
}
```

to:

```typescript
async function runRefinement(
  issue: Issue,
  command: string,
  token: string,
  selectedModel?: OpencodeModel | null,
  ideaContext?: IdeaContext | null
): Promise<void> {
  if (liveRefinementRuns.has(issue.id)) return;
  liveRefinementRuns.add(issue.id);
  try {
    await runRefinementInner(issue, command, token, selectedModel, ideaContext);
  } finally {
    liveRefinementRuns.delete(issue.id);
  }
}
```

Change:

```typescript
async function runRefinementInner(
  issue: Issue,
  command: string,
  token: string,
  selectedModel?: OpencodeModel | null
): Promise<void> {
```

to:

```typescript
async function runRefinementInner(
  issue: Issue,
  command: string,
  token: string,
  selectedModel?: OpencodeModel | null,
  ideaContext?: IdeaContext | null
): Promise<void> {
```

And its final call, from:

```typescript
  // Proceed to develop with the freshly-loaded issue — the body may have been
  // refined above, and the develop prompt must implement the improved text.
  const fresh = getIssue(issue.id) ?? issue;
  await startDevelop(fresh, command, token, selectedModel);
}
```

to:

```typescript
  // Proceed to develop with the freshly-loaded issue — the body may have been
  // refined above, and the develop prompt must implement the improved text.
  const fresh = getIssue(issue.id) ?? issue;
  await startDevelop(fresh, command, token, selectedModel, ideaContext);
}
```

- [ ] **Step 5: Thread through `startWork`**

Change:

```typescript
export async function startWork(
  issue: Issue,
  command: string,
  token: string,
  selectedModel?: OpencodeModel | null
): Promise<void> {
  if (issue.state === 'backlog') {
    const moved = setIssueState(issue.id, 'refinement');
    if (moved) publishIssue(moved);
    void mirrorLabels(issue, 'refinement', token);
    return await runRefinement(moved ?? issue, command, token, selectedModel);
  }

  if (issue.state === 'refinement') {
    return await runRefinement(issue, command, token, selectedModel);
  }

  if (issue.state === 'developing') {
    // Only reachable when a previous run failed (see canDevelop): a live run
    // must never get a concurrent duplicate session in the same worktree.
    clearBlockedReason(issue.id);
    return await startDevelop(issue, command, token, selectedModel);
  }

  // pr / rollout / closed — nothing to do.
}
```

to:

```typescript
export async function startWork(
  issue: Issue,
  command: string,
  token: string,
  selectedModel?: OpencodeModel | null,
  ideaContext?: IdeaContext | null
): Promise<void> {
  if (issue.state === 'backlog') {
    const moved = setIssueState(issue.id, 'refinement');
    if (moved) publishIssue(moved);
    void mirrorLabels(issue, 'refinement', token);
    return await runRefinement(moved ?? issue, command, token, selectedModel, ideaContext);
  }

  if (issue.state === 'refinement') {
    return await runRefinement(issue, command, token, selectedModel, ideaContext);
  }

  if (issue.state === 'developing') {
    // Only reachable when a previous run failed (see canDevelop): a live run
    // must never get a concurrent duplicate session in the same worktree.
    clearBlockedReason(issue.id);
    return await startDevelop(issue, command, token, selectedModel, ideaContext);
  }

  // pr / rollout / closed — nothing to do.
}
```

- [ ] **Step 6: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors (all 5 functions' signatures and call sites now agree).

- [ ] **Step 7: Commit**

```bash
git add src/lib/develop.ts
git commit -m "$(cat <<'EOF'
feat(develop): thread ideaContext through the develop chain

startWork -> runRefinement -> runRefinementInner -> startDevelop ->
runSingleChildRun each gain an optional ideaContext parameter, passed
straight through to buildDevelopPrompt. Only the first entry in a fresh
run plan ever receives it (see startDevelop's run loop) -- every
existing caller that omits the parameter is unaffected. Part of Tier 2
(see docs/plans/2026-09-09-hub-context-management-design.md).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Q7E5uvic9H2i27jms4iHWG
EOF
)"
```

---

### Task 4: Wire `realize.ts` — compute `ideaContext` at promotion, pass to `startWork`

**Files:**
- Modify: `src/lib/realize.ts`

**Interfaces:**
- Consumes: `buildIdeaContext` from `./shape-idea` (Task 2); `IdeaContext` type from `./opencode` (Task 1); `getIdeaMessages` from `./store` (already exists: `getIdeaMessages(topicId: number): IdeaMessage[]`); `startWork`'s new 5th parameter (Task 3)
- Produces: `promoteTopicForRealize`'s return type changes from `Promise<void>` to `Promise<IdeaContext | null>` (module-private, only one call site — see Step 2)

No new test in this task, for the same reason as Task 3: `realize.test.ts` only covers the pure `canRealize`/`realizeStage` functions, never `realizeTopic`/`promoteTopicForRealize` (which call GitHub/opencode). Verify via the full suite + typecheck in Task 5.

- [ ] **Step 1: Add imports**

Change:

```typescript
import {
  assignIssue,
  getIssue,
  getIssuesByTopic,
  getProject,
  getRunsForIssue,
  getTopic,
  refreshTopicStatus,
  setBlockedReason,
  updateRun,
  updateTopic,
  upsertIssue,
} from './store';
import { canDevelop, startWork } from './develop';
import { createGithubIssue, sweepRollouts } from './github';
import { autoMergeAndRelease } from './auto-merge';
import { publishIssue, publishRun, publishTopic } from './sse';
import { ENV } from './env';
import type { OpencodeModel } from './opencode';
import type { Issue, Topic } from './types';
```

to:

```typescript
import {
  assignIssue,
  getIdeaMessages,
  getIssue,
  getIssuesByTopic,
  getProject,
  getRunsForIssue,
  getTopic,
  refreshTopicStatus,
  setBlockedReason,
  updateRun,
  updateTopic,
  upsertIssue,
} from './store';
import { canDevelop, startWork } from './develop';
import { buildIdeaContext } from './shape-idea';
import { createGithubIssue, sweepRollouts } from './github';
import { autoMergeAndRelease } from './auto-merge';
import { publishIssue, publishRun, publishTopic } from './sse';
import { ENV } from './env';
import type { IdeaContext, OpencodeModel } from './opencode';
import type { Issue, Topic } from './types';
```

- [ ] **Step 2: Change `promoteTopicForRealize` to compute and return `IdeaContext`**

Change:

```typescript
async function promoteTopicForRealize(topic: Topic, token: string): Promise<void> {
  const project = topic.projectId != null ? getProject(topic.projectId) : null;
  const owner = project?.serviceRepoOwner;
  const repo = project?.serviceRepoName;
  if (!owner || !repo) {
    throw new Error('topic has no service repo (assign it to a project first)');
  }
  const title = topic.title;
  const issueBody =
    [topic.notes, topic.shapedSummary ? `Shaped: ${topic.shapedSummary}` : null, topic.area ? `Area: ${topic.area}` : null]
      .filter(Boolean)
      .join('\n\n') || null;
  const created = await createGithubIssue(owner, repo, title, issueBody, token);
  const stored = upsertIssue({
    githubIssueId: 0,
    owner,
    repo,
    number: created.number,
    title,
    body: issueBody,
    htmlUrl: created.htmlUrl,
  });
  const withLinks = assignIssue(stored.id, { projectId: project!.id, topicId: topic.id });
  if (withLinks) publishIssue(withLinks);
  updateTopic(topic.id, { status: 'realizing' });
  refreshTopicStatus(topic.id);
  publishTopic(topic.id);
}
```

to:

```typescript
async function promoteTopicForRealize(topic: Topic, token: string): Promise<IdeaContext | null> {
  const project = topic.projectId != null ? getProject(topic.projectId) : null;
  const owner = project?.serviceRepoOwner;
  const repo = project?.serviceRepoName;
  if (!owner || !repo) {
    throw new Error('topic has no service repo (assign it to a project first)');
  }
  const title = topic.title;
  const issueBody =
    [topic.notes, topic.shapedSummary ? `Shaped: ${topic.shapedSummary}` : null, topic.area ? `Area: ${topic.area}` : null]
      .filter(Boolean)
      .join('\n\n') || null;
  const created = await createGithubIssue(owner, repo, title, issueBody, token);
  const stored = upsertIssue({
    githubIssueId: 0,
    owner,
    repo,
    number: created.number,
    title,
    body: issueBody,
    htmlUrl: created.htmlUrl,
  });
  const withLinks = assignIssue(stored.id, { projectId: project!.id, topicId: topic.id });
  if (withLinks) publishIssue(withLinks);
  updateTopic(topic.id, { status: 'realizing' });
  refreshTopicStatus(topic.id);
  publishTopic(topic.id);
  return buildIdeaContext(topic, getIdeaMessages(topic.id));
}
```

- [ ] **Step 3: Compute and pass `ideaContext` in `realizeTopic`**

Change:

```typescript
    // Promote first when the idea has no linked issue yet (same contract as
    // POST /api/topics/[id]/promote: always creates the GitHub issue).
    let issues = getIssuesByTopic(topicId);
    if (issues.length === 0) {
      await promoteTopicForRealize(topic, token);
      issues = getIssuesByTopic(topicId);
    }
    const issue = issues.find((i) => canDevelop(i)) ?? issues[0];
    if (issue && decision.action === 'full' && canDevelop(getIssue(issue.id) ?? issue)) {
      // Await the Work chain (refinement → develop → PR) before the sweep
      // wait so failures surface here with the run's blocked_reason intact.
      await startWork(getIssue(issue.id) ?? issue, opts.command ?? '', token, opts.selectedModel ?? null);
    }
```

to:

```typescript
    // Promote first when the idea has no linked issue yet (same contract as
    // POST /api/topics/[id]/promote: always creates the GitHub issue).
    let issues = getIssuesByTopic(topicId);
    let ideaContext: IdeaContext | null = null;
    if (issues.length === 0) {
      ideaContext = await promoteTopicForRealize(topic, token);
      issues = getIssuesByTopic(topicId);
    }
    const issue = issues.find((i) => canDevelop(i)) ?? issues[0];
    if (issue && decision.action === 'full' && canDevelop(getIssue(issue.id) ?? issue)) {
      // Await the Work chain (refinement → develop → PR) before the sweep
      // wait so failures surface here with the run's blocked_reason intact.
      await startWork(getIssue(issue.id) ?? issue, opts.command ?? '', token, opts.selectedModel ?? null, ideaContext);
    }
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/realize.ts
git commit -m "$(cat <<'EOF'
feat(realize): pass idea context to the first develop run

promoteTopicForRealize now returns the freshly-promoted issue's
IdeaContext (derived from the topic's shaping thread), and realizeTopic
threads it through startWork -- only on the fresh-promotion path,
never on a retry. Completes Tier 2
(docs/plans/2026-09-09-hub-context-management-design.md).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Q7E5uvic9H2i27jms4iHWG
EOF
)"
```

---

### Task 5: Full verification + draft PR

**Files:** none (verification + PR only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass (203 pre-existing + 4 new from Tasks 1-2 = 207).

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: no new errors (pre-existing unrelated warnings are fine — see the 5 warnings noted in the Tier-1 directory-binding PR, all in unrelated files).

- [ ] **Step 4: Push the branch and open a draft PR**

```bash
git push -u origin docs/idea-context-handoff
gh pr create --draft --title "feat: idea context hand-off to first develop run (Tier 2)" --body "$(cat <<'EOF'
## Summary
- Implements Tier 2 of docs/plans/2026-09-09-hub-context-management-design.md: threads the full idea-shaping thread (summary + which options were considered/chosen) into the *first* develop prompt for a freshly-promoted issue, instead of the lossy one-paragraph snapshot the issue body gets today.
- New `IdeaContext` type + `buildDevelopPrompt` renders a `## Why this idea was shaped this way` section when present (src/lib/opencode.ts).
- New pure `buildIdeaContext(topic, messages)` derives it from data that already exists — no new schema (src/lib/shape-idea.ts).
- Threaded as one new optional parameter through `startWork` -> `runRefinement` -> `runRefinementInner` -> `startDevelop` -> `runSingleChildRun` (src/lib/develop.ts) and computed once in `promoteTopicForRealize`, passed by `realizeTopic` (src/lib/realize.ts) -- only on the fresh-promotion path, never on retries.

## Test plan
- [ ] `npm test` — full suite green
- [ ] `npm run typecheck` — clean
- [ ] `npm run lint` — clean

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01Q7E5uvic9H2i27jms4iHWG
EOF
)"
```

- [ ] **Step 5: Report the PR URL back**

The `gh pr create` command prints the PR URL — relay it as the final deliverable.

## Self-Review Notes (for whoever executes this plan)

- **Spec coverage:** `IdeaContext` type (Task 1), `buildIdeaContext` (Task 2), `buildDevelopPrompt` rendering (Task 1), `promoteTopicForRealize` call site (Task 4), "only first run" behavior (Task 3 Step 3), issue body unchanged (no task touches it — confirmed untouched), Tier 2 testing section (Tasks 1 & 2's tests are exactly the two cases the spec names, plus one extra edge case for robustness).
- **Deviation from the spec's literal wording, called out on purpose:** the spec says `buildIdeaContext` lives in `shape-idea.ts` and is called by `promoteTopicForRealize` — both true here. It also implies `promoteTopicForRealize` "passes the result through to the first `startDevelop` call" directly; in the actual code, a freshly-created issue starts in `backlog` state, so the real path is `startWork` -> `runRefinement` -> `runRefinementInner` -> `startDevelop` (refinement runs first, same as any other issue). Task 3 threads through all of those, not just `startDevelop` — this is a wider (but still small and mechanical) change than the spec's one-line description suggested, discovered by reading the actual `startWork` state-machine dispatch in `develop.ts:334-359`.
