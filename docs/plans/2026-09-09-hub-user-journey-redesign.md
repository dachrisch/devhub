# DevHub hub redesign — unified funnel (2026-09-09)

Status: design locked, mocked as a Claude Design canvas — not yet implemented.
Canvas: https://claude.ai/code/artifact/8b0671f5-515d-4b83-a0ea-f084a3644ebe
Follow-up to: `docs/plans/2026-09-09-hub-user-journey-review.md` (same branch).

## Decision

Two flows today — topics (`new → shaping → ready → realizing → shipped`) and
issues (`backlog → refinement → developing → pr` + `rollout`/`closed` strips)
— bridged by a manual "→ issue" promotion. That seam causes the needs-input
thread-lock bug (review 1.6) and reads as two products stitched together.

Kept: the data model split. An idea is cheap to create/discard/merge; a
GitHub issue is not, and shouldn't exist for every fleeting idea.
Changed: the board draws ONE lane so the seam never shows to the user.

## New board: Idea → Ready → Realizing → Rollout → Delivered

- **idea** = topic `new` + `shaping`. No repo/number yet; card footer is
  "Discuss →", not "Work". The topics rail above the board is gone entirely —
  ideas are just the first column now.
- **ready** = topic `ready` + issue `backlog`, same phase. Promotion to a
  real GitHub issue now happens automatically when an idea is marked ready,
  not a manual "→ issue" click.
- **realizing** = issue `refinement` + `developing`, same phase. A card shows
  either the validation note or the live "developing…" line; column position
  no longer encodes which sub-stage it's in.
- **rollout** = issue `pr` + `rollout`. Still needs a human to review/merge,
  so it stays a live column, not history — this also resolves the "is a PR
  done?" ambiguity from the original review's `pr` "borderline" note.
- **delivered** = the only real history left: released + dropped/not-planned,
  muted and collapsed below the four live columns (same treatment recommended
  in review section 2, just narrower in scope now that rollout is live).

## Also locked (home + mobile, unchanged from the review's Highest-value fixes)

- Home: first-run hint ("Pick one to open its board →") above the projects
  grid; Released/Closed demoted to a muted, collapsed strip below the grid
  instead of two strips above it.
- Mobile: repo-filter chips surface directly under the status tabs instead of
  hiding in the scroll container; Done collapses to a badge-only tab.
- Batch bar: label names the real direction ("Move to Refinement (n)")
  instead of the ambiguous "Advance selected (n)".

## Considered and dropped

- `pr` kept as its own narrow, muted column separate from a Released+Closed
  Done rail — superseded by folding `pr` into `rollout` above; a narrower
  fourth column is unnecessary once rollout is understood as "still live."
- Mobile repo filter tucked behind a "Filter" toggle instead of a permanent
  chip row — not adopted; still on the table if the chip row turns out to
  cost too much vertical space in practice.

## Not designed yet (behavior/copy fixes from the original review, section 3)

1. Realize needs-input reply — don't lock the topic thread when input is
   needed, or deep-link the blocking issue. Partially addressed structurally
   (automatic ready→issue promotion removes one class of this bug), but the
   live needs-input-while-realizing case still needs a fix.
2. README.md still describes the old 4-column board — needs an update once
   this ships.

## Implementation note

This is a design-only artifact (Claude Design canvas), not code. No
component, route, or schema changes have been made. Turning this into an
implementation plan (a unified `topic`/`issue` view, auto-promotion on ready,
possibly the mobile filter toggle) is separate follow-up work.
