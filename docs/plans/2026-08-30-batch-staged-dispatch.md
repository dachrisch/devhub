# Batch & Staged Dispatch Automation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add batch selection UI and a validate-then-implement gate to push multiple backlog issues through the pipeline without repeating manual clicks.

**Architecture:** Two-phase approach: (1) Add batch selection state to the board UI with an "Advance selected" action, (2) Implement a validate-then-implement flow where a lightweight opencode session validates issue readiness before dispatching the full develop session. Deterministic checks drive most transitions; opencode only used for judgment calls.

**Tech Stack:** Next.js 15 App Router, React, TypeScript, better-sqlite3, opencode API

---

## Task 1: Add batch selection state and UI to the board

**Files:**
- Modify: `src/app/(board)/page.tsx:109-385` (BoardPage component)

**Step 1: Add batch selection state**

Add state for tracking selected issue IDs and a function to toggle selection:

```typescript
// In BoardPage component, after existing state declarations
const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

const toggleSelection = useCallback((issueId: number) => {
  setSelectedIds((prev) => {
    const next = new Set(prev);
    if (next.has(issueId)) {
      next.delete(issueId);
    } else {
      next.add(issueId);
    }
    return next;
  });
}, []);

const clearSelection = useCallback(() => {
  setSelectedIds(new Set());
}, []);
```

**Step 2: Add "Advance selected" button to header**

Add a button in the header that appears when issues are selected:

```typescript
// In the header section, after the refresh button
{selectedIds.size > 0 && (
  <button
    className="advance-btn"
    onClick={() => {
      // Will be implemented in Task 2
      console.log('Advance selected:', Array.from(selectedIds));
    }}
    disabled={refreshing}
  >
    Advance selected ({selectedIds.size})
  </button>
)}
```

**Step 3: Add checkbox to Card component**

Modify the Card component to accept selection state and toggle function:

```typescript
// Update Card component props
interface CardProps {
  issue: Issue;
  selected: boolean;
  onToggleSelection: (issueId: number) => void;
}

function Card({ issue, selected, onToggleSelection }: CardProps) {
  // Add checkbox in card header
  return (
    <div className="card" style={{ borderLeftColor: color }}>
      <div className="card-header">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelection(issue.id)}
          className="card-checkbox"
        />
        <div className="repo">
          {/* existing repo content */}
        </div>
      </div>
      {/* rest of card content */}
    </div>
  );
}
```

**Step 4: Pass selection props to Card components**

Update the Card rendering in the board to pass selection props:

```typescript
// In the column rendering section
items.map((issue) => (
  <Card
    key={issue.id}
    issue={issue}
    selected={selectedIds.has(issue.id)}
    onToggleSelection={toggleSelection}
  />
))
```

**Step 5: Add CSS for batch selection UI**

Add styles for the checkbox and advance button:

```css
/* In global.css or appropriate stylesheet */
.card-header {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.card-checkbox {
  margin-top: 4px;
  cursor: pointer;
}

.advance-btn {
  background: var(--accent);
  color: white;
  border: none;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 13px;
  cursor: pointer;
}

.advance-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

**Step 6: Commit**

```bash
git add src/app/\(board\)/page.tsx
git commit -m "feat: add batch selection UI to board"
```

---

## Task 2: Create batch advance API endpoint

**Files:**
- Create: `src/app/api/issues/batch-advance/route.ts`
- Modify: `src/lib/transitions.ts`

**Step 1: Define batch advance transitions**

Update `src/lib/transitions.ts` to support batch operations:

```typescript
// Add batch transition logic
export const BATCH_ADVANCE_TRANSITIONS: Partial<Record<IssueState, IssueState>> = {
  backlog: 'refinement',
  refinement: 'backlog',  // Can be used to send back if validation fails
};

export function canBatchAdvance(from: IssueState): boolean {
  return from in BATCH_ADVANCE_TRANSITIONS;
}

