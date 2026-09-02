# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

DevHub is a personal, single-user command board: it ingests open GitHub issues (filtered by
topic) into a Kanban-style board, and dispatches an [opencode](https://opencode.ai) session on
`code.lehel.xyz` to implement an issue and open a PR, streaming progress back to the UI over SSE.
Next.js 15 App Router, React 19, TypeScript, `better-sqlite3` for state, `undici` for the
opencode HTTP client, `vitest` for tests. State is entirely server-side (SQLite); there is no
client-side data store.

For commands, toolchain gotchas, App Router specifics, domain wiring (store/github/opencode/develop),
and env/auth setup, see `AGENTS.md` (imported below) — this file does not repeat it.

## Issue state machine

`src/lib/types.ts` defines the single source of truth: `backlog → refinement → developing → pr →
rollout` with a `blocked` state reachable from `developing`. Key invariants enforced across the
codebase (not visible from any single file):

- **Manual transitions** (`POST /api/issues/[id]/transition`, `src/lib/transitions.ts`) only
  permit `backlog ↔ refinement`. Every other transition is system-driven.
- **`develop`** (`src/lib/develop.ts`) moves `backlog|refinement|blocked → developing`, then on
  completion to `pr` (success) or `blocked` (`CANNOT FULFILL` or failure). It refuses to run
  against a `pr` issue — `canDevelop` is the gate.
- **`sweepRollouts`** (`src/lib/github.ts`, run as part of `POST /api/issues` refresh) is the only
  path from `pr → rollout`: it checks the linked PR is merged *and* the merge commit is contained
  in a release tag before advancing.
- **Ingest** (`upsertIssue` in `src/lib/store.ts`) only writes GitHub metadata onto a row that is
  still `backlog` — it never overwrites a card that has moved into `refinement`/`developing`/
  `pr`/`rollout`/`blocked`, so a re-ingest can't clobber in-flight work.

Together these mean the board's state is a strict one-way pipeline except for the
`backlog ↔ refinement` refinement loop and the terminal `blocked` escape hatch back into
`developing` via a fresh `develop` call.

@AGENTS.md
