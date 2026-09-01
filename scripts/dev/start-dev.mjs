// Starts DevHub in fully-mocked local dev mode:
//  - DEVHUB_DB points at a throwaway/generic-data DB (default ./.devhub-dev.db)
//  - GitHub API is mocked in-process via scripts/dev/mock-github.cjs
//  - a fixed dev session is seeded so headless clients can skip OAuth
// Usage: node scripts/dev/start-dev.mjs [--port 3000]
'use strict';

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedDevDb, DEV_SESSION_ID } from './seed.mjs';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(arg('--port', process.env.PORT ?? 3000));
const dbPath = path.resolve(process.env.DEVHUB_DB ?? path.join(repoRoot, '.devhub-dev.db'));
const mockHook = path.join(repoRoot, 'scripts', 'dev', 'mock-github.cjs');

const seed = seedDevDb(dbPath);

const childEnv = {
  ...process.env,
  DEVHUB_DB: dbPath,
  DEVHUB_MOCK_GITHUB: '1',
  NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${mockHook}`].filter(Boolean).join(' '),
};

const nextBin = require.resolve('next/dist/bin/next');
const child = spawn(process.execPath, [nextBin, 'dev', '-p', String(port)], {
  cwd: repoRoot,
  env: childEnv,
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    child.kill(sig);
  });
}

const base = `http://localhost:${port}`;
const deadline = Date.now() + 120_000;
let up = false;
while (Date.now() < deadline) {
  if (child.exitCode !== null) process.exit(child.exitCode);
  try {
    const res = await fetch(`${base}/api/auth/me`);
    if (res.ok) {
      up = true;
      break;
    }
  } catch {
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 500));
}

console.log('');
if (up) {
  console.log('──────────────────────────────────────────────────────────');
  console.log(`DevHub dev server (mocked GitHub): ${base}`);
  console.log(`Session cookie: devhub_session=${DEV_SESSION_ID} (user: octocat)`);
  console.log(`DB: ${dbPath} (seeded ${seed.issues} issues)`);
  console.log(`Headless check: node scripts/dev/headless-check.mjs --url ${base}`);
  console.log('──────────────────────────────────────────────────────────');
} else {
  console.error(`Dev server did not become ready within 120s (base=${base})`);
  child.kill('SIGTERM');
  process.exit(1);
}
