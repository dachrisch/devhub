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

// Returns a Response for GitHub URLs, or null to pass through to real fetch.
function handleGithub(url) {
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
    const repo = `${m[1]}/${m[2]}`;
    return mockJsonResponse(MOCK_ISSUES.map((i) => ghIssue(repo, i.number)));
  }

  m = issueRe.exec(path);
  if (m) {
    if (url.method === 'PATCH') return mockJsonResponse({});
    return mockJsonResponse({ labels: [] });
  }

  m = pullsRe.exec(path);
  if (m) return mockJsonResponse({ merged: false, merge_commit_sha: null });

  if (path.endsWith('/comments')) return mockJsonResponse({});
  if (path.endsWith('/tags')) return mockJsonResponse([]);
  if (path.includes('/compare/')) return mockJsonResponse({ status: 'ahead' });

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
      return handleGithub(url);
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
