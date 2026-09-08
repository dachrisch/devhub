// Dev-only preload hook: mocks GitHub (api.github.com + github.com) by
// patching globalThis.fetch inside the Next dev server. Loaded via
// `NODE_OPTIONS="--require <this-file>"` from scripts/dev/start-dev.mjs.
// Never use outside local development.
'use strict';

const MOCK_USER = { login: 'octocat', avatar_url: null };
const MOCK_ORGS = [{ login: 'bumbleflies' }];
const MOCK_REPO_TOPICS = ['gh-dash', 'dachrisch', 'bumbleflies'];

// Generic issues served for every mocked repo. Mirrors scripts/dev/seed.mjs so
// that a refresh() reconciles instead of duplicating.
const MOCK_ISSUES = [
  { number: 101, title: 'Polish board card hover states' },
  { number: 102, title: 'Add keyboard shortcut cheat sheet' },
  { number: 103, title: 'Cache model list for 5 minutes' },
  { number: 104, title: 'Improve SSE reconnect backoff' },
  { number: 105, title: 'Trim log noise in develop runs' },
  { number: 106, title: 'Support repo filter on mobile search' },
];

function ghIssue(repo, num) {
  const meta = MOCK_ISSUES.find((i) => i.number === num);
  return {
    id: 900000 + num,
    number: num,
    title: meta?.title ?? `Mock issue #${num}`,
    body: 'Generic mock issue body for local development.',
    html_url: `https://github.com/${repo}/issues/${num}`,
    user: { login: 'octocat', type: 'User' },
  };
}

function mockJsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/vnd.github+json' },
  });
}

// Merge/tag steering for the Realize e2e (devhub#171 Phase 3): the sweep
// observes PR-merged + release-tag state, so the e2e drives it via
//   POST /__mock/github  { merged: [{owner, repo, number, sha}], tags: [{owner, repo, name, sha}] }
// served by a tiny control plane (see bottom of file). Defaults preserve the
// long-standing behavior: nothing merged, no tags.
//
// Next dev loads this hook in more than one process, so steering is
// file-backed (every read reloads) — in-memory Maps alone would split state
// between the control-plane process and the API-route process.
// process.getBuiltinModule keeps this require-free (the repo lints .cjs too).
const { readFileSync, writeFileSync } = process.getBuiltinModule('node:fs');
const os = process.getBuiltinModule('node:os');
const path = process.getBuiltinModule('node:path');

const STATE_FILE =
  process.env.MOCK_GITHUB_STATE_FILE || path.join(os.tmpdir(), 'devhub-mock-github-state.json');

const ghState = {
  /** `${owner}/${repo}#${number}` -> merge_commit_sha */
  merged: new Map(),
  /** `${owner}/${repo}` -> [{ name, sha }] */
  tags: new Map(),
};

function reloadState() {
  try {
    const raw = readFileSync(STATE_FILE, 'utf8');
    const body = JSON.parse(raw || '{}');
    applySteering(body);
  } catch {
    // no state file yet (or unreadable): keep in-memory defaults
  }
}

function persistState() {
  try {
    writeFileSync(
      STATE_FILE,
      JSON.stringify({
        merged: [...ghState.merged.entries()].map(([key, sha]) => ({ key, sha })),
        tags: [...ghState.tags.entries()].map(([key, tags]) => ({ key, tags })),
      })
    );
  } catch {
    // best-effort only
  }
}

function applySteering(body) {
  ghState.merged.clear();
  ghState.tags.clear();
  for (const p of body.merged ?? []) {
    if (p.key && p.sha) {
      ghState.merged.set(p.key, p.sha);
    } else if (p.owner && p.repo && Number.isInteger(p.number)) {
      ghState.merged.set(prKey(p.owner, p.repo, String(p.number)), typeof p.sha === 'string' && p.sha ? p.sha : 'mockmerge0');
    }
  }
  for (const t of body.tags ?? []) {
    if (t.key && Array.isArray(t.tags)) {
      ghState.tags.set(t.key, t.tags);
    } else if (t.owner && t.repo && t.name) {
      const k = repoKey(t.owner, t.repo);
      if (!ghState.tags.has(k)) ghState.tags.set(k, []);
      ghState.tags.get(k).push({ name: t.name, sha: typeof t.sha === 'string' && t.sha ? t.sha : 'mockmerge0' });
    }
  }
}

function repoKey(owner, repo) {
  return `${owner}/${repo}`;
}

function prKey(owner, repo, number) {
  return `${owner}/${repo}#${number}`;
}

