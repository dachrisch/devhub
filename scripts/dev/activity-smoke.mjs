// Agent Activity smoke test (devhub#270) against a running start-dev.mjs
// instance. Exercises the ingest → fleet → attribution contract at the API
// level: token auth, idempotent latest-wins merge, and member-gated query.
//
// Usage:
//   node scripts/dev/start-dev.mjs --port 3111   # separate terminal
//   node scripts/dev/activity-smoke.mjs --url http://localhost:3111
'use strict';

import { DEV_SESSION_ID } from './seed.mjs';

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const base = arg('--url', 'http://localhost:3000').replace(/\/$/, '');
const token = process.env.ACTIVITY_INGEST_TOKEN ?? 'dev-activity-token';
const COOKIE = `devhub_session=${DEV_SESSION_ID}`;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function ingest(headers, body) {
  return fetch(`${base}/api/activity/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function main() {
  console.log(`Activity smoke → ${base}`);

  const now = Date.now();
  const batch = {
    source: 'laptop',
    sentAt: now,
    sessions: [
      {
        harness: 'opencode',
        sessionId: 'smoke-1',
        project: '/tmp/smoke',
        status: 'working',
        model: 'smoke/model',
        activity: 'edit file',
        updatedAt: now,
        tokens: { input: 10, output: 2 },
        cost: 0.01,
        costKind: 'reported',
      },
    ],
    events: [{ sessionId: 'smoke-1', ts: now, type: 'tool', tool: 'edit' }],
  };

  const noToken = await ingest({}, batch);
  check('ingest rejects without token (401)', noToken.status === 401, `got ${noToken.status}`);

  const badToken = await ingest({ 'x-activity-token': 'wrong' }, batch);
  check('ingest rejects a bad token (401)', badToken.status === 401, `got ${badToken.status}`);

  const ok = await ingest({ 'x-activity-token': token }, batch);
  check('ingest accepts a valid batch (202)', ok.status === 202, `got ${ok.status}`);

  const noSession = await fetch(`${base}/api/activity`);
  check('GET /api/activity requires a session (401)', noSession.status === 401, `got ${noSession.status}`);

  const res = await fetch(`${base}/api/activity`, { headers: { cookie: COOKIE } });
  check('GET /api/activity is member-gated and ok (200)', res.status === 200, `got ${res.status}`);
  const data = await res.json();
  const fleet = Array.isArray(data.fleet) ? data.fleet : [];
  const mine = fleet.find((s) => s.source === 'laptop' && s.sessionId === 'smoke-1');
  check('ingested session appears in the fleet', Boolean(mine));
  check('unattributed session is labelled opencode-local', mine?.client === 'opencode-local', `client=${mine?.client}`);
  check('history shape present', Array.isArray(data.history?.days));

  // Stale replay must not clobber the newer state.
  await ingest(
    { 'x-activity-token': token },
    {
      ...batch,
      sessions: [{ ...batch.sessions[0], status: 'idle', activity: 'stale', updatedAt: now - 10_000 }],
    }
  );
  const after = await (await fetch(`${base}/api/activity`, { headers: { cookie: COOKIE } })).json();
  const still = (after.fleet ?? []).find((s) => s.source === 'laptop' && s.sessionId === 'smoke-1');
  check('stale replay does not clobber newer state', still?.activity === 'edit file', `activity=${still?.activity}`);

  if (failures > 0) {
    console.error(`\nActivity smoke FAILED (${failures})`);
    process.exit(1);
  }
  console.log('\nActivity smoke PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
