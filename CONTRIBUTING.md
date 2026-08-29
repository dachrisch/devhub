# Contributing

DevHub is a personal, single-user project, but patches and improvements are welcome.

## Getting started

```bash
cp .env.example .env   # fill in tokens
npm install
npm run dev
```

A C toolchain (`make`, `g++`, `python3`) is required because `better-sqlite3` is a native
module. On Alpine: `apk add --no-cache build-base`.

## Before you open a change

Run the safe-change sequence and make sure all are green:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Conventions

- **TypeScript pinned to `^5`.** Next 15 rejects the TypeScript 7 native compiler — do not bump
  it. The lint script is `eslint .`, not `next lint` (deprecated + TS7-incompatible here).
- **Relative imports are extensionless** (`import { x } from './store'`). A `./store.js`
  specifier compiles under `tsc` and resolves in vitest but **fails the Next/webpack build**.
  Prefer the `@/lib/...` alias.
- **API routes** must set `export const runtime = 'nodejs'` and
  `export const dynamic = 'force-dynamic'`, and `await` the `params` Promise (Next 15).
- **State transitions** for issues live in `src/lib/store.ts` / `src/lib/develop.ts`. An issue
  in `pr` state must never be re-developed (`canDevelop` enforces `backlog`/`blocked` only).
- Keep secrets in `.env` (gitignored); never commit tokens or `.env`.

## Tests

- `npm test` runs `vitest run`. The suite uses per-run temp SQLite files in `os.tmpdir()` and
  mocks `undici` for the opencode client — no network required.
- Add unit tests next to the code they cover (`*.test.ts`).

## Branching

- The default branch is `master`.
- Keep commits focused; the existing style is imperative subject lines
  (`feat:`, `fix:`, `docs:`, …).

## Live verification

Autonomous PR creation depends on two unverified items (opencode auto-approve, and
`WORKSPACE_ROOT` visibility on `code.lehel.xyz`). Confirm those before relying on the
end-to-end develop flow; the rest (ingest, board, SSE) works without opencode.
