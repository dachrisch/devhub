# Whole-board command scope — design

> Status: validated (2026-10-09). Follows `2026-10-08-devhub-v2-command-first-design.md`.

## Problem

An open-ended ask — `"which low hanging fruits next?"` — is force-fit into the
`implement` pipeline. Because it names no repo, the resolver treats the missing
target as a blocking error and offers repo chips (in the worst case the entire
`/user/repos` list via `fetchRepoNames`). The operator is asked to pick a repo
for a question that is explicitly about the board as a whole. It makes no sense.

Root cause: the resolver collapses **action** and **scope** into the same three
buckets (`implement` / `strategy` / `question`), and has no representation of a
*target-optional, whole-board* ask. `targets: []` is overloaded to mean both
"unresolved" and "no particular target".

## Model

Two independent axes:

- **Action** — answer / plan / implement. The existing strategy thread already
  covers "answer or plan," so no new action kind is added; whole-board asks run
  as strategy threads.
- **Scope** — `issue #N` · `repo(s)` · **board** (all synced board issues) ·
  `dangling` (a repo-shaped token the operator named that did not resolve).

`targets: []` now *means* **whole board**, not "unresolved."

**The context is the board, not GitHub.** The resolution universe and the
planner brief are both derived from `getGithubIssues()` — the GitHub-backed
issues already synced into DevHub (what the cards render). The `/user/repos`
registry is never the source of a chip list or a scope. `buildContextBrief`
narrows the brief further (open + recently closed ~30d, skipping `rollout`).

### Intent detection

- Explicit repo/issue mention → `implement` (or `strategy` when multi-target).
- No target + `STRATEGY_RE` → `strategy`.
- No target + exploratory/interrogative phrasing (an ask that opens with
  which/what/should/… , or names board-wide work like "low hanging"/"next
  steps"/"roadmap") → `strategy` over the whole board.
- Otherwise, with an open thread → `question` (follow-up); without → `implement`
  (which still needs a target, via an issue-search chip).

### Chips are action-gated

A `repo-choice` chip is emitted only for a **repo-shaped** token the operator
actually named (full `owner/name`, or a shorthand that fuzzily matched ≥1 board
repo and was ambiguous). Generic free-text words never dump the repo list. All
chip options are board repos. An exact `owner/repo` mention is still honored
even if the repo has no board issues yet (the one escape hatch).

## Data flow

```
input ─▶ resolveCommand(text, boardRepos, opts)
           │  scope: issue | repos | board | dangling
           ▼
     route.ts ── board strategy (targets=[]) ─▶ startStrategyThread(thread, [])
                                                      │
                                          buildScopeBrief(issues, [])  ⇒ all board issues
                                                      ▼
                                            buildContextBrief ⇒ planner
```

## Changes

- `src/lib/store.ts` — `getBoardRepos()`: distinct `owner/repo` from
  `getGithubIssues()`, sorted.
- `src/lib/resolve.ts` — add `scope` to `ResolveResult`; whole-board strategy
  detection in `parseIntent`; `mapRepos` restricted to board repos and gated to
  repo-shaped dangling mentions; empty-target strategy ⇒ `scope:'board'`, no
  chips.
- `src/lib/threads-run.ts` — extract pure `buildScopeBrief(issues, targets)`;
  `startStrategyThread` uses empty `targets` ⇒ all board issues.
- `src/lib/plan.ts` — `buildPlannerPrompt` takes a whole-board flag and states
  there is no repo filter.
- `src/app/api/threads/route.ts` — board repos replace `fetchRepoNames`
  (`/user/repos`); whole-board strategy routes to `startStrategyThread(thread,
  [])`; the `newWork` chip fires only for a resolved/explicit implement.

## Failure modes

- Repo-shaped token that matches nothing → `repo-choice` chip restricted to
  board repos (never a guess, never the full registry).
- Pure free-text with no repo shape → no chip; whole-board strategy.
- Planner yields nothing → thread stays `planning`/`blocked` (unchanged).

## Non-goals (YAGNI)

- No LLM intent classifier; keep the deterministic regex + heuristics.
- No new thread kind or action column.
- No per-view / selection-derived scope (scope derives from the board corpus,
  not from scroll or checkbox state).

## Testing

- `resolve.test.ts`: whole-board question → `strategy`/`scope:'board'`/no chips;
  generic words no longer yield a chip; dangling repo-shaped mention →
  board-restricted chip; ambiguous shorthand options ⊆ board repos.
- `plan.test.ts`: whole-board prompt note.
- `threads-run.test.ts`: `buildScopeBrief` empty targets ⇒ all issues.

## Verification

`npm run typecheck` → `npm run lint` → `npm test` → `npm run build`.