// Returns a Response for GitHub URLs, or null to pass through to real fetch.
function handleGithub(url, method) {
  reloadState();
  const path = url.pathname.replace(/\/+$/, '');
  const issueRe = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/;
  const repoIssuesRe = /^\/repos\/([^/]+)\/([^/]+)\/issues$/;
  const pullsRe = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/;

  if (url.host === 'github.com') {
    if (path === '/login/oauth/access_token') {
      return mockJsonResponse({ access_token: 'mock-token', scope: 'repo read:org' });
    }
    return mockJsonResponse({}, 200);
  }

  switch (path) {
    case '/user':
      return mockJsonResponse(MOCK_USER);
    case '/user/orgs':
      return mockJsonResponse(MOCK_ORGS);
    case '/user/repos': {
      const repos = ['dachrisch/devhub', 'bumbleflies/warehouse', 'bumbleflies/atlas'].map((full) => ({
        name: full.split('/')[1],
        full_name: full,
        owner: { login: full.split('/')[0] },
        topics: MOCK_REPO_TOPICS,
      }));
      return mockJsonResponse(repos);
    }
    case '/search/issues':
      return mockJsonResponse({ items: [] });
    case '/user/issues':
      return mockJsonResponse([]);
    default:
      break;
  }

  let   m = repoIssuesRe.exec(path);
  if (m) {
    // Promote-topic flow (devhub#167): filing the GitHub issue for a
    // promoted topic returns a synthetic issue number + URL.
    if (method === 'POST') {
      const num = 900 + Math.floor(Math.random() * 90);
      return mockJsonResponse({
        id: 999000 + num,
        number: num,
        html_url: `https://github.com/${m[1]}/${m[2]}/issues/${num}`,
      });
    }
    const repo = `${m[1]}/${m[2]}`;
    return mockJsonResponse(MOCK_ISSUES.map((i) => ghIssue(repo, i.number)));
  }

  m = issueRe.exec(path);
  if (m) {
    if (method === 'PATCH') return mockJsonResponse({});
    return mockJsonResponse({ labels: [] });
  }

  m = pullsRe.exec(path);
  if (m) {
    const sha = ghState.merged.get(prKey(m[1], m[2], m[3]));
    if (sha) return mockJsonResponse({ merged: true, merge_commit_sha: sha });
    return mockJsonResponse({ merged: false, merge_commit_sha: null });
  }

  if (path.endsWith('/comments')) return mockJsonResponse({});
  const tagsRe = /^\/repos\/([^/]+)\/([^/]+)\/tags$/;
  const tm = tagsRe.exec(path);
  if (tm) {
    const tags = ghState.tags.get(repoKey(tm[1], tm[2])) ?? [];
    return mockJsonResponse(tags.map((t) => ({ name: t.name, commit: { sha: t.sha } })));
  }
  if (path.includes('/compare/')) {
    // `owner/repo/compare/base...head`: identical shas are trivially
    // contained; anything else keeps the legacy "ahead" answer.
    const cm = /\/compare\/([^.]+)\.\.\.(.+)$/.exec(path);
    if (cm && cm[1] === cm[2]) return mockJsonResponse({ status: 'identical' });
    return mockJsonResponse({ status: 'ahead' });
  }

  // Unknown GitHub endpoint: 200 empty so optional best-effort calls succeed.
  return mockJsonResponse({});
}

const realFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : null;
let passthrough = realFetch;

async function patchedFetch(input, init) {
  let url;
  try {
    url = input instanceof Request ? new URL(input.url) : new URL(String(input));
  } catch {
    url = null;
  }
  if (url && (url.host === 'api.github.com' || url.host === 'github.com')) {
    if (process.env.DEVHUB_MOCK_GITHUB !== '0') {
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET') ?? 'GET').toUpperCase();
      return handleGithub(url, method);
    }
  }
  if (!passthrough) {
    passthrough = realFetch || (await import('undici')).fetch;
  }
  return passthrough(input, init);
}

if (process.env.DEVHUB_MOCK_GITHUB !== '0') {
  globalThis.fetch = patchedFetch;
  console.log('[mock-github] GitHub API mocked (api.github.com, github.com)');
}

// Control plane for merge/tag steering (devhub#171 Phase 3 e2e). The mock
// lives inside the Next server process, so it serves its own tiny HTTP
// endpoint when MOCK_GITHUB_CONTROL_PORT is set (wired by start-dev.mjs).
if (process.env.MOCK_GITHUB_CONTROL_PORT) {
  (async () => {
    const http = await import('node:http');
    const port = Number(process.env.MOCK_GITHUB_CONTROL_PORT);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && url.pathname === '/__mock/github') {
      reloadState();
      return send({
        merged: [...ghState.merged.entries()].map(([k, sha]) => ({ key: k, sha })),
        tags: [...ghState.tags.entries()].map(([k, tags]) => ({ key: k, tags })),
      });
    }
    if (req.method === 'POST' && url.pathname === '/__mock/github') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try {
          const body = JSON.parse(raw || '{}');
          applySteering(body);
          persistState();
          send({ ok: true });
        } catch {
          send({ error: 'invalid JSON' }, 400);
        }
      });
      return;
    }
    send({ error: 'not found' }, 404);
  });
  server.on('error', (err) => {
    // Next dev can load this hook in more than one worker: the first one
    // serves the control plane, the rest just patch fetch.
    if (err && err.code === 'EADDRINUSE') {
      console.log(`[mock-github] control plane port ${port} already served, skipping`);
      return;
    }
    console.error('[mock-github] control plane failed:', err instanceof Error ? err.message : err);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[mock-github] control plane: http://localhost:${port} (POST /__mock/github to steer merges/tags)`);
  });
  })().catch((err) => {
    console.error('[mock-github] control plane failed:', err instanceof Error ? err.message : err);
  });
}
