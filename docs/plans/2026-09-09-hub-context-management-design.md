# Context management for project and ideas — design (2026-09-09)

Status: proposed, not yet implemented.
Not a follow-up to the hub-journey redesign (`docs/hub-user-journey-review`
branch) — separate concern, separate branch.

## Problem

Every AI entry point in DevHub — Discuss (`shape-idea.ts`), Suggest next
(`suggest.ts`), Refine (`validate.ts`, part of Work), Develop
(`opencode.ts:buildDevelopPrompt`, part of Work), and Realize
(`realize.ts`) — independently rebuilds its own prompt from scratch. The
only "project context" any of them get is `project.config`, an
unstructured JSON blob that defaults to `{}` and nothing currently writes
anything meaningful into. Nothing accumulates across calls, and nothing
hands over between phases except one lossy exception: when a topic is
promoted to an issue, `promoteTopicForRealize` (`realize.ts:223`) bakes
`topic.notes` + `Shaped: {topic.shapedSummary}` + `Area:` into the new
issue's body — a one-paragraph snapshot. The full shaping thread (which
options were offered, which was chosen, why) is discarded at that point;
`buildDevelopPrompt` never sees it.

## Two tiers

Note: these two tiers touch two different repos (Tier 1 is `container`,
Tier 2 is `devhub`) and have no code dependency on each other — they can
be implemented, reviewed, and rolled out independently, in either order,
each with its own implementation plan.

### Tier 1 — project-level growing knowledge (infra, not app code)

**Decision: adopt `opencode-mem` (MIT, tickernelz/opencode-mem) instead of
building a custom capture/injection pipeline.**

All five AI entry points already run as opencode sessions on the same
self-hosted opencode instance (`container/opencode`, deployed via the
`opencode` Ansible role). `opencode-mem` is an opencode plugin that
auto-captures "memorable insights" from every session with no curation
step, stores them locally (embedded Turso/libSQL, no extra service), and
injects relevant memory back into future sessions — scoped per repo by
default (git remote or project root).

**Change**: add `"opencode-mem"` to the `plugin` array in
`container/opencode/scripts/opencode.json.template` (which already loads
`opencode-antigravity-auth@latest` the same way) and redeploy via the
existing `opencode` role — its `Deploy OpenCode config template` task
already has `notify: restart opencode container` wired up. No DevHub
(Next.js) code changes.

**Open question to verify on rollout** (not blocking this spec): the
plugin's default scoping is per repo. A DevHub *project* can span two
repos (service + infra — see `planRunsForIssue` / `ENV.infraRepo`), and
opencode is invoked from a worktree subdirectory
(`{OPENCODE_WORKSPACE_ROOT}/{repo}/.worktrees/{issueId}-{role}`), not the
repo root. Whether the plugin's project-root detection holds up from a
worktree path, and whether per-repo (rather than per-DevHub-project)
scoping is fine as-is or needs the plugin's `.opencode-mem-project`
marker file, can only be confirmed by deploying it and watching real
sessions — verify after rollout, not before. The change is one line and
trivially reversible if it doesn't hold up.

### Tier 2 — idea-level hand-over (custom, in DevHub)

**Decision: thread the full shaping thread into the first develop prompt,
not just the one-paragraph snapshot.**

- New type in `src/lib/opencode.ts` (next to `DevelopCarryOver`):
  ```ts
  export interface IdeaContext {
    summary: string;
    considered: { title: string; desc: string; tradeoff?: string; chosen: boolean }[];
  }
  ```
- New pure function `buildIdeaContext(topic: Topic, messages: IdeaMessage[]): IdeaContext | null`
  in `src/lib/shape-idea.ts` (same module that already parses
  `IdeaMessage.options`/`chosenOption` — backed by the existing
  `idea_messages.options_json`/`chosen_option` columns — into structured
  data; no new schema, no new DB columns). Returns `null` when there's no
  shaping thread to summarize (e.g. a topic created without ever going
  through Discuss).
- `promoteTopicForRealize` (`realize.ts:223`) calls `buildIdeaContext`
  after loading the topic's messages, and passes the result through to
  the *first* `startDevelop` call for the newly-created issue — same
  parameter-threading pattern `DevelopCarryOver` already uses for the
  service→infra boundary, just for the idea→issue boundary.
- `buildDevelopPrompt` (`opencode.ts:480`) gains an optional `ideaContext`
  parameter. When present, it renders a `## Why this idea was shaped this
  way` section (summary + considered options, marking which was chosen)
  immediately before `## Steps` — same placement pattern as the existing
  `## Carry-over from the previous run` block.
- The issue body still gets the short human-readable snapshot it gets
  today (GitHub-side visibility) — unchanged.
- Only the *first* develop run for a freshly-promoted issue receives
  `ideaContext`. Retries and later runs rely on the issue body (which
  already has the snapshot) plus Tier 1 memory instead — avoids
  re-injecting the same context on every retry.

## Data model changes

- Tier 1: none in DevHub. Storage lives entirely inside `opencode-mem` on
  the opencode host.
- Tier 2: none. `IdeaContext` is computed at promotion time from data
  that already exists (`topic.shapedSummary`, `topic.notes`,
  `idea_messages.options_json`/`chosen_option`) and is not itself
  persisted — it's cheap to re-derive if ever needed again, so there's
  nothing to keep in sync.

## Error handling

- Tier 1: entirely opencode's concern. If the plugin errors, is slow, or
  a fresh deploy has no memory yet, DevHub's prompts are unaffected — this
  tier is purely additive on the opencode side; DevHub never calls it
  directly and never blocks on it.
- Tier 2: if `buildIdeaContext` returns `null` (no shaping thread),
  `ideaContext` is simply omitted from the prompt — `startDevelop`/
  `buildDevelopPrompt` behave exactly as they do today. Not an error path.

## Testing

- Tier 1: infra, not application code — no unit tests. Verify manually
  after rollout: the plugin loads (container logs / opencode health
  check), a note captured during a session on one repo is retrievable in
  a later session on the *same* repo, and does **not** surface in a
  session on an unrelated repo (the scoping check that matters most).
- Tier 2: `buildIdeaContext` is a pure function — straightforward unit
  tests (empty thread → `null`; a thread with 3 options and one
  `chosenOption` → the matching `considered[].chosen`). `buildDevelopPrompt`
  gets one more case alongside its existing `carryOver` coverage: prompt
  contains the `## Why this idea was shaped this way` section when
  `ideaContext` is passed, omits it when not.

## Rollout order

1. **Tier 1 first** — near-zero engineering cost (one config line in
   `container`), immediately useful, fully reversible. Verify the
   worktree/scoping open question against real sessions once deployed.
2. **Tier 2 second** — small, contained DevHub change (`IdeaContext` type
   + `buildIdeaContext` + two call-site edits + tests).

## Out of scope (explicitly deferred)

- Semantic/relevance-based retrieval beyond whatever `opencode-mem` does
  internally (e.g. a direct `sqlite-vec` integration in DevHub's own DB)
  — only worth revisiting if Tier 1 in practice proves insufficient.
- A human-curation UI for project knowledge — ruled out by the
  auto-captured-only requirement this design was scoped against.
- Compaction of Tier 2 idea context over time — it's a one-time hand-over
  at promotion, not a growing log; there is nothing to compact.
