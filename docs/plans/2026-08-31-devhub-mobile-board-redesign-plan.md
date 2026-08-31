# DevHub Mobile Board Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mobile board's bottom-nav + left-border cards + search
popover with the Claude-Design-approved "2b" mobile UI: a sticky top status
strip, tinted-header-strip cards with a split footer + overflow sheet, and a
full-screen search sheet — without touching desktop layout or any
server-side behavior.

**Architecture:** Extract the pure, framework-free decision logic (which
sheet actions apply to a state, the primary footer action, search matching,
repo coloring/counting) into `src/lib/board-ui.ts`, unit-tested the same way
every other `src/lib/*.ts` module is. Extract the develop/transition
fetch-and-state logic already living inside desktop `Card` into a
`useCardActions` hook so the new mobile components can trigger the same
`/api/issues/[id]/develop` and `/api/issues/[id]/transition` calls without
duplicating them. Add four new presentational components under
`src/components/board/` (mobile card, actions sheet, status strip, search
sheet) and gate them behind a `useMediaQuery('(max-width: 768px)')` check in
`src/app/(board)/page.tsx`, mirroring the existing CSS breakpoint exactly.

**Tech Stack:** Next.js 15 App Router (client component), TypeScript,
vitest (`environment: 'node'`, no new dependencies).

**Spec:** `docs/plans/2026-08-31-devhub-mobile-board-redesign-design.md`

## Global Constraints

- Breakpoint is `768px` everywhere (CSS `@media (max-width: 768px)` and the
  JS `MOBILE_QUERY` constant below) — this repo has exactly one mobile
  breakpoint; do not invent a second one.
- Reuse the existing CSS custom properties from `globals.css`'s `:root`
  (`--bg`, `--panel`, `--panel-2`, `--border`, `--text`, `--muted`,
  `--accent`, and the per-state colors) — never a hardcoded hex from the
  canvas mockup.
- Relative imports in real source files are **extensionless**
  (`from './board-ui'`), per `AGENTS.md`. Relative imports in `*.test.ts`
  files use an explicit `.js` extension, matching every existing test file
  (e.g. `src/lib/transitions.test.ts` imports `from './transitions.js'`) —
  this is an established (if inconsistent-looking) repo convention, keep it.
- **No new dependencies, no React-component-render tests.** This codebase
  has zero `@testing-library/*`/jsdom/happy-dom setup; `vitest.config.ts`
  runs `environment: 'node'`. Decided with the user: keep it that way. Every
  task below either (a) is pure logic with real vitest unit tests, or (b) is
  UI wiring verified by running `npm run dev` and checking the browser at a
  <768px viewport — never invent a rendering-test step for (b).
  Safe-change order stays `typecheck` → `lint` → `test` → `build`, run at
  the end of every task.
- Every new component file starts with `'use client';` (this whole board is
  already a client component tree — `page.tsx` line 1).
- Desktop behavior (viewport ≥768px) must be pixel-for-pixel unchanged
  after every task. Task 1 and Task 2 are refactors; if a manual desktop
  smoke-check ever looks different, stop and fix it before moving on.

---

### Task 1: Extract pure board logic into `src/lib/board-ui.ts`

**Files:**
- Create: `src/lib/board-ui.ts`
- Create: `src/lib/board-ui.test.ts`
- Modify: `src/lib/types.ts` (add `ModelOption`)
- Modify: `src/app/(board)/page.tsx` (delete the now-duplicated local
  definitions of `REPO_COLORS`, `repoColor`, `FIELD_FILTERS`, `matchesIssue`,
  `relTime`, `excerpt`, and the inline `ModelOption` interface; import them
  from `@/lib/board-ui` / `@/lib/types` instead)

**Interfaces:**
- Produces: `repoColor(key: string): string`, `matchesIssue(issue: Issue,
  query: string): boolean`, `relTime(iso: string): string`,
  `excerpt(body: string): string`, `countRepos(issues: Pick<Issue, 'owner' |
  'repo'>[]): number`, `cardActions(issue: Pick<Issue, 'state'>):
  CardAction[]`, `primaryCardAction(issue: Pick<Issue, 'state'>):
  PrimaryCardAction`, types `CardActionId`, `CardAction`, `PrimaryCardAction`.
  `ModelOption` moves to `src/lib/types.ts` and is re-exported from there
  (not from `board-ui.ts`).

- [ ] **Step 1: Add `ModelOption` to `src/lib/types.ts`**

Add near the top of `src/lib/types.ts` (after the existing imports/exports,
before `export interface IssueRow`):

```typescript
export interface ModelOption {
  id: string;
  providerID: string;
}
```

- [ ] **Step 2: Write the failing tests**