export function getBatchAdvanceTarget(from: IssueState): IssueState | null {
  return BATCH_ADVANCE_TRANSITIONS[from] ?? null;
}
```

**Step 2: Create batch advance API route**

Create `src/app/api/issues/batch-advance/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getIssue, setIssueState } from '@/lib/store';
import { publishIssue } from '@/lib/sse';
import { setIssueStateLabels } from '@/lib/github';
import { canBatchAdvance, getBatchAdvanceTarget } from '@/lib/transitions';
import { UnauthorizedError, ForbiddenError, requireMember } from '@/lib/auth';

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

  const body = (await req.json().catch(() => ({}))) as { issueIds?: unknown };
  const issueIds = Array.isArray(body.issueIds) ? body.issueIds.filter((id): id is number => typeof id === 'number') : [];
  
  if (issueIds.length === 0) {
    return NextResponse.json({ error: 'no issue IDs provided' }, { status: 400 });
  }

  const results: Array<{ id: number; success: boolean; error?: string }> = [];
  
  for (const issueId of issueIds) {
    const issue = getIssue(issueId);
    if (!issue) {
      results.push({ id: issueId, success: false, error: 'not found' });
      continue;
    }

    if (!canBatchAdvance(issue.state)) {
      results.push({ id: issueId, success: false, error: `cannot advance from '${issue.state}'` });
      continue;
    }

    const target = getBatchAdvanceTarget(issue.state);
    if (!target) {
      results.push({ id: issueId, success: false, error: 'no target state' });
      continue;
    }

    const updated = setIssueState(issue.id, target);
    if (updated) {
      publishIssue(updated);
      void setIssueStateLabels(issue.owner, issue.repo, issue.number, target, session.token).catch(() => {});
      results.push({ id: issueId, success: true });
    } else {
      results.push({ id: issueId, success: false, error: 'update failed' });
    }
  }

  return NextResponse.json({ ok: true, results });
}
```

**Step 3: Wire up the advance button in the UI**

Update the advance button click handler in `src/app/(board)/page.tsx`:

```typescript
// Replace the console.log in the advance button onClick
const advanceSelected = useCallback(async () => {
  if (selectedIds.size === 0) return;
  
  setRefreshing(true);
  try {
    const res = await fetch('/api/issues/batch-advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueIds: Array.from(selectedIds) }),
    });
    
    if (!res.ok) {
      const data = await res.json() as { error?: string };
      throw new Error(data.error || `batch advance failed (HTTP ${res.status})`);
    }
    
    clearSelection();
    setRefreshError(null);
  } catch (err) {
    setRefreshError(err instanceof Error ? err.message : String(err));
  } finally {
    setRefreshing(false);
  }
}, [selectedIds, clearSelection]);

// Update the button onClick to use advanceSelected
<button
  className="advance-btn"
  onClick={advanceSelected}
  disabled={refreshing}
>
  Advance selected ({selectedIds.size})
</button>
```

**Step 4: Write tests for batch transitions**

Create `src/lib/transitions.test.ts` additions:

```typescript
describe('batch transitions', () => {
  it('allows batch advance from backlog to refinement', () => {
    expect(canBatchAdvance('backlog')).toBe(true);
    expect(getBatchAdvanceTarget('backlog')).toBe('refinement');
  });

  it('allows batch advance from refinement to backlog', () => {
    expect(canBatchAdvance('refinement')).toBe(true);
    expect(getBatchAdvanceTarget('refinement')).toBe('backlog');
  });

  it('rejects batch advance from other states', () => {
    expect(canBatchAdvance('developing')).toBe(false);
    expect(canBatchAdvance('pr')).toBe(false);
    expect(canBatchAdvance('rollout')).toBe(false);
    expect(canBatchAdvance('blocked')).toBe(false);
  });
});
```

**Step 5: Run tests**

```bash
npm test
```

Expected: All tests pass

**Step 6: Commit**

```bash
git add src/app/api/issues/batch-advance/route.ts src/lib/transitions.ts src/lib/transitions.test.ts src/app/\(board\)/page.tsx
git commit -m "feat: add batch advance API endpoint"
```

---

## Task 3: Add validate-then-implement gate

**Files:**
- Create: `src/lib/validate.ts`
- Modify: `src/lib/develop.ts`
- Create: `src/app/api/issues/[id]/validate/route.ts`

**Step 1: Create validation prompt builder**

Create `src/lib/validate.ts`:

```typescript
import { ENV } from './env';
import type { Issue } from './types';