Create `src/lib/board-ui.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  cardActions,
  countRepos,
  excerpt,
  matchesIssue,
  primaryCardAction,
  relTime,
  repoColor,
} from './board-ui.js';
import type { Issue } from './types.js';

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 1,
    githubIssueId: 1,
    owner: 'dachrisch',
    repo: 'devhub',
    number: 1,
    title: 'Test issue',
    body: null,
    htmlUrl: 'https://github.com/dachrisch/devhub/issues/1',
    state: 'backlog',
    sessionId: null,
    resultPrUrl: null,
    resultText: null,
    linkedPrUrl: null,
    releaseTag: null,
    releasedAt: null,
    createdAt: '2026-01-01 00:00:00',
    updatedAt: '2026-01-01 00:00:00',
    ...overrides,
  };
}

describe('cardActions', () => {
  it('offers develop + move-to-refinement for a backlog issue', () => {
    expect(cardActions(issue({ state: 'backlog' })).map((a) => a.id)).toEqual([
      'develop-validated',
      'to-refinement',
      'recap',
      'select-batch',
      'open-github',
    ]);
  });

  it('offers develop + move-to-backlog for a refinement issue', () => {
    expect(cardActions(issue({ state: 'refinement' })).map((a) => a.id)).toEqual([
      'develop-validated',
      'to-backlog',
      'recap',
      'select-batch',
      'open-github',
    ]);
  });

  it('offers develop but no transition for a blocked issue', () => {
    expect(cardActions(issue({ state: 'blocked' })).map((a) => a.id)).toEqual([
      'develop-validated',
      'recap',
      'select-batch',
      'open-github',
    ]);
  });

  it('drops develop for a developing issue and labels recap as live', () => {
    const actions = cardActions(issue({ state: 'developing' }));
    expect(actions.map((a) => a.id)).toEqual(['recap', 'select-batch', 'open-github']);
    expect(actions.find((a) => a.id === 'recap')?.label).toBe('Recap (live)');
  });

  it('drops develop for pr and rollout issues', () => {
    expect(cardActions(issue({ state: 'pr' })).map((a) => a.id)).toEqual([
      'recap',
      'select-batch',
      'open-github',
    ]);
    expect(cardActions(issue({ state: 'rollout' })).map((a) => a.id)).toEqual([
      'recap',
      'select-batch',
      'open-github',
    ]);
  });
});

describe('primaryCardAction', () => {
  it('is Develop for backlog, refinement and blocked', () => {
    for (const state of ['backlog', 'refinement', 'blocked'] as const) {
      expect(primaryCardAction(issue({ state }))).toEqual({ label: 'Develop', kind: 'develop' });
    }
  });

  it('is Recap (live) while developing', () => {
    expect(primaryCardAction(issue({ state: 'developing' }))).toEqual({
      label: 'Recap (live)',
      kind: 'recap',
    });
  });

  it('is plain Recap for pr and rollout', () => {
    expect(primaryCardAction(issue({ state: 'pr' }))).toEqual({ label: 'Recap', kind: 'recap' });
    expect(primaryCardAction(issue({ state: 'rollout' }))).toEqual({ label: 'Recap', kind: 'recap' });
  });
});

describe('countRepos', () => {
  it('counts distinct owner/repo pairs', () => {
    expect(
      countRepos([
        { owner: 'a', repo: 'x' },
        { owner: 'a', repo: 'x' },
        { owner: 'a', repo: 'y' },
        { owner: 'b', repo: 'x' },
      ])
    ).toBe(3);
  });

  it('is zero for an empty list', () => {
    expect(countRepos([])).toBe(0);
  });
});

describe('repoColor', () => {
  it('is deterministic for the same key', () => {
    expect(repoColor('dachrisch/devhub')).toBe(repoColor('dachrisch/devhub'));
  });
});

describe('matchesIssue', () => {
  it('matches free text against title', () => {
    expect(matchesIssue(issue({ title: 'Fix the auth flow' }), 'auth')).toBe(true);
    expect(matchesIssue(issue({ title: 'Fix the auth flow' }), 'billing')).toBe(false);
  });

  it('matches field filters', () => {
    expect(matchesIssue(issue({ repo: 'web' }), 'repo:web')).toBe(true);
    expect(matchesIssue(issue({ repo: 'web' }), 'repo:api')).toBe(false);
  });
});

describe('relTime', () => {
  it('renders seconds for very recent timestamps', () => {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    expect(relTime(now)).toMatch(/^\d+s ago$/);
  });
});

describe('excerpt', () => {
  it('strips markdown and collapses whitespace', () => {
    expect(excerpt('# Title\n\nSome *body* text with `code`.')).toBe(
      'Title Some body text with code .'
    );
  });

  it('truncates long bodies to 180 chars with an ellipsis', () => {
    const long = 'a'.repeat(200);
    const result = excerpt(long);
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBe(181);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd devhub && npm test -- board-ui`
Expected: FAIL — `Cannot find module './board-ui.js'` (file doesn't exist yet)

- [ ] **Step 3: Write `src/lib/board-ui.ts`**

```typescript
import type { Issue, IssueState } from './types';

export const REPO_COLORS = [
  '#58a6ff',
  '#3fb950',
  '#d29922',
  '#f85149',
  '#bc8cff',
  '#39c5cf',
  '#ff7b72',
  '#a5d6ff',
  '#7ee787',
  '#ffa657',
];

export function repoColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return REPO_COLORS[h % REPO_COLORS.length];
}

const FIELD_FILTERS: Record<string, (i: Issue, v: string) => boolean> = {
  title: (i, v) => i.title.toLowerCase().includes(v),
  repo: (i, v) => i.repo.toLowerCase().includes(v),
  owner: (i, v) => i.owner.toLowerCase().includes(v),
  state: (i, v) => i.state.toLowerCase().includes(v),
  body: (i, v) => (i.body ?? '').toLowerCase().includes(v),
  number: (i, v) => String(i.number).includes(v),
};

export function matchesIssue(issue: Issue, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const global: string[] = [];
  for (const token of tokens) {
    const m = token.match(/^([a-z]+):(.*)$/);
    if (m && FIELD_FILTERS[m[1]]) {
      if (!FIELD_FILTERS[m[1]](issue, m[2])) return false;
    } else {
      global.push(token);
    }
  }
  if (global.length === 0) return true;
  const haystack = [issue.owner, issue.repo, `#${issue.number}`, issue.title, issue.body ?? '']
    .join(' ')
    .toLowerCase();
  return global.every((term) => haystack.includes(term));
}

export function relTime(iso: string): string {
  const then = new Date(iso.replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  const units: [number, string][] = [
    [31536000, 'y'],
    [2592000, 'mo'],
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm'],
  ];
  for (const [secsInUnit, label] of units) {
    if (secs >= secsInUnit) return `${Math.floor(secs / secsInUnit)}${label} ago`;
  }
  return `${secs}s ago`;
}

export function excerpt(body: string): string {
  const flat = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`_\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > 180 ? `${flat.slice(0, 180)}…` : flat;
}

export function countRepos(issues: Pick<Issue, 'owner' | 'repo'>[]): number {
  return new Set(issues.map((i) => `${i.owner}/${i.repo}`)).size;
}

export type CardActionId =
  | 'develop-validated'
  | 'to-refinement'
  | 'to-backlog'
  | 'recap'
  | 'select-batch'
  | 'open-github';

export interface CardAction {
  id: CardActionId;
  label: string;
}

const DEVELOPABLE: ReadonlySet<IssueState> = new Set(['backlog', 'refinement', 'blocked']);

// Drives the mobile card-actions sheet. Mirrors the conditionals already on
// desktop's Card component (Refine/Back-to-backlog, Develop this/Develop
// with validation, always-present Recap) — see CardActionsSheet.
export function cardActions(issue: Pick<Issue, 'state'>): CardAction[] {
  const actions: CardAction[] = [];
  if (DEVELOPABLE.has(issue.state)) {
    actions.push({ id: 'develop-validated', label: 'Develop (with validation)' });
  }
  if (issue.state === 'backlog') {
    actions.push({ id: 'to-refinement', label: 'Move to refinement' });
  }
  if (issue.state === 'refinement') {
    actions.push({ id: 'to-backlog', label: 'Move to backlog' });
  }
  actions.push({ id: 'recap', label: issue.state === 'developing' ? 'Recap (live)' : 'Recap' });
  actions.push({ id: 'select-batch', label: 'Select for batch' });
  actions.push({ id: 'open-github', label: 'Open on GitHub' });
  return actions;
}

export interface PrimaryCardAction {
  label: string;
  kind: 'develop' | 'recap';
}

export function primaryCardAction(issue: Pick<Issue, 'state'>): PrimaryCardAction {
  if (issue.state === 'developing') return { label: 'Recap (live)', kind: 'recap' };
  if (DEVELOPABLE.has(issue.state)) return { label: 'Develop', kind: 'develop' };
  return { label: 'Recap', kind: 'recap' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd devhub && npm test -- board-ui`
Expected: PASS (24 assertions across 8 describe blocks)

- [ ] **Step 5: Delete the now-duplicated definitions from `page.tsx` and import from `board-ui`/`types`**

In `src/app/(board)/page.tsx`:
- Delete the local `REPO_COLORS` array, `repoColor()`, `FIELD_FILTERS`,
  `matchesIssue()`, `relTime()`, `excerpt()` functions, and the local
  `interface ModelOption { id: string; providerID: string; }`.
- Add to the top-of-file imports:

```typescript
import type { Issue, IssueState, ModelOption } from '@/lib/types';
import { cardActions, countRepos, excerpt, matchesIssue, primaryCardAction, relTime, repoColor } from '@/lib/board-ui';
```

(`cardActions`, `countRepos`, `primaryCardAction` aren't used by `page.tsx`
yet — they're consumed starting Task 4/5. Importing them now is fine; ESLint
would flag an unused import, so only add the ones `page.tsx` actually calls
today: `repoColor`, `matchesIssue`, `relTime`, `excerpt`. Add `cardActions`,
`countRepos`, `primaryCardAction` to this import line in the tasks that
first use them instead.)

- [ ] **Step 6: Run the safe-change sequence**

Run: `cd devhub && npm run typecheck && npm run lint && npm test && npm run build`
Expected: all four PASS

- [ ] **Step 7: Manual desktop smoke check**

Run: `cd devhub && npm run dev`, open the board at a desktop width (≥768px).
Confirm repo pill colors, card ages, excerpts and search filtering all look
exactly as before (this step only moved code, it must not change output).

- [ ] **Step 8: Commit**

```bash
cd devhub && git add src/lib/board-ui.ts src/lib/board-ui.test.ts src/lib/types.ts src/app/\(board\)/page.tsx
git commit -m "refactor: extract board display logic into src/lib/board-ui.ts"
```

---

### Task 2: Extract `useCardActions` hook + shared `DevelopModal`

**Files:**
- Create: `src/components/board/use-card-actions.ts`
- Create: `src/components/board/develop-modal.tsx`
- Modify: `src/app/(board)/page.tsx` (`Card` uses the new hook + component
  instead of its own inline `develop`/`stagedDevelop`/`transition`/
  `loadModels`/modal state and inline `ModelPicker`)

**Interfaces:**
- Produces: `useCardActions(issueId: number): UseCardActionsResult` (see
  shape below), `<DevelopModal>` component.
- Consumes: `ModelOption` from `@/lib/types` (Task 1).

- [ ] **Step 1: Write `src/components/board/use-card-actions.ts`**

This is a direct extraction of `Card`'s existing `command`/`busy`/`open`/
`models`/`selectedModel` state and its `loadModels`/`openModal`/`develop`/
`stagedDevelop`/`transition` callbacks (currently inline in the `Card`
function in `page.tsx`) — same fetch calls, same request bodies, nothing
behavioral changes.

```typescript
'use client';

import { useCallback, useState } from 'react';
import type { IssueState, ModelOption } from '@/lib/types';

export interface UseCardActionsResult {
  busy: boolean;
  modalOpen: boolean;
  openModal: () => void;
  closeModal: () => void;
  command: string;
  setCommand: (value: string) => void;
  models: ModelOption[];
  selectedModel: ModelOption | null;
  setSelectedModel: (model: ModelOption | null) => void;
  develop: () => Promise<void>;
  stagedDevelop: () => Promise<void>;
  transition: (target: IssueState) => Promise<void>;
}

export function useCardActions(issueId: number): UseCardActionsResult {
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<ModelOption | null>(null);

  const loadModels = useCallback(async () => {
    try {
      const res = await fetch('/api/models');
      if (!res.ok) return;
      const data = (await res.json()) as { models: ModelOption[]; default: ModelOption | null };
      setModels(data.models ?? []);
      setSelectedModel(data.default ?? null);
    } catch {
      /* non-fatal: fall back to no override */
    }
  }, []);

  const openModal = useCallback(() => {
    setModalOpen(true);
    void loadModels();
  }, [loadModels]);

  const closeModal = useCallback(() => setModalOpen(false), []);

  const postDevelop = useCallback(
    async (staged: boolean) => {
      setBusy(true);
      try {
        const body: { command: string; modelId?: string; providerID?: string; staged?: boolean } = {
          command,
        };
        if (staged) body.staged = true;
        if (selectedModel) {
          body.modelId = selectedModel.id;
          body.providerID = selectedModel.providerID;
        }
        await fetch(`/api/issues/${issueId}/develop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        setModalOpen(false);
      } finally {
        setBusy(false);
      }
    },
    [issueId, command, selectedModel]
  );

  const develop = useCallback(() => postDevelop(false), [postDevelop]);
  const stagedDevelop = useCallback(() => postDevelop(true), [postDevelop]);

  const transition = useCallback(
    async (target: IssueState) => {
      setBusy(true);
      try {
        await fetch(`/api/issues/${issueId}/transition`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: target }),
        });
      } finally {
        setBusy(false);
      }
    },
    [issueId]
  );

  return {
    busy,
    modalOpen,
    openModal,
    closeModal,
    command,
    setCommand,
    models,
    selectedModel,
    setSelectedModel,
    develop,
    stagedDevelop,
    transition,
  };
}
```

- [ ] **Step 2: Write `src/components/board/develop-modal.tsx`**

Direct extraction of `Card`'s inline modal JSX and its private `ModelPicker`
(currently the last ~150 lines of `page.tsx`), unchanged markup/behavior,
now driven by props instead of closed-over `Card` state.

```tsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Issue, ModelOption } from '@/lib/types';

interface DevelopModalProps {
  issue: Issue;
  command: string;
  onCommandChange: (value: string) => void;
  models: ModelOption[];
  selectedModel: ModelOption | null;
  onSelectedModelChange: (model: ModelOption | null) => void;
  busy: boolean;
  onCancel: () => void;
  onDevelop: () => void;
  onStagedDevelop: () => void;
}