export function buildValidatePrompt(issue: Issue): string {
  const repoPath = `${ENV.openWorkspaceRoot}/${issue.repo}`;
  
  const parts = [
    `You are validating a GitHub issue for readiness on a personal dev command board (DevHub).`,
    `Your job is to assess whether this issue is clear enough to be implemented.`,
    ``,
    `## Repository`,
    `Repository path: ${repoPath}`,
    `Owner: ${issue.owner}   Repo: ${issue.repo}   Issue #${issue.number}`,
    `Issue URL: ${issue.htmlUrl}`,
    ``,
    `## Issue`,
    `Title: ${issue.title}`,
    ``,
    `Body:`,
    issue.body?.trim() ? issue.body.trim() : '(no description)',
    ``,
    `## Validation Criteria`,
    `Assess the issue against these criteria:`,
    `1. **Clear scope**: Is the goal well-defined? Can you tell what needs to be done?`,
    `2. **Acceptance criteria**: Are there testable conditions for completion?`,
    `3. **Technical feasibility**: Is this achievable with the repo's existing stack?`,
    `4. **No major ambiguities**: Are there blocking questions that need answers?`,
    ``,
    `## Response Format`,
    `Respond with EXACTLY ONE of:`,
    `- "READY: <brief summary of what will be implemented>" if the issue is clear enough to proceed`,
    `- "NEEDS_WORK: <specific improvements needed>" if the issue needs refinement before implementation`,
    ``,
    `Be concise. Focus on whether a developer (human or AI) could start working on this immediately.`,
  ];

  return parts.join('\n');
}