export function DevelopModal({
  issue,
  command,
  onCommandChange,
  models,
  selectedModel,
  onSelectedModelChange,
  busy,
  onCancel,
  onDevelop,
  onStagedDevelop,
}: DevelopModalProps) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>
          Develop {issue.owner}/{issue.repo} #{issue.number}
        </h3>
        <p className="modal-sub">{issue.title}</p>
        <label className="modal-label" htmlFor="devhub-cmd">
          Extra instructions (optional)
        </label>
        <textarea
          id="devhub-cmd"
          className="modal-input"
          placeholder="e.g. focus on the auth flow and keep the diff minimal"
          value={command}
          onChange={(e) => onCommandChange(e.target.value)}
          autoFocus
        />
        <label className="modal-label" htmlFor="devhub-model">
          Model (optional — default = pinned tiers)
        </label>
        <ModelPicker models={models} value={selectedModel} onChange={onSelectedModelChange} />
        <div className="modal-actions">
          <button className="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="develop-btn" onClick={onDevelop} disabled={busy}>
            {busy ? 'Starting…' : 'Start developing'}
          </button>
          <button className="validate-btn" onClick={onStagedDevelop} disabled={busy}>
            {busy ? 'Starting…' : 'Validate & Develop'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ModelChoice {
  key: string;
  label: string;
  hint?: string;
  model: ModelOption | null;
}

function ModelPicker({
  models,
  value,
  onChange,
}: {
  models: ModelOption[];
  value: ModelOption | null;
  onChange: (model: ModelOption | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => `${m.providerID} ${m.id}`.toLowerCase().includes(q));
  }, [models, query]);

  const choices = useMemo<ModelChoice[]>(() => {
    return [
      { key: '', label: 'Default (no override)', model: null },
      ...filtered.map((m) => ({
        key: `${m.providerID}:${m.id}`,
        label: `${m.id} (${m.providerID})`,
        model: m,
      })),
    ];
  }, [filtered]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(t);
  }, [open]);

  const toggle = () => {
    if (!open) {
      setQuery('');
      setHighlight(0);
    }
    setOpen(!open);
  };

  const select = (choice: ModelChoice) => {
    onChange(choice.model);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, choices.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const choice = choices[highlight];
      if (choice) select(choice);
    }
  };

  const valueKey = value ? `${value.providerID}:${value.id}` : '';

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        id="devhub-model"
        type="button"
        className="model-picker-toggle"
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="model-picker-label">
          {value ? `${value.id} (${value.providerID})` : 'Default (no override)'}
        </span>
        <span className="model-picker-caret">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="model-picker-menu" role="listbox" onKeyDown={onKeyDown}>
          <input
            ref={inputRef}
            className="model-picker-search"
            placeholder="Search models…  e.g. deepseek, gpt, mimo"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
          />
          <div className="model-picker-list">
            {choices.length === 0 && <div className="model-picker-empty">no models found</div>}
            {choices.map((choice, i) => (
              <button
                key={choice.key || '__default__'}
                type="button"
                role="option"
                aria-selected={choice.key === valueKey}
                className={`model-picker-item${i === highlight ? ' highlighted' : ''}${
                  choice.key === valueKey ? ' selected' : ''
                }`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => select(choice)}
              >
                <span className="model-picker-name">{choice.label}</span>
                {choice.hint && <span className="model-picker-hint">{choice.hint}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Rewire desktop `Card` in `page.tsx` to use the hook + component**

Replace `Card`'s body: delete its local `command`/`busy`/`open`/`models`/
`selectedModel` state and its `loadModels`/`openModal`/`develop`/
`stagedDevelop`/`transition` callbacks. Replace with:

```tsx
function Card({ issue, selected, onToggleSelection }: CardProps) {
  const color = repoColor(`${issue.owner}/${issue.repo}`);
  const developing = issue.state === 'developing';
  const {
    busy,
    modalOpen,
    openModal,
    closeModal,
    command,
    setCommand,
    models,
    selectedModel,
    setSelectedModel,
    develop,
    stagedDevelop,
    transition,
  } = useCardActions(issue.id);

  return (
    <div className="card" style={{ borderLeftColor: color }}>
      {/* ...unchanged card-header / title / excerpt / result blocks... */}

      {modalOpen && (
        <DevelopModal
          issue={issue}
          command={command}
          onCommandChange={setCommand}
          models={models}
          selectedModel={selectedModel}
          onSelectedModelChange={setSelectedModel}
          busy={busy}
          onCancel={closeModal}
          onDevelop={develop}
          onStagedDevelop={stagedDevelop}
        />
      )}
    </div>
  );
}
```

Keep every other line of `Card`'s JSX (checkbox, repo pill, title link,
excerpt, result rows, the `card-actions`/`recap-row` buttons calling
`transition`/`openModal`/`develop`) exactly as-is — only the state/callback
*source* changes, from local `useState`/`useCallback` to the hook. Add the
import:

```typescript
import { useCardActions } from '@/components/board/use-card-actions';
import { DevelopModal } from '@/components/board/develop-modal';
```

And delete the now-unused `ModelPicker`/`ModelChoice`/`interface CardProps`
develop/transition-related dead code left at the bottom of `page.tsx` (the
`ModelPicker` function itself moved into `develop-modal.tsx` in Step 2 —
remove the original from `page.tsx` entirely).

- [ ] **Step 4: Run the safe-change sequence**

Run: `cd devhub && npm run typecheck && npm run lint && npm test && npm run build`
Expected: all four PASS

- [ ] **Step 5: Manual desktop smoke check**

`npm run dev`, desktop width: click "Develop this" (fires immediately, no
modal), click "Develop (with validation)" (opens modal, model picker still
searchable/keyboard-navigable, Cancel closes it), click "Refine"/"Back to
backlog" on a backlog/refinement card (transitions). Confirm identical
behavior to before Task 2.

- [ ] **Step 6: Commit**

```bash
cd devhub && git add src/components/board/use-card-actions.ts src/components/board/develop-modal.tsx src/app/\(board\)/page.tsx
git commit -m "refactor: extract useCardActions hook and DevelopModal for reuse by the mobile board"
```

---

### Task 3: `useMediaQuery` hook and `isMobile` wiring

**Files:**
- Create: `src/components/board/use-media-query.ts`
- Modify: `src/app/(board)/page.tsx` (add `isMobile` state, no visual change
  yet)

**Interfaces:**
- Produces: `useMediaQuery(query: string): boolean`, `MOBILE_QUERY` constant.

- [ ] **Step 1: Write `src/components/board/use-media-query.ts`**

```typescript
'use client';

import { useEffect, useState } from 'react';

// Mirrors the repo's one mobile breakpoint (`@media (max-width: 768px)` in
// globals.css). Keep this string in sync with that value — see Global
// Constraints in the mobile-board-redesign plan.
export const MOBILE_QUERY = '(max-width: 768px)';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
```

- [ ] **Step 2: Wire `isMobile` into `BoardPage`**

In `src/app/(board)/page.tsx`, add the import and call inside `BoardPage`
(near the other top-of-component hooks, e.g. right after `const { user,
loading, denied, logout } = useAuth();`):

```typescript
import { useMediaQuery, MOBILE_QUERY } from '@/components/board/use-media-query';
```

```typescript
const isMobile = useMediaQuery(MOBILE_QUERY);
```

Don't branch any rendering on it yet — that starts in Task 4.

- [ ] **Step 3: Run the safe-change sequence**

Run: `cd devhub && npm run typecheck && npm run lint && npm test && npm run build`
Expected: all four PASS (an unused-variable lint error is expected and
acceptable to leave *only* transiently — if `npm run lint` fails on
`isMobile` being unused, that's fine to fix by starting Task 4 immediately
after; don't leave a broken lint state committed)

- [ ] **Step 4: Manual verification**

`npm run dev`, open React DevTools (or a temporary `console.log(isMobile)`
you remove before committing) and confirm it flips `true`/`false` as you
resize the browser across 768px.

- [ ] **Step 5: Commit**

Only commit once Task 4 makes `isMobile` load-bearing (an unused variable
shouldn't be committed on its own) — fold this task's diff into Task 4's
commit instead of committing here.

---

### Task 4: Mobile card + card-actions sheet

**Files:**
- Create: `src/components/board/mobile-card.tsx`
- Create: `src/components/board/card-actions-sheet.tsx`
- Modify: `src/app/globals.css` (new mobile-card + sheet styles)
- Modify: `src/app/(board)/page.tsx` (render `MobileCard` + sheet when
  `isMobile`)

**Interfaces:**
- Consumes: `primaryCardAction`, `cardActions`, `relTime`, `excerpt` from
  `@/lib/board-ui` (Task 1); `useCardActions` from Task 2.
- Produces: `<MobileCard>`, `<CardActionsSheet>`.

- [ ] **Step 1: Write `src/components/board/mobile-card.tsx`**

```tsx
'use client';

import Link from 'next/link';
import type { Issue } from '@/lib/types';
import { excerpt, primaryCardAction, relTime } from '@/lib/board-ui';

interface MobileCardProps {
  issue: Issue;
  color: string;
  busy: boolean;
  onPrimaryAction: () => void;
  onOpenActions: () => void;
}

export function MobileCard({ issue, color, busy, onPrimaryAction, onOpenActions }: MobileCardProps) {
  const developing = issue.state === 'developing';
  const primary = primaryCardAction(issue);

  return (
    <div className="mobile-card">
      <div className="mobile-card-strip" style={{ background: `${color}22` }}>
        <span className="mobile-card-dot" style={{ background: color }} />
        <span className="mobile-card-repo" style={{ color }}>
          {issue.owner}/{issue.repo}
        </span>
        <span className="mobile-card-number">#{issue.number}</span>
        <span className="mobile-card-age">{relTime(issue.updatedAt)}</span>
      </div>
      <div className="mobile-card-body">
        <a className="mobile-card-title" href={issue.htmlUrl} target="_blank" rel="noreferrer">
          {issue.title}
        </a>
        {issue.body && <div className="mobile-card-excerpt">{excerpt(issue.body)}</div>}
        {developing && (
          <div className="mobile-card-status">
            <span className="mobile-card-status-dot" />
            developing… (live via opencode)
          </div>
        )}
      </div>
      <div className="mobile-card-footer">
        {primary.kind === 'develop' ? (
          <button className="mobile-card-primary" onClick={onPrimaryAction} disabled={busy}>
            {primary.label}
          </button>
        ) : (
          <Link href={`/issues/${issue.id}`} className="mobile-card-primary mobile-card-primary-link">
            {primary.label}
          </Link>
        )}
        <button className="mobile-card-more" onClick={onOpenActions} aria-label="More actions">
          <span />
          <span />
          <span />
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write `src/components/board/card-actions-sheet.tsx`**

```tsx
'use client';

import type { Issue } from '@/lib/types';
import { cardActions, type CardActionId } from '@/lib/board-ui';

interface CardActionsSheetProps {
  issue: Issue;
  onClose: () => void;
  onSelect: (id: CardActionId) => void;
}

export function CardActionsSheet({ issue, onClose, onSelect }: CardActionsSheetProps) {
  const actions = cardActions(issue);

  return (
    <div className="card-sheet-backdrop" onClick={onClose}>
      <div className="card-sheet" role="menu" aria-label="Issue actions" onClick={(e) => e.stopPropagation()}>
        <div className="card-sheet-handle" />
        <div className="card-sheet-header">
          <div className="card-sheet-ref">
            {issue.owner}/{issue.repo} #{issue.number}
          </div>
          <div className="card-sheet-title">{issue.title}</div>
        </div>
        {actions.map((action) => (
          <button
            key={action.id}
            className="card-sheet-row"
            role="menuitem"
            onClick={() => {
              onSelect(action.id);
              onClose();
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add CSS**

Append to `src/app/globals.css` (after the existing `.bottom-nav` block —
Task 5 removes that block; adding this before removing it keeps the file
valid at every intermediate commit):

```css
/* Mobile card (2b treatment) + card-actions sheet — mobile only */
.mobile-card {
  display: none;
}

@media (max-width: 768px) {
  .mobile-card {
    display: flex;
    flex-direction: column;
    margin: 10px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }

  .mobile-card-strip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--border);
  }

  .mobile-card-dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    flex: none;
  }

  .mobile-card-repo {
    font-size: 11.5px;
    font-weight: 650;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mobile-card-number {
    font-size: 11.5px;
    color: var(--muted);
    flex: none;
  }

  .mobile-card-age {
    margin-left: auto;
    font-size: 11px;
    color: var(--muted);
    flex: none;
  }

  .mobile-card-body {
    padding: 12px 14px 14px;
  }

  .mobile-card-title {
    display: block;
    font-size: 15.5px;
    font-weight: 650;
    line-height: 1.35;
    color: var(--accent);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .mobile-card-excerpt {
    margin-top: 7px;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--muted);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .mobile-card-status {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 11px;
    padding: 8px 10px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 12px;
    font-style: italic;
    color: var(--muted);
  }

  .mobile-card-status-dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--developing);
    animation: dh-pulse 1.1s ease-in-out infinite;
    flex: none;
  }

  @keyframes dh-pulse {
    0%, 100% { opacity: 0.3; }
    50% { opacity: 1; }
  }

  .mobile-card-footer {
    display: flex;
    align-items: stretch;
    border-top: 1px solid var(--border);
  }

  .mobile-card-primary {
    flex: 1;
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 650;
    color: var(--accent);
    background: transparent;
    border: none;
  }

  .mobile-card-primary-link {
    text-decoration: none;
  }

  .mobile-card-more {
    width: 64px;
    height: 48px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    background: transparent;
    border: none;
    border-left: 1px solid var(--border);
  }

  .mobile-card-more span {
    width: 3.5px;
    height: 3.5px;
    border-radius: 999px;
    background: var(--muted);
  }

  /* Card-actions bottom sheet */
  .card-sheet-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 200;
  }

  .card-sheet {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--panel);
    border-top: 1px solid var(--border);
    border-radius: 20px 20px 0 0;
    padding: 10px 14px calc(env(safe-area-inset-bottom, 0px) + 10px);
  }

  .card-sheet-handle {
    width: 38px;
    height: 4px;
    border-radius: 999px;
    background: var(--border);
    margin: 0 auto 12px;
  }

  .card-sheet-header {
    padding: 0 4px 12px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 6px;
  }

  .card-sheet-ref {
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 5px;
  }

  .card-sheet-title {
    font-size: 14px;
    font-weight: 600;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .card-sheet-row {
    display: block;
    width: 100%;
    text-align: left;
    height: 52px;
    font-size: 15px;
    color: var(--text);
    background: transparent;
    border: none;
    border-top: 1px solid var(--border);
  }

  .card-sheet-row:first-of-type {
    border-top: none;
  }
}
```

- [ ] **Step 4: Wire into `BoardPage`**

In `src/app/(board)/page.tsx`:

Add state (near `activeColumn`):

```typescript
const [openActionsFor, setOpenActionsFor] = useState<Issue | null>(null);
```

Add the imports:

```typescript
import { MobileCard } from '@/components/board/mobile-card';
import { CardActionsSheet } from '@/components/board/card-actions-sheet';
import type { CardActionId } from '@/lib/board-ui';
```

(`page.tsx` itself never calls `cardActions()` — only `CardActionsSheet` does,
internally. `page.tsx` only needs the `CardActionId` type for the `switch` in
`CardActionsSheetWithActions` below. Importing the `cardActions` function
here too would be an unused import and fail `npm run lint`.)

In the `.board` column-rendering loop, replace the unconditional
`<Card key={issue.id} issue={issue} selected={...} onToggleSelection={...} />`
with:

```tsx
isMobile ? (
  <MobileCardWithActions key={issue.id} issue={issue} onOpenActions={() => setOpenActionsFor(issue)} />
) : (
  <Card
    key={issue.id}
    issue={issue}
    selected={selectedIds.has(issue.id)}
    onToggleSelection={toggleSelection}
  />
)
```

Add a small wrapper component below `Card` in `page.tsx` (it owns the
`useCardActions` hook for the mobile card + its own sheet's action
dispatch, mirroring how `Card` owns it for desktop):

```tsx
function MobileCardWithActions({
  issue,
  onOpenActions,
}: {
  issue: Issue;
  onOpenActions: () => void;
}) {
  const color = repoColor(`${issue.owner}/${issue.repo}`);
  const { busy, develop } = useCardActions(issue.id);

  return (
    <MobileCard issue={issue} color={color} busy={busy} onPrimaryAction={develop} onOpenActions={onOpenActions} />
  );
}
```

(The sheet itself — and the modal it can open via "Develop (with
validation)" — lives once at the `BoardPage` level, not per-card: see the
render block below. This keeps only one sheet/modal open at a time.)

Near the end of `BoardPage`'s JSX (as a sibling of the closing `.board` div,
so it overlays everything via its `position: fixed` backdrop), add:

```tsx
{openActionsFor && isMobile && (
  <CardActionsSheetWithActions
    issue={openActionsFor}
    onClose={() => setOpenActionsFor(null)}
    onToggleSelection={toggleSelection}
  />
)}
```

And define the dispatcher component (owns the same `useCardActions` hook
for the tapped issue, maps sheet selections to its methods, and renders
`DevelopModal` when "Develop (with validation)" is chosen):

```tsx
function CardActionsSheetWithActions({
  issue,
  onClose,
  onToggleSelection,
}: {
  issue: Issue;
  onClose: () => void;
  onToggleSelection: (issueId: number) => void;
}) {
  const {
    busy,
    modalOpen,
    openModal,
    closeModal,
    command,
    setCommand,
    models,
    selectedModel,
    setSelectedModel,
    develop,
    stagedDevelop,
    transition,
  } = useCardActions(issue.id);

  const handleSelect = (id: CardActionId) => {
    switch (id) {
      case 'develop-validated':
        openModal();
        break;
      case 'to-refinement':
        void transition('refinement');
        break;
      case 'to-backlog':
        void transition('backlog');
        break;
      case 'select-batch':
        onToggleSelection(issue.id);
        break;
      case 'open-github':
        window.open(issue.htmlUrl, '_blank', 'noopener,noreferrer');
        break;
      case 'recap':
        // Recap navigates via its own Link in the sheet row — see below.
        break;
    }
  };

  return (
    <>
      <CardActionsSheet issue={issue} onClose={onClose} onSelect={handleSelect} />
      {modalOpen && (
        <DevelopModal
          issue={issue}
          command={command}
          onCommandChange={setCommand}
          models={models}
          selectedModel={selectedModel}
          onSelectedModelChange={setSelectedModel}
          busy={busy}
          onCancel={closeModal}
          onDevelop={develop}
          onStagedDevelop={stagedDevelop}
        />
      )}
    </>
  );
}
```

`recap` needs to actually navigate, which a `switch` case can't do cleanly
— fix `CardActionsSheet` itself to render its `recap` row as a `next/link`
`<Link>` instead of a `<button>` (same pattern `MobileCard`'s primary action
already uses for the non-develop case). Update
`src/components/board/card-actions-sheet.tsx`'s row-rendering loop:

```tsx
{actions.map((action) =>
  action.id === 'recap' ? (
    <Link key={action.id} href={`/issues/${issue.id}`} className="card-sheet-row" role="menuitem" onClick={onClose}>
      {action.label}
    </Link>
  ) : (
    <button
      key={action.id}
      className="card-sheet-row"
      role="menuitem"
      onClick={() => {
        onSelect(action.id);
        onClose();
      }}
    >
      {action.label}
    </button>
  )
)}
```

(add `import Link from 'next/link';` to that file). `.card-sheet-row` as a
class works identically on `<a>` and `<button>` since it only sets layout/
typography, not element-specific properties.

- [ ] **Step 5: Run the safe-change sequence**

Run: `cd devhub && npm run typecheck && npm run lint && npm test && npm run build`
Expected: all four PASS

- [ ] **Step 6: Manual verification**

`npm run dev`, resize below 768px:
- Cards show the tinted header strip, title/excerpt, split footer.
- A `developing` card shows the pulsing status pill and its primary button
  reads "Recap (live)" and navigates to `/issues/[id]`.
- Tapping "..." opens the sheet with the right rows for that issue's state
  (compare against the `cardActions()` unit tests from Task 1).
- "Develop (with validation)" opens the same modal as desktop, with a
  working model picker.
- "Move to refinement"/"Move to backlog" actually transitions the card.
- "Select for batch" toggles the existing batch-selection state (check via
  the desktop "Develop selected (N)" header button appearing after
  selecting on mobile — no mobile-only selected-state affordance is added
  in this task; that's fine, the header batch controls are desktop-only
  today and out of scope here).
- "Open on GitHub" opens the issue in a new tab.
- Desktop (≥768px) is visually unchanged.

- [ ] **Step 7: Commit**

```bash
cd devhub && git add src/components/board/mobile-card.tsx src/components/board/card-actions-sheet.tsx src/components/board/use-media-query.ts src/app/globals.css src/app/\(board\)/page.tsx
git commit -m "feat: mobile card (2b treatment) and card-actions sheet"
```

---

### Task 5: Sticky status strip, replacing the bottom-nav

**Files:**
- Create: `src/components/board/mobile-status-strip.tsx`
- Modify: `src/app/globals.css` (add `.status-strip*`, remove `.bottom-nav*`
  — lines 1350-1417 as of `d2d79d8`, i.e. everything from the `/* Bottom
  navigation - hidden on desktop */` comment to the end of the file)
- Modify: `src/app/(board)/page.tsx` (render the strip on mobile, drop the
  `<nav className="bottom-nav">` block, adjust the per-column meta row)

**Interfaces:**
- Consumes: `countRepos` from `@/lib/board-ui` (Task 1); existing
  `activeColumn`/`scrollToColumn` from `BoardPage`.
- Produces: `<MobileStatusStrip>`.

- [ ] **Step 1: Write `src/components/board/mobile-status-strip.tsx`**

```tsx
'use client';

import type { IssueState } from '@/lib/types';

interface MobileStatusStripProps {
  columns: IssueState[];
  counts: Record<IssueState, number>;
  active: IssueState;
  onSelect: (column: IssueState) => void;
}

export function MobileStatusStrip({ columns, counts, active, onSelect }: MobileStatusStripProps) {
  return (
    <nav className="status-strip" role="tablist" aria-label="Board columns">
      {columns.map((col) => (
        <button
          key={col}
          className={`status-strip-tab${active === col ? ' active' : ''}`}
          onClick={() => onSelect(col)}
          role="tab"
          aria-selected={active === col}
          aria-label={`${col} column, ${counts[col] ?? 0} items`}
        >
          <span className={`dot ${col}`} />
          <span>{col}</span>
          <span className="status-strip-badge">{counts[col] ?? 0}</span>
        </button>
      ))}
    </nav>
  );
}
```

(Every tab always shows its count badge — the canvas's `showTabCounts` prop
was a design-tool preview toggle, not a spec for per-tab conditional
badges; see the design doc's "Explicitly deferred" section.)

- [ ] **Step 2: Replace `.bottom-nav*` CSS with `.status-strip*`**

In `src/app/globals.css`, delete everything from the
`/* Bottom navigation - hidden on desktop */` comment to the end of the
file (the `.bottom-nav`, `.bottom-nav-tab`, `.bottom-nav-tab > span`,
`.bottom-nav-tab .dot`, `.bottom-nav-tab:hover`, `.bottom-nav-tab.active`,
`.bottom-nav-badge`, `.bottom-nav-tab.active .bottom-nav-badge` rules and
their enclosing `@media (max-width: 768px)` block). Replace with:

```css
.status-strip {
  display: none;
}

@media (max-width: 768px) {
  .status-strip {
    display: flex;
    position: sticky;
    top: 0;
    z-index: 15;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }

  .status-strip::-webkit-scrollbar {
    display: none;
  }

  .status-strip-tab {
    display: flex;
    align-items: center;
    gap: 7px;
    flex: none;
    height: 44px;
    padding: 0 12px;
    border: none;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--muted);
    font-size: 13.5px;
    text-transform: capitalize;
    cursor: pointer;
  }

  .status-strip-tab.active {
    color: var(--text);
    font-weight: 650;
    border-bottom-color: var(--muted);
  }

  .status-strip-badge {
    font-size: 11.5px;
    font-weight: 650;
    color: var(--muted);
    background: var(--panel-2);
    border-radius: 999px;
    padding: 1px 6px;
  }

  .status-strip-tab.active .status-strip-badge {
    color: var(--bg);
    background: var(--muted);
  }

  .column-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 2px 8px;
    font-size: 12px;
    color: var(--muted);
  }

  .column-meta .sort-toggle {
    margin-left: auto;
  }
}
```

- [ ] **Step 3: Wire into `BoardPage`**

Add the import:

```typescript
import { MobileStatusStrip } from '@/components/board/mobile-status-strip';
```

Delete the `<nav className="bottom-nav" role="tablist" ...>...</nav>` block
entirely (it's the last JSX block before `BoardPage`'s closing `</div>`).

Add the strip right above the `<div className="board" ref={boardRef}>`
element:

```tsx
{isMobile && (
  <MobileStatusStrip
    columns={COLUMNS}
    counts={Object.fromEntries(COLUMNS.map((c) => [c, issues.filter((i) => i.state === c).length])) as Record<IssueState, number>}
    active={activeColumn}
    onSelect={(col) => {
      setActiveColumn(col);
      scrollToColumn(col);
    }}
  />
)}
```

In the per-column render (inside the `COLUMNS.map((col) => { ... })` block),
replace the unconditional `.column-head` with a mobile/desktop branch:

```tsx
{isMobile ? (
  <div className="column-meta">
    <span>
      {items.length} issues · {countRepos(items)} repos
    </span>
    <button
      className="sort-toggle"
      onClick={() => setSorts((s) => ({ ...s, [col]: s[col] === 'oldest' ? 'newest' : 'oldest' }))}
      title={`Sort ${sorts[col] === 'oldest' ? 'oldest' : 'newest'} first`}
      aria-label={`Sort ${col} ${sorts[col] === 'oldest' ? 'oldest' : 'newest'} first`}
    >
      {sorts[col] === 'oldest' ? '↑ oldest' : '↓ newest'}
    </button>
  </div>
) : (
  <div className="column-head">
    <span className={`dot ${col}`} />
    {col}
    <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({items.length})</span>
    <button
      className="sort-toggle"
      onClick={() => setSorts((s) => ({ ...s, [col]: s[col] === 'oldest' ? 'newest' : 'oldest' }))}
      title={`Sort ${sorts[col] === 'oldest' ? 'oldest' : 'newest'} first`}
      aria-label={`Sort ${col} ${sorts[col] === 'oldest' ? 'oldest' : 'newest'} first`}
    >
      {sorts[col] === 'oldest' ? '↑ oldest' : '↓ newest'}
    </button>
  </div>
)}
```

Add `countRepos` to the `@/lib/board-ui` import line started in Task 1.

- [ ] **Step 4: Run the safe-change sequence**

Run: `cd devhub && npm run typecheck && npm run lint && npm test && npm run build`
Expected: all four PASS

- [ ] **Step 5: Manual verification**

`npm run dev`, below 768px: the bottom-nav is gone; a sticky tab strip sits
right under the header, scrolls horizontally if needed, and tapping a tab
scrolls the board to that column (same swipe/snap behavior as before,
different chrome). Each column shows "`N` issues · `M` repos" + the sort
toggle instead of the old "`● backlog (21)`" line. Desktop is unchanged
(still no bottom-nav there — it was already mobile-only — and the desktop
`.column-head` still shows the dot+name+count it always did).

- [ ] **Step 6: Commit**

```bash
cd devhub && git add src/components/board/mobile-status-strip.tsx src/app/globals.css src/app/\(board\)/page.tsx
git commit -m "feat: sticky top status strip replaces the mobile bottom-nav"
```

---

### Task 6: Full-screen search sheet

**Files:**
- Create: `src/components/board/mobile-search-sheet.tsx`
- Modify: `src/app/globals.css` (add `.search-sheet*`)
- Modify: `src/app/(board)/page.tsx` (mobile header search opens the sheet
  instead of the `.search-help` popover)

**Interfaces:**
- Consumes: `matchesIssue`, `repoColor` from `@/lib/board-ui` (Task 1).
- Produces: `<MobileSearchSheet>`.

- [ ] **Step 1: Write `src/components/board/mobile-search-sheet.tsx`**

```tsx
'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import type { Issue } from '@/lib/types';
import { matchesIssue, repoColor } from '@/lib/board-ui';

interface MobileSearchSheetProps {
  query: string;
  onQueryChange: (value: string) => void;
  repos: string[];
  repoFilter: string | null;
  onRepoFilterChange: (repo: string | null) => void;
  issues: Issue[];
  onClose: () => void;
}

const FILTER_TAGS = ['repo:', 'title:', 'owner:', 'state:', 'body:', 'number:'];

export function MobileSearchSheet({
  query,
  onQueryChange,
  repos,
  repoFilter,
  onRepoFilterChange,
  issues,
  onClose,
}: MobileSearchSheetProps) {
  const matches = useMemo(() => {
    if (!query.trim() && !repoFilter) return [];
    return issues
      .filter((i) => matchesIssue(i, query) && (!repoFilter || `${i.owner}/${i.repo}` === repoFilter))
      .slice(0, 30);
  }, [issues, query, repoFilter]);

  return (
    <div className="search-sheet">
      <div className="search-sheet-header">
        <input
          className="search-sheet-input"
          placeholder="Search…  e.g. repo:web title:auth or free text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          autoFocus
        />
        <button className="search-sheet-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>

      <div className="search-sheet-body">
        <div className="search-sheet-section">
          <div className="search-sheet-label">Repos</div>
          <div className="search-sheet-chips">
            <button
              className={`search-sheet-chip${repoFilter === null ? ' active' : ''}`}
              onClick={() => onRepoFilterChange(null)}
            >
              All
            </button>
            {repos.map((r) => (
              <button
                key={r}
                className={`search-sheet-chip${repoFilter === r ? ' active' : ''}`}
                onClick={() => onRepoFilterChange(repoFilter === r ? null : r)}
              >
                <span className="search-sheet-chip-dot" style={{ background: repoColor(r) }} />
                {r}
              </button>
            ))}
          </div>
        </div>

        <div className="search-sheet-section">
          <div className="search-sheet-label">Filters</div>
          <div className="search-sheet-tags">
            {FILTER_TAGS.map((tag) => (
              <span key={tag} className="search-sheet-tag">
                {tag}
              </span>
            ))}
          </div>
          <div className="search-sheet-hint">Combine filters with plain text, e.g. repo:web auth</div>
        </div>

        <div className="search-sheet-section">
          <div className="search-sheet-label">{matches.length} matches</div>
          <div className="search-sheet-matches">
            {matches.map((issue) => (
              <Link key={issue.id} href={`/issues/${issue.id}`} className="search-sheet-match" onClick={onClose}>
                <span className={`dot ${issue.state}`} />
                <span className="search-sheet-match-title">
                  #{issue.number} {issue.title}
                </span>
                <span className="search-sheet-match-state">{issue.state}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add CSS**

Append to `src/app/globals.css`:

```css
@media (max-width: 768px) {
  .search-sheet {
    position: fixed;
    inset: 0;
    z-index: 300;
    background: var(--bg);
    display: flex;
    flex-direction: column;
  }

  .search-sheet-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
  }

  .search-sheet-input {
    flex: 1;
    height: 44px;
    padding: 0 12px;
    background: var(--panel);
    border: 1px solid var(--accent);
    border-radius: 10px;
    color: var(--text);
    font-size: 14px;
  }

  .search-sheet-cancel {
    flex: none;
    height: 44px;
    padding: 0 4px;
    background: transparent;
    border: none;
    color: var(--accent);
    font-size: 14px;
  }

  .search-sheet-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px 14px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .search-sheet-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .search-sheet-label {
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .search-sheet-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .search-sheet-chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 36px;
    padding: 0 13px;
    border: 1px solid var(--border);
    background: var(--panel);
    border-radius: 999px;
    color: var(--text);
    font-size: 12.5px;
  }

  .search-sheet-chip.active {
    border-color: var(--accent);
    background: var(--panel-2);
    font-weight: 600;
  }

  .search-sheet-chip-dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
  }

  .search-sheet-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .search-sheet-tag {
    font-size: 12px;
    color: var(--accent);
    background: rgba(88, 166, 255, 0.1);
    border-radius: 6px;
    padding: 4px 8px;
  }

  .search-sheet-hint {
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--muted);
  }

  .search-sheet-matches {
    display: flex;
    flex-direction: column;
  }

  .search-sheet-match {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 0;
    border-top: 1px solid var(--border);
    color: var(--text);
    text-decoration: none;
  }

  .search-sheet-match-title {
    flex: 1;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .search-sheet-match-state {
    font-size: 11px;
    color: var(--muted);
  }
}
```

- [ ] **Step 3: Wire into `BoardPage`**

Add state and import:

```typescript
const [searchSheetOpen, setSearchSheetOpen] = useState(false);
```

```typescript
import { MobileSearchSheet } from '@/components/board/mobile-search-sheet';
```

In the header's `.search-wrapper` block, wrap the existing desktop
`<input className="search" .../>` + `.search-help` popover so mobile shows
a tappable button instead:

```tsx
<div className="search-wrapper">
  {isMobile ? (
    <button className="search-mobile-trigger" onClick={() => setSearchSheetOpen(true)} aria-label="Search issues">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M10.68 11.74a6 6 0 01-7.922-8.982 6 6 0 018.982 7.922l3.04 3.04a.749.749 0 01-1.06 1.06zM11.5 7a4.5 4.5 0 10-9 0 4.5 4.5 0 009 0z" />
      </svg>
      <span>{query || 'Search issues'}</span>
    </button>
  ) : (
    <>
      <input
        className="search"
        placeholder="Search…  e.g. repo:devhub title:auth or free text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="search-help" ref={helpRef}>
        {/* ...unchanged popover... */}
      </div>
    </>
  )}
</div>
```

Add `.search-mobile-trigger` CSS next to the other mobile header rules in
the existing `@media (max-width: 768px)` block (reusing the same 44px
height as `.search`):

```css
.search-mobile-trigger {
  flex: 1;
  min-width: 0;
  height: 44px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--muted);
  font-size: 13.5px;
}

.search-mobile-trigger span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

At the end of `BoardPage`'s JSX (sibling of the other overlay renders from
Task 4/5):

```tsx
{searchSheetOpen && isMobile && (
  <MobileSearchSheet
    query={query}
    onQueryChange={setQuery}
    repos={repos}
    repoFilter={repoFilter}
    onRepoFilterChange={setRepoFilter}
    issues={issues}
    onClose={() => setSearchSheetOpen(false)}
  />
)}
```

- [ ] **Step 4: Run the safe-change sequence**

Run: `cd devhub && npm run typecheck && npm run lint && npm test && npm run build`
Expected: all four PASS

- [ ] **Step 5: Manual verification**

`npm run dev`, below 768px: the header search is now a tappable field
showing the current query (or placeholder text); tapping it opens a
full-screen sheet with repo chips, the filter-syntax legend, and a live
match list that updates as you type or pick a repo chip; tapping a match
navigates to its recap page and closes the sheet; Cancel closes without
navigating. Desktop search input + "?" popover unchanged.

- [ ] **Step 6: Commit**

```bash
cd devhub && git add src/components/board/mobile-search-sheet.tsx src/app/globals.css src/app/\(board\)/page.tsx
git commit -m "feat: full-screen search sheet replaces the mobile search popover"
```

---

### Task 7: End-to-end verification and docs

**Files:**
- Modify: `devhub/AGENTS.md` (note the new `src/components/board/`
  directory in "Domain wiring" or add a line to "Project layout" in
  `README.md`)
- None else (verification only)

- [ ] **Step 1: Full safe-change sequence**

Run: `cd devhub && npm run typecheck && npm run lint && npm test && npm run build`
Expected: all four PASS

- [ ] **Step 2: Manual pass through every issue state at <768px**

Using `npm run dev` at a mobile viewport, confirm for one issue in each of
`backlog`, `refinement`, `developing`, `pr`, `blocked`, `rollout`:
- Card renders (tinted strip, title/excerpt, correct primary footer button
  per `primaryCardAction()`).
- The actions sheet lists exactly the rows `cardActions()` specifies for
  that state (cross-check against the Task 1 unit tests).
- Status strip counts match the number of visible cards per column.
- Search sheet finds the issue via free text and via each `field:` filter.

- [ ] **Step 3: Desktop regression pass**

At ≥768px: board looks and behaves exactly as on `master` before this plan
(cards, bottom toolbar, batch selection, keyboard shortcuts, model picker,
search popover) — none of this plan's changes are visible on desktop.

- [ ] **Step 4: Update `README.md`'s "Project layout" table**

Add a row after the existing `src/components/{logo,auth-ui,use-auth}.tsx`
line:

```
src/components/board/{mobile-card,card-actions-sheet,               mobile board UI (<768px) + shared
  mobile-status-strip,mobile-search-sheet,use-card-actions,          develop/transition logic
  use-media-query,develop-modal}.tsx
```

- [ ] **Step 5: Commit**

```bash
cd devhub && git add README.md
git commit -m "docs: document the mobile board component directory"
```

---

## Self-Review

**Spec coverage** (against `2026-08-31-devhub-mobile-board-redesign-design.md`):
- Board header/status-strip/column-meta → Task 5. ✅
- 2b card treatment → Task 4. ✅
- Card actions sheet → Task 4. ✅
- Developing pill + Recap (live) primary → Task 4 (`MobileCard`,
  `primaryCardAction`); elapsed-time explicitly deferred per the design
  doc. ✅
- Search sheet → Task 6. ✅
- Design tokens (CSS custom properties, not mockup hex) → stated as a
  Global Constraint and followed in every CSS block above. ✅
- Deferred items (2a, header overflow menu, density/showTabCounts props,
  per-column released strip) → explicitly called out in the design doc and
  not implemented by any task. ✅

**Placeholder scan:** every step above has literal code, not a description
of code; every "Run:" step names the exact command; no "TBD"/"add
appropriate handling" language appears.

**Type consistency:** `UseCardActionsResult` (Task 2) is the single shape
returned by `useCardActions` and consumed identically by desktop `Card`
(Task 2), `MobileCardWithActions` (Task 4), and
`CardActionsSheetWithActions` (Task 4) — same field names throughout.
`CardActionId`/`CardAction` (Task 1) are consumed unchanged by
`cardActions()`'s callers in `CardActionsSheet` (Task 4) and the `switch` in
`CardActionsSheetWithActions` (Task 4). `PrimaryCardAction` (Task 1) is
consumed unchanged by `MobileCard` (Task 4).

## Execution options

**1. Subagent-Driven (recommended)** — a fresh subagent per task, with
review between tasks and fast iteration.

**2. Inline Execution** — execute tasks in this session using
`executing-plans`, batch execution with checkpoints for review.

Which approach?