export function parseValidationResult(text: string): { ready: boolean; summary: string } {
  const trimmed = text.trim();
  
  if (trimmed.startsWith('READY:')) {
    return { ready: true, summary: trimmed.slice(6).trim() };
  }
  
  if (trimmed.startsWith('NEEDS_WORK:')) {
    return { ready: false, summary: trimmed.slice(11).trim() };
  }
  
  // Fallback: check for keywords
  const lower = trimmed.toLowerCase();
  if (lower.includes('ready') && !lower.includes('needs work')) {
    return { ready: true, summary: trimmed };
  }
  
  return { ready: false, summary: trimmed };
}
```

**Step 2: Create validation API route**

Create `src/app/api/issues/[id]/validate/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getIssue, appendEvent, publishIssue, setIssueState } from '@/lib/store';
import { runDevelop, resolveModels, type OpencodeEvent } from '@/lib/opencode';
import { buildValidatePrompt, parseValidationResult } from '@/lib/validate';
import { UnauthorizedError, ForbiddenError, requireMember } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const issueId = Number(id);
  if (!Number.isInteger(issueId)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }

  let session;
  try {
    session = await requireMember(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: 'not a bumbleflies member' }, { status: 403 });
    return NextResponse.json({ error: 'github auth failed' }, { status: 401 });
  }

  const issue = getIssue(issueId);
  if (!issue) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // Only validate issues in backlog or refinement state
  if (issue.state !== 'backlog' && issue.state !== 'refinement') {
    return NextResponse.json(
      { error: `issue is '${issue.state}'; only backlog/refinement issues can be validated` },
      { status: 409 }
    );
  }

  const models = resolveModels();
  const prompt = buildValidatePrompt(issue);
  
  try {
    appendEvent(issue.id, 'validation', { status: 'started' });
    
    const onEvent = (event: OpencodeEvent) => {
      appendEvent(issue.id, 'validation-event', event);
    };
    
    const text = await runDevelop(prompt, onEvent, models);
    const result = parseValidationResult(text);
    
    appendEvent(issue.id, 'validation', { 
      status: 'completed', 
      ready: result.ready, 
      summary: result.summary 
    });
    
    return NextResponse.json({ 
      ok: true, 
      ready: result.ready, 
      summary: result.summary,
      text 
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    appendEvent(issue.id, 'validation', { status: 'error', error: reason });
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}
```

**Step 3: Add validation to the develop flow**

Modify `src/lib/develop.ts` to add validation gate:

```typescript
// Add new function for staged develop
export async function startStagedDevelop(
  issue: Issue,
  command: string,
  token: string,
  selectedModel?: OpencodeModel | null
): Promise<void> {
  // Phase 1: Validate
  const validating = setIssueState(issue.id, 'refinement');
  if (validating) publishIssue(validating);
  void mirrorLabels(issue, 'refinement', token);
  void mirrorComment(issue, 'DevHub validating this issue...', token);

  try {
    const models = resolveModels(selectedModel);
    const validatePrompt = buildValidatePrompt(issue);
    
    appendEvent(issue.id, 'validation', { status: 'started' });
    
    const onEvent = (event: OpencodeEvent) => {
      appendEvent(issue.id, 'validation-event', event);
    };
    
    const validateText = await runDevelop(validatePrompt, onEvent, models);
    const result = parseValidationResult(validateText);
    
    appendEvent(issue.id, 'validation', { 
      status: 'completed', 
      ready: result.ready, 
      summary: result.summary 
    });

    if (!result.ready) {
      // Validation failed - stay in refinement with feedback
      const blocked = setResult(issue.id, 'refinement', null, `Validation: ${result.summary}`);
      if (blocked) publishIssue(blocked);
      void mirrorLabels(issue, 'refinement', token);
      void mirrorComment(issue, `DevHub validation found issues:\n\n${result.summary}`, token);
      return;
    }

    // Validation passed - proceed to develop
    void mirrorComment(issue, `DevHub validation passed: ${result.summary}`, token);
    
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    appendEvent(issue.id, 'validation-error', { message: reason });
    const blocked = setResult(issue.id, 'blocked', null, `Validation failed: ${reason}`);
    if (blocked) publishIssue(blocked);
    void mirrorLabels(issue, 'blocked', token);
    void mirrorComment(issue, `DevHub validation failed: ${reason}`, token);
    return;
  }

  // Phase 2: Implement (reuse existing develop flow)
  await startDevelop(issue, command, token, selectedModel);
}
```

**Step 4: Update develop API to support staged mode**

Modify `src/app/api/issues/[id]/develop/route.ts`:

```typescript
// Add staged mode parameter
const body = (await req.json().catch(() => ({}))) as {
  command?: unknown;
  modelId?: unknown;
  providerID?: unknown;
  staged?: unknown;
};
const command = typeof body.command === 'string' ? body.command : '';
const modelId = typeof body.modelId === 'string' && body.modelId ? body.modelId : null;
const providerID = typeof body.providerID === 'string' && body.providerID ? body.providerID : null;
const selectedModel: OpencodeModel | null = modelId ? { id: modelId, providerID: providerID ?? 'opencode' } : null;
const staged = body.staged === true;

// Fire-and-forget: the route returns immediately; progress streams via SSE.
if (staged) {
  void startStagedDevelop(issue, command, session.token, selectedModel);
} else {
  void startDevelop(issue, command, session.token, selectedModel);
}
```

**Step 5: Add "Validate & Develop" button to UI**

Update the Card component in `src/app/(board)/page.tsx`:

```typescript
// Add staged develop function
const stagedDevelop = useCallback(async () => {
  setBusy(true);
  try {
    const body: { command: string; modelId?: string; providerID?: string; staged?: boolean } = { 
      command,
      staged: true 
    };
    if (selected) {
      body.modelId = selected.id;
      body.providerID = selected.providerID;
    }
    await fetch(`/api/issues/${issue.id}/develop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setOpen(false);
  } finally {
    setBusy(false);
  }
}, [issue.id, command, selected]);

// Update the develop button section
<div className="card-actions">
  {(issue.state === 'backlog' || issue.state === 'refinement' || issue.state === 'blocked') && (
    <>
      <button className="develop-btn" onClick={openModal}>
        Develop this
      </button>
      <button className="validate-btn" onClick={() => {
        setCommand('');
        openModal();
        // Auto-select staged mode
      }}>
        Validate & Develop
      </button>
    </>
  )}
</div>
```

**Step 6: Add validation status display**

Update the Card component to show validation results:

```typescript
// Add validation result display
{issue.state === 'refinement' && issue.resultText && (
  <div className="validation-result">
    <strong>Validation:</strong> {issue.resultText}
  </div>
)}
```

**Step 7: Write tests for validation**

Create `src/lib/validate.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { buildValidatePrompt, parseValidationResult } from './validate.js';

describe('validate', () => {
  it('builds validation prompt with issue details', () => {
    const issue = {
      id: 1,
      githubIssueId: 123,
      owner: 'test',
      repo: 'repo',
      number: 1,
      title: 'Test Issue',
      body: 'Test body',
      htmlUrl: 'https://github.com/test/repo/issues/1',
      state: 'backlog' as const,
      sessionId: null,
      resultPrUrl: null,
      resultText: null,
      linkedPrUrl: null,
      releaseTag: null,
      releasedAt: null,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    };
    
    const prompt = buildValidatePrompt(issue);
    expect(prompt).toContain('Test Issue');
    expect(prompt).toContain('Test body');
    expect(prompt).toContain('test/repo');
  });

  it('parses READY response', () => {
    const result = parseValidationResult('READY: Clear scope and acceptance criteria');
    expect(result.ready).toBe(true);
    expect(result.summary).toBe('Clear scope and acceptance criteria');
  });

  it('parses NEEDS_WORK response', () => {
    const result = parseValidationResult('NEEDS_WORK: Missing acceptance criteria');
    expect(result.ready).toBe(false);
    expect(result.summary).toBe('Missing acceptance criteria');
  });

  it('handles ambiguous responses', () => {
    const result = parseValidationResult('The issue looks good overall');
    expect(result.ready).toBe(false); // Conservative default
  });
});
```

**Step 8: Run tests**

```bash
npm test
```

Expected: All tests pass

**Step 9: Commit**

```bash
git add src/lib/validate.ts src/lib/validate.test.ts src/lib/develop.ts src/app/api/issues/\[id\]/develop/route.ts src/app/\(board\)/page.tsx
git commit -m "feat: add validate-then-implement gate"
```

---

## Task 4: Add batch validate & develop functionality

**Files:**
- Modify: `src/app/api/issues/batch-advance/route.ts`
- Modify: `src/app/(board)/page.tsx`

**Step 1: Extend batch advance to support validation**

Update `src/app/api/issues/batch-advance/route.ts`:

```typescript
// Add validation mode
const body = (await req.json().catch(() => ({}))) as { 
  issueIds?: unknown;
  mode?: unknown;
};
const issueIds = Array.isArray(body.issueIds) ? body.issueIds.filter((id): id is number => typeof id === 'number') : [];
const mode = body.mode === 'validate' ? 'validate' : 'advance';

// In the loop, add validation handling
if (mode === 'validate' && issue.state === 'backlog') {
  // Start validation flow
  const validating = setIssueState(issue.id, 'refinement');
  if (validating) {
    publishIssue(validating);
    void setIssueStateLabels(issue.owner, issue.repo, issue.number, 'refinement', session.token).catch(() => {});
    
    // Start async validation (fire-and-forget)
    void startValidation(issue, session.token);
    
    results.push({ id: issueId, success: true, mode: 'validating' });
  } else {
    results.push({ id: issueId, success: false, error: 'failed to start validation' });
  }
  continue;
}
```

**Step 2: Add batch validation function**

Create or extend `src/lib/validate.ts`:

```typescript
export async function startValidation(issue: Issue, token: string): Promise<void> {
  try {
    const models = resolveModels();
    const prompt = buildValidatePrompt(issue);
    
    appendEvent(issue.id, 'validation', { status: 'started' });
    
    const onEvent = (event: OpencodeEvent) => {
      appendEvent(issue.id, 'validation-event', event);
    };
    
    const text = await runDevelop(prompt, onEvent, models);
    const result = parseValidationResult(text);
    
    appendEvent(issue.id, 'validation', { 
      status: 'completed', 
      ready: result.ready, 
      summary: result.summary 
    });

    if (result.ready) {
      // Auto-advance to develop
      const updated = setIssueState(issue.id, 'backlog');
      if (updated) publishIssue(updated);
    } else {
      // Stay in refinement with feedback
      const updated = setResult(issue.id, 'refinement', null, result.summary);
      if (updated) publishIssue(updated);
    }
    
    void mirrorComment(issue, `DevHub validation: ${result.ready ? 'READY' : 'NEEDS_WORK'}\n${result.summary}`, token);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    appendEvent(issue.id, 'validation-error', { message: reason });
    void mirrorComment(issue, `DevHub validation failed: ${reason}`, token);
  }
}
```

**Step 3: Update UI for batch validation**

Add a "Validate selected" button to the board:

```typescript
// Add validate button in header
{selectedIds.size > 0 && (
  <>
    <button
      className="validate-btn"
      onClick={validateSelected}
      disabled={refreshing}
    >
      Validate selected ({selectedIds.size})
    </button>
    <button
      className="advance-btn"
      onClick={advanceSelected}
      disabled={refreshing}
    >
      Advance selected ({selectedIds.size})
    </button>
  </>
)}

// Add validateSelected function
const validateSelected = useCallback(async () => {
  if (selectedIds.size === 0) return;
  
  setRefreshing(true);
  try {
    const res = await fetch('/api/issues/batch-advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        issueIds: Array.from(selectedIds),
        mode: 'validate'
      }),
    });
    
    if (!res.ok) {
      const data = await res.json() as { error?: string };
      throw new Error(data.error || `batch validation failed (HTTP ${res.status})`);
    }
    
    clearSelection();
    setRefreshError(null);
  } catch (err) {
    setRefreshError(err instanceof Error ? err.message : String(err));
  } finally {
    setRefreshing(false);
  }
}, [selectedIds, clearSelection]);
```

**Step 4: Add CSS for validation button**

```css
.validate-btn {
  background: var(--warning, #d29922);
  color: white;
  border: none;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 13px;
  cursor: pointer;
}

.validate-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

**Step 5: Run tests**

```bash
npm test
```

Expected: All tests pass

**Step 6: Commit**

```bash
git add src/app/api/issues/batch-advance/route.ts src/lib/validate.ts src/app/\(board\)/page.tsx
git commit -m "feat: add batch validate functionality"
```

---

## Task 5: Add batch develop functionality

**Files:**
- Modify: `src/app/api/issues/batch-advance/route.ts`
- Modify: `src/app/(board)/page.tsx`

**Step 1: Extend batch advance to support develop mode**

Update `src/app/api/issues/batch-advance/route.ts`:

```typescript
// Add develop mode
const body = (await req.json().catch(() => ({}))) as { 
  issueIds?: unknown;
  mode?: unknown;
  command?: unknown;
};
const issueIds = Array.isArray(body.issueIds) ? body.issueIds.filter((id): id is number => typeof id === 'number') : [];
const mode = body.mode === 'develop' ? 'develop' : body.mode === 'validate' ? 'validate' : 'advance';
const command = typeof body.command === 'string' ? body.command : '';

// In the loop, add develop handling
if (mode === 'develop' && (issue.state === 'backlog' || issue.state === 'refinement')) {
  // Start develop flow
  const developing = setIssueState(issue.id, 'developing');
  if (developing) {
    publishIssue(developing);
    void setIssueStateLabels(issue.owner, issue.repo, issue.number, 'developing', session.token).catch(() => {});
    
    // Start async development (fire-and-forget)
    void startDevelop(issue, command, session.token);
    
    results.push({ id: issueId, success: true, mode: 'developing' });
  } else {
    results.push({ id: issueId, success: false, error: 'failed to start development' });
  }
  continue;
}
```

**Step 2: Update UI for batch develop**

Add a "Develop selected" button to the board:

```typescript
// Add develop button in header
{selectedIds.size > 0 && (
  <>
    <button
      className="develop-batch-btn"
      onClick={developSelected}
      disabled={refreshing}
    >
      Develop selected ({selectedIds.size})
    </button>
    <button
      className="validate-btn"
      onClick={validateSelected}
      disabled={refreshing}
    >
      Validate selected ({selectedIds.size})
    </button>
    <button
      className="advance-btn"
      onClick={advanceSelected}
      disabled={refreshing}
    >
      Advance selected ({selectedIds.size})
    </button>
  </>
)}

// Add developSelected function
const developSelected = useCallback(async () => {
  if (selectedIds.size === 0) return;
  
  setRefreshing(true);
  try {
    const res = await fetch('/api/issues/batch-advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        issueIds: Array.from(selectedIds),
        mode: 'develop'
      }),
    });
    
    if (!res.ok) {
      const data = await res.json() as { error?: string };
      throw new Error(data.error || `batch develop failed (HTTP ${res.status})`);
    }
    
    clearSelection();
    setRefreshError(null);
  } catch (err) {
    setRefreshError(err instanceof Error ? err.message : String(err));
  } finally {
    setRefreshing(false);
  }
}, [selectedIds, clearSelection]);
```

**Step 3: Add CSS for develop button**

```css
.develop-batch-btn {
  background: var(--accent, #58a6ff);
  color: white;
  border: none;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 13px;
  cursor: pointer;
}

.develop-batch-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

**Step 4: Run tests**

```bash
npm test
```

Expected: All tests pass

**Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: No type errors

**Step 6: Run lint**

```bash
npm run lint
```

Expected: No lint errors

**Step 7: Run build**

```bash
npm run build
```

Expected: Build succeeds

**Step 8: Commit**

```bash
git add src/app/api/issues/batch-advance/route.ts src/app/\(board\)/page.tsx
git commit -m "feat: add batch develop functionality"
```

---

## Task 6: Add batch operation feedback and error handling

**Files:**
- Modify: `src/app/(board)/page.tsx`
- Modify: `src/app/api/issues/batch-advance/route.ts`

**Step 1: Add batch operation status tracking**

Update the board to show batch operation progress:

```typescript
// Add state for batch operation status
const [batchStatus, setBatchStatus] = useState<{
  operation: string;
  total: number;
  completed: number;
  errors: number;
} | null>(null);

// Update batch operation functions to track progress
const advanceSelected = useCallback(async () => {
  if (selectedIds.size === 0) return;
  
  const total = selectedIds.size;
  setBatchStatus({ operation: 'advancing', total, completed: 0, errors: 0 });
  setRefreshing(true);
  
  try {
    const res = await fetch('/api/issues/batch-advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueIds: Array.from(selectedIds) }),
    });
    
    if (!res.ok) {
      const data = await res.json() as { error?: string };
      throw new Error(data.error || `batch advance failed (HTTP ${res.status})`);
    }
    
    const result = await res.json() as { results: Array<{ id: number; success: boolean; error?: string }> };
    const completed = result.results.filter((r) => r.success).length;
    const errors = result.results.filter((r) => !r.success).length;
    
    setBatchStatus({ operation: 'advancing', total, completed, errors });
    clearSelection();
    setRefreshError(null);
  } catch (err) {
    setRefreshError(err instanceof Error ? err.message : String(err));
  } finally {
    setRefreshing(false);
    // Clear status after a delay
    setTimeout(() => setBatchStatus(null), 3000);
  }
}, [selectedIds, clearSelection]);
```

**Step 2: Add batch status display**

Add a status bar to show batch operation progress:

```typescript
// Add batch status display
{batchStatus && (
  <div className="batch-status">
    <span>{batchStatus.operation}: {batchStatus.completed}/{batchStatus.total}</span>
    {batchStatus.errors > 0 && (
      <span className="batch-errors">({batchStatus.errors} errors)</span>
    )}
  </div>
)}
```

**Step 3: Add CSS for batch status**

```css
.batch-status {
  position: fixed;
  bottom: 60px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 16px;
  font-size: 13px;
  z-index: 100;
}

.batch-errors {
  color: var(--danger, #f85149);
  margin-left: 8px;
}
```

**Step 4: Add detailed error reporting**

Update the batch advance API to return more detailed errors:

```typescript
// Update the results array to include more details
results.push({ 
  id: issueId, 
  success: false, 
  error: `cannot advance from '${issue.state}'`,
  currentState: issue.state,
  attemptedTarget: target
});
```

**Step 5: Run tests**

```bash
npm test
```

Expected: All tests pass

**Step 6: Run typecheck**

```bash
npm run typecheck
```

Expected: No type errors

**Step 7: Run lint**

```bash
npm run lint
```

Expected: No lint errors

**Step 8: Run build**

```bash
npm run build
```

Expected: Build succeeds

**Step 9: Commit**

```bash
git add src/app/\(board\)/page.tsx src/app/api/issues/batch-advance/route.ts
git commit -m "feat: add batch operation feedback and error handling"
```

---

## Task 7: Add batch operation keyboard shortcuts

**Files:**
- Modify: `src/app/(board)/page.tsx`

**Step 1: Add keyboard event handlers**

Add keyboard shortcuts for batch operations:

```typescript
// Add keyboard event handler
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    // Ctrl/Cmd + A to select all visible issues
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault();
      const visibleIssues = issues.filter((i) => matchesIssue(i, query));
      setSelectedIds(new Set(visibleIssues.map((i) => i.id)));
    }
    
    // Escape to clear selection
    if (e.key === 'Escape') {
      clearSelection();
    }
    
    // Ctrl/Cmd + Enter to advance selected
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && selectedIds.size > 0) {
      e.preventDefault();
      advanceSelected();
    }
  };
  
  document.addEventListener('keydown', handleKeyDown);
  return () => document.removeEventListener('keydown', handleKeyDown);
}, [issues, query, selectedIds, clearSelection, advanceSelected]);
```

**Step 2: Add keyboard shortcut hints**

Add hints to the UI for keyboard shortcuts:

```typescript
// Add keyboard hints near the batch buttons
{selectedIds.size > 0 && (
  <div className="keyboard-hints">
    <span>Ctrl+Enter to advance</span>
    <span>Esc to clear</span>
  </div>
)}
```

**Step 3: Add CSS for keyboard hints**

```css
.keyboard-hints {
  font-size: 11px;
  color: var(--muted);
  margin-top: 4px;
}

.keyboard-hints span {
  margin-right: 12px;
}
```

**Step 4: Run tests**

```bash
npm test
```

Expected: All tests pass

**Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: No type errors

**Step 6: Run lint**

```bash
npm run lint
```

Expected: No lint errors

**Step 7: Run build**

```bash
npm run build
```

Expected: Build succeeds

**Step 8: Commit**

```bash
git add src/app/\(board\)/page.tsx
git commit -m "feat: add batch operation keyboard shortcuts"
```

---

## Task 8: Final verification and cleanup

**Step 1: Run full test suite**

```bash
npm test
```

Expected: All tests pass

**Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: No type errors

**Step 3: Run lint**

```bash
npm run lint
```

Expected: No lint errors

**Step 4: Run build**

```bash
npm run build
```

Expected: Build succeeds

**Step 5: Manual testing checklist**

Verify the following manually:
- [ ] Can select multiple issues with checkboxes
- [ ] "Advance selected" button appears when issues are selected
- [ ] Batch advance moves backlog issues to refinement
- [ ] Batch advance moves refinement issues back to backlog
- [ ] "Validate selected" button triggers validation flow
- [ ] "Develop selected" button starts development for selected issues
- [ ] Keyboard shortcuts work (Ctrl+A, Escape, Ctrl+Enter)
- [ ] Batch status shows progress and errors
- [ ] Error messages are clear and actionable
- [ ] Selection clears after successful batch operation

**Step 6: Documentation update**

Update `AGENTS.md` to document the new batch operations:

```markdown
## Batch Operations

The board supports batch operations for advancing multiple issues through the pipeline:

### Batch Selection
- Click checkboxes on cards to select issues
- Use `Ctrl+A` to select all visible issues
- Use `Escape` to clear selection

### Batch Actions
- **Advance selected**: Move selected issues to the next stage (backlog → refinement, refinement → backlog)
- **Validate selected**: Start validation flow for selected issues (assesses readiness)
- **Develop selected**: Start development for selected issues (backlog/refinement → developing)

### Keyboard Shortcuts
- `Ctrl+A`: Select all visible issues
- `Escape`: Clear selection
- `Ctrl+Enter`: Advance selected issues

### Validation Gate
The validate-then-implement flow provides a two-step process:
1. **Validate**: An opencode session assesses if the issue is clear enough to implement
2. **Implement**: If validation passes, a full develop session implements the issue

This helps reduce blocked runs caused by underspecified issues.
```

**Step 7: Final commit**

```bash
git add AGENTS.md
git commit -m "docs: add batch operations documentation"
```

---

## Summary

This implementation plan adds:

1. **Batch selection UI** with checkboxes and "Advance selected" button
2. **Batch advance API** that moves issues between backlog and refinement
3. **Validate-then-implement gate** with a two-step flow
4. **Batch validation** for multiple issues at once
5. **Batch development** for multiple issues at once
6. **Progress feedback** and error handling for batch operations
7. **Keyboard shortcuts** for efficient batch operations

The implementation follows the existing patterns in the codebase and maintains backward compatibility with the current single-issue develop flow.
