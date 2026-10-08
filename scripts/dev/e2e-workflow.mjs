// End-to-end test of the v2 command-first flow + Projects & Topics engine
// against a running start-dev.mjs instance (mocked GitHub + mocked opencode).
//
// Covers (API-level; --api-only runs without chromium):
//   S1  happy path      command "Implement dachrisch/devhub#101" → thread →
//                       refinement → developing → pr (PR URL shown)
//   S1b auto-refine     refinement rewrites the issue body, then develops
//   S2  needs input     refinement fails → card stays with "Needs input";
//                       command resumes → pr
//   S3  develop retry   develop fails → card stays developing with reason;
//                       command retries → pr
//   S4  chips           unknown repo → chips (never a guess); bare #ref →
//                       issue-search chip → hand-select works the card
//   S5  topic flow      idea → promote → work → pr (+run timeline) → mark
//                       shipped → rollout → project last-shipped updated
//   S6  shaping loop    idea → 3 options → choose → summary updates → reply →
//                       next options → ready
//   S7  realize         ready → realize → promote → work → pr → merge+tag →
//                       rollout → shipped
//   S8  auto-merge      realize → worker merges green PR + cuts tag → rollout
//                       → shipped, no steering
//   S9  strategy        command → strategy thread → split proposal → chip
//                       confirm gate (no auto-create) → real issues → serial
//                       queue → pr
//   guard               no `blocked` issue state; batch-advance route is gone;
//                       (DOM mode) no board columns, dock present
//
// Usage:
//   node scripts/dev/start-dev.mjs --port 3111   # separate terminal
//   node scripts/dev/e2e-workflow.mjs --url http://localhost:3111 [--api-only]
'use strict';

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEV_SESSION_ID } from './seed.mjs';

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const API_ONLY = process.argv.includes('--api-only');

let base = arg('--url', 'http://localhost:3000').replace(/\/$/, '');
base = new URL(Object.assign(new URL(base), { hostname: 'localhost' })).toString().replace(/\/$/, '');
const session = arg('--session', DEV_SESSION_ID);
const mockBase = arg('--mock-url', 'http://localhost:3222').replace(/\/$/, '');
const mockGithubBase = arg('--mock-github-url', 'http://localhost:3223').replace(/\/$/, '');
const shotDir = arg('--shots', '.devhub-e2e');

const COOKIE = `devhub_session=${session}`;

function findChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  for (const bin of ['chromium-browser', 'chromium', 'google-chrome', 'google-chrome-stable']) {
    try {
      execFileSync('which', [bin], { stdio: 'pipe' });
      return bin;
    } catch {
      // try next
    }
  }
  throw new Error('no chromium binary found (set CHROMIUM_BIN or pass --api-only)');
}

async function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function api(pathname, init = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...init,
    headers: { cookie: COOKIE, ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${pathname} failed: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function allIssues() {
  return (await api('/api/issues')).issues;
}

function findIssue(issues, owner, repo, number) {
  return issues.find((i) => i.owner === owner && i.repo === repo && i.number === number);
}

async function setScenario(scenario) {
  const res = await fetch(`${mockBase}/__mock/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(scenario),
  });
  if (!res.ok) throw new Error(`scenario update failed: ${res.status}`);
}

async function setGithubScenario(scenario) {
  const res = await fetch(`${mockGithubBase}/__mock/github`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(scenario),
  });
  if (!res.ok) throw new Error(`github scenario update failed: ${res.status}`);
}

// Polls server truth until `predicate` holds for the target issue.
async function waitForIssueState(owner, repo, number, predicate, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = findIssue(await allIssues(), owner, repo, number);
    if (last && predicate(last)) return last;
    await wait(400);
  }
  throw new Error(
    `timeout waiting for ${owner}/${repo}#${number} ${label}; last=${JSON.stringify(last)}`
  );
}

// The v2 command pathway: one POST per bar/mic submission. Returns the thread.
async function command(input, extra = {}) {
  const res = await api('/api/threads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, ...extra }),
  });
  assert(typeof res.threadId === 'number', `command accepted ("${input.slice(0, 50)}…") → thread #${res.threadId}`);
  return res;
}

async function waitForSplit(threadId, count, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await api(`/api/threads/${threadId}`);
    if ((last.splitProposal?.length ?? 0) >= count) return last;
    await wait(500);
  }
  throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last?.splitProposal)}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
  waitForEvent(method, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
      const l = (msg) => {
        if (msg.method === method) {
          clearTimeout(t);
          this.listeners = this.listeners.filter((x) => x !== l);
          resolve(msg.params);
        }
      };
      this.listeners.push(l);
    });
  }
  close() {
    this.ws.close();
  }
}

async function evaluate(cdp, sessionId, expression) {
  const res = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId
  );
  if (res.exceptionDetails) {
    throw new Error(`page eval failed: ${res.exceptionDetails.text} ${JSON.stringify(res.exceptionDetails).slice(0, 300)}`);
  }
  return res.result?.value;
}

// v2 home markup: .v2-card cards, .v2-dock command bar, .card-blocked banner,
// .v2-detail full-screen thread view.
const JS = {
  homeReady: `(() => ({
    dock: !!document.querySelector('.v2-dock'),
    cards: document.querySelectorAll('.v2-card').length,
    columns: document.querySelectorAll('.column-head').length,
  }))()`,
  dockSubmit: (text) => `(() => {
    const input = document.querySelector('.v2-dock-input');
    if (!input) return false;
    input.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, ${JSON.stringify(text)});
    const btn = document.querySelector('.v2-dock-send');
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  })()`,
  detailOpen: `!!document.querySelector('.v2-detail')`,
  needsInputBanner: `(() => {
    const b = document.querySelector('.v2-card .card-blocked');
    return b ? b.innerText : null;
  })()`,
};

async function waitForDom(cdp, sessionId, expression, label, timeoutMs = 15000, predicate) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(cdp, sessionId, expression);
    if (last && (!predicate || predicate(last))) return last;
    await wait(400);
  }
  throw new Error(`timeout waiting for DOM: ${label} (last=${JSON.stringify(last)})`);
}

async function screenshot(cdp, sessionId, name) {
  if (API_ONLY || !cdp) return;
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const file = path.join(shotDir, `${name}.png`);
  await writeFile(file, Buffer.from(shot.data, 'base64'));
  console.log(`  📸 ${path.resolve(file)}`);
}

async function main() {
  mkdirSync(shotDir, { recursive: true });

  const me = await api('/api/auth/me');
  assert(me.user?.login === 'octocat', `signed in as ${me.user?.login}`);
  await setScenario({ refine: 'ready', develop: 'pr' });
  await setGithubScenario({ merged: [], tags: [] });
  const seeded = findIssue(await allIssues(), 'dachrisch', 'devhub', 105);
  assert(seeded?.state === 'developing' && seeded?.blockedReason, 'retry fixture (devhub#105) seeded: developing + blocked_reason');

  // v2 guard: no `blocked` issue state exists; the batch-advance route is gone.
  const states = new Set((await allIssues()).map((i) => i.state));
  assert(!states.has('blocked'), `no blocked issue state (${[...states].join(',')})`);
  const batchRes = await fetch(`${base}/api/issues/batch-advance`, {
    method: 'POST',
    headers: { cookie: COOKIE, 'content-type': 'application/json' },
    body: '{}',
  });
  // Deleted route 404s — or falls through to /api/issues/[id], which has
  // no POST handler (405) and rejects the non-numeric id. Either way the
  // v1 batch endpoint is dead.
  assert(batchRes.status === 404 || batchRes.status === 405, 'batch-advance route is gone (v1 batch mode deleted)');

  // Chromium (DOM mode only) — api-only skips straight to API assertions.
  let cdp = null;
  let domSessionId = null;
  let chrome = null;
  if (!API_ONLY) {
    const bin = findChromium();
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const profile = mkdtempSync(path.join(tmpdir(), 'devhub-e2e-chrome-'));
    chrome = spawn(bin, [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--window-size=1440,900',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ]);
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error('chromium never printed a DevTools endpoint')), 20000);
      chrome.stderr.on('data', (d) => {
        buf += d.toString();
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) {
          clearTimeout(t);
          resolve(m[1]);
        }
      });
      chrome.on('exit', (code) => {
        clearTimeout(t);
        reject(new Error(`chromium exited early (${code})`));
      });
    });
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });
    cdp = new Cdp(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId: domSessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    await cdp.send('Page.enable', {}, domSessionId);
    await cdp.send('Runtime.enable', {}, domSessionId);
    await cdp.send('Network.enable', {}, domSessionId);
    await cdp.send('Network.setCookie', { name: 'devhub_session', value: session, url: base }, domSessionId);

    const loaded = cdp.waitForEvent('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: base }, domSessionId);
    await loaded;
    await wait(7000); // hydration + /api/threads + /api/issues + SSE
    const home = await waitForDom(cdp, domSessionId, JS.homeReady, 'v2 home render');
    assert(home.dock, 'bottom dock present');
    assert(home.cards > 0, `work-item cards render (${home.cards})`);
    assert(home.columns === 0, 'no board columns anywhere');
  }

  try {
    // ── S1: happy path via the command bar ──────────────────────────────
    console.log('\nS1: command → refinement → developing → pr');
    if (cdp) {
      await waitForDom(cdp, domSessionId, JS.dockSubmit('Implement dachrisch/devhub#101'), 'dock submit');
      await waitForDom(cdp, domSessionId, JS.detailOpen, 'thread detail opens', 15000, (v) => v === true);
    } else {
      await command('Implement dachrisch/devhub#101');
    }
    const s1 = await waitForIssueState('dachrisch', 'devhub', 101, (i) => i.state === 'pr' && i.resultPrUrl, 'to reach pr');
    assert(s1.resultPrUrl.includes('/pull/'), `devhub#101 reached pr with ${s1.resultPrUrl}`);
    await screenshot(cdp, domSessionId, 's1-happy-path');

    // ── S1b: auto-refine writes the improved body back ───────────────────
    console.log('\nS1b: refinement auto-refines the issue body, then develops');
    await setScenario({ refine: 'improve', develop: 'pr' });
    await command('Implement dachrisch/devhub#103');
    const s1b = await waitForIssueState('dachrisch', 'devhub', 103, (i) => i.state === 'pr', 'to reach pr');
    assert(
      (s1b.body ?? '').includes('Mock-refined body'),
      'improvedBody was persisted to the DevHub row (develop prompt used the refined body)'
    );
    await screenshot(cdp, domSessionId, 's1b-auto-refine');

    // ── S2: needs input → resume ────────────────────────────────────────
    console.log('\nS2: refinement blocks with questions, then resumes');
    await setScenario({ refine: 'blocked' });
    const s2thread = await command('Work on dachrisch/devhub#102');
    const s2a = await waitForIssueState('dachrisch', 'devhub', 102, (i) => i.state === 'refinement' && Boolean(i.blockedReason), 'to need input');
    assert(s2a.blockedReason.includes('SQLite or Postgres'), 'blocked_reason carries the blocking questions');
    const s2detail = await api(`/api/threads/${s2thread.threadId}`);
    assert(
      (s2detail.issues?.[0]?.blockedReason ?? '').includes('SQLite or Postgres'),
      'thread detail surfaces the Needs input banner'
    );
    if (cdp) {
      const banner = await waitForDom(cdp, domSessionId, JS.needsInputBanner, 'Needs input banner');
      assert(String(banner).includes('Needs input'), 'card shows the "Needs input" banner');
    }

    await setScenario({ refine: 'ready' });
    await command('Work on dachrisch/devhub#102');
    const s2b = await waitForIssueState('dachrisch', 'devhub', 102, (i) => i.state === 'pr', 'to resume to pr');
    assert(s2b.state === 'pr' && !s2b.blockedReason, 'devhub#102 resumed all the way to pr with no reason left');
    await screenshot(cdp, domSessionId, 's2-needs-input-resumed');

    // ── S3: develop failure → retry ─────────────────────────────────────
    console.log('\nS3: develop failure keeps the card in developing, command retries');
    await setScenario({ develop: 'cannot' });
    await command('Implement bumbleflies/warehouse#101');
    const s3a = await waitForIssueState('bumbleflies', 'warehouse', 101, (i) => i.state === 'developing' && Boolean(i.blockedReason), 'to fail back into developing');
    assert(s3a.blockedReason.includes('simulated develop failure'), 'blocked_reason carries the develop failure');

    await setScenario({ develop: 'pr' });
    await command('Implement bumbleflies/warehouse#101');
    const s3b = await waitForIssueState('bumbleflies', 'warehouse', 101, (i) => i.state === 'pr', 'to reach pr after retry');
    assert(s3b.state === 'pr', 'retry took warehouse#101 to pr');
    await screenshot(cdp, domSessionId, 's3-develop-retry');

    // ── S4: chips, never a guess ────────────────────────────────────────
    console.log('\nS4: unknown repo → chips; bare #ref → hand-select');
    const s4chips = await api('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'Implement login in ZZZ' }),
    });
    assert(s4chips.needsChoice && (s4chips.chips?.length ?? 0) > 0, 'unknown repo resolves to chips, not a guess');
    const s4search = await api('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'Implement #103' }),
    });
    assert(
      s4search.needsChoice && s4search.chips?.some((c) => c.kind === 'issue-search'),
      'bare issue ref asks for hand-select'
    );
    await setScenario({ refine: 'ready', develop: 'pr' });
    const handpick = findIssue(await allIssues(), 'bumbleflies', 'warehouse', 103);
    await command('Implement #103', { issueId: handpick.id });
    const s4done = await waitForIssueState('bumbleflies', 'warehouse', 103, (i) => i.state === 'pr', 'hand-selected → pr');
    assert(s4done.state === 'pr', 'hand-selected warehouse#103 reached pr');
    await screenshot(cdp, domSessionId, 's4-chips');

    // ── S5: topic flow (engine API) ─────────────────────────────────────
    console.log('\nS5: idea → promote → work → mark shipped → rollout');
    await setScenario({ refine: 'ready', develop: 'pr' });
    const projects = (await api('/api/projects')).projects;
    const devhubProject = projects.find((p) => p.project?.serviceRepoName === 'devhub')?.project
      ?? projects.find((p) => p.project?.name === 'devhub')?.project;
    assert(devhubProject?.id, 'devhub project resolved');
    const topic = await api('/api/topics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'E2E idea: ship it', projectId: devhubProject.id }),
    });
    assert(topic.topic?.id, 'idea saved as a native topic');
    const promoted = await api(`/api/topics/${topic.topic.id}/promote`, { method: 'POST' });
    assert(promoted.url?.includes('/issues/'), `promoted to a GitHub issue (${promoted.url})`);
    const promotedIssue = promoted.issue;
    assert(promotedIssue.projectId === devhubProject.id, 'promoted issue assigned to the devhub project');
    assert(promotedIssue.topicId === topic.topic.id, 'promoted issue linked to its topic');

    await api(`/api/issues/${promotedIssue.id}/develop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const s5pr = await waitForIssueState(
      'dachrisch', 'devhub', promotedIssue.number, (i) => i.state === 'pr', 'promoted issue → pr'
    );
    assert((s5pr.resultPrUrl ?? '').includes('/pull/'), `promoted issue reached pr (${s5pr.resultPrUrl})`);
    const s5runs = await api(`/api/issues/${promotedIssue.id}/runs`);
    assert(
      Array.isArray(s5runs.runs) && s5runs.runs.length >= 1 && s5runs.runs.every((r) => r.prUrl),
      `run timeline tracks the PR(s): ${JSON.stringify(s5runs.runs.map((r) => `${r.role}:${r.state}`))}`
    );

    await api(`/api/issues/${promotedIssue.id}/mark-shipped`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ releaseTag: 'manual' }),
    });
    const s5done = await waitForIssueState(
      'dachrisch', 'devhub', promotedIssue.number, (i) => i.state === 'rollout', 'promoted issue → rollout'
    );
    assert(s5done.state === 'rollout', 'mark shipped rolled the issue out');
    const s5projects = (await api('/api/projects')).projects;
    const s5devhub = s5projects.find((p) => p.project?.id === devhubProject.id);
    assert(
      s5devhub?.project?.lastShippedTitle === s5done.title,
      `project last-shipped updated ("${s5devhub?.project?.lastShippedTitle}")`
    );
    await screenshot(cdp, domSessionId, 's5-topic-flow');

    // ── S6: shaping loop ────────────────────────────────────────────────
    console.log('\nS6: idea → options → choose → reply → ready');
    await setScenario({ shape: 'options' });
    const shaping = await api('/api/topics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'E2E shaping: sync highlights', projectId: devhubProject.id }),
    });
    const shapingId = shaping.topic?.id;
    assert(shapingId, 'shaping idea created');

    async function waitForOptionRounds(topicId, rounds, label, timeoutMs = 60000) {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        last = (await api(`/api/topics/${topicId}/messages`)).messages;
        const withOptions = (last ?? []).filter((m) => m.role === 'assistant' && (m.options?.length ?? 0) > 0);
        if (withOptions.length >= rounds) return withOptions;
        await wait(500);
      }
      throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)}`);
    }

    const firstRounds = await waitForOptionRounds(shapingId, 1, 'first shaping round');
    assert(firstRounds[0].options.length === 3, `first round offers 3 options (${firstRounds[0].options.map((o) => o.id).join(',')})`);
    const afterShape = (await api(`/api/topics/${shapingId}`)).topic;
    assert(afterShape.status === 'shaping', `topic is shaping (got ${afterShape.status})`);
    assert(afterShape.shapedSummary?.includes('Mock-shaped'), 'shaped summary written ("So far")');

    const picked = firstRounds[0].options[1];
    const chosen = await api(`/api/topics/${shapingId}/choose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: picked.id }),
    });
    assert(chosen.topic?.shapedSummary?.includes(picked.title), `choose rewrites the summary to "${picked.title}"`);
    const threadAfterChoose = (await api(`/api/topics/${shapingId}/messages`)).messages;
    assert(
      threadAfterChoose.find((m) => m.id === firstRounds[0].id)?.chosenOption === picked.id,
      'pick recorded on the options message'
    );

    await api(`/api/topics/${shapingId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'cheaper is better' }),
    });
    const secondRounds = await waitForOptionRounds(shapingId, 2, 'second shaping round');
    assert(secondRounds[1].options.length === 3, 'reply triggers a second options round');

    const ready = await api(`/api/topics/${shapingId}/ready`, { method: 'POST' });
    assert(ready.topic?.status === 'ready' && ready.topic?.readyAt, 'idea marked ready with readyAt');
    await screenshot(cdp, domSessionId, 's6-shaping-loop');

    // ── S7: one-click Realize ───────────────────────────────────────────
    console.log('\nS7: realize → pr → merge+tag → rollout');
    await setScenario({ refine: 'ready', develop: 'pr', shape: 'options' });
    const autoOff = await api(`/api/projects/${devhubProject.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoMerge: false }),
    });
    assert(autoOff.project?.autoMerge === false, 'auto-merge toggled off for S7');
    const realizeTopic = await api('/api/topics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'E2E realize: hands-off lamp', projectId: devhubProject.id }),
    });
    const realizeId = realizeTopic.topic?.id;
    assert(realizeId, 'realize idea created');
    await api(`/api/topics/${realizeId}/ready`, { method: 'POST' });
    const started = await api(`/api/topics/${realizeId}/realize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert(started.mode === 'full', `realize accepted (mode=${started.mode})`);

    async function waitForLinkedIssue(topicId, label, timeoutMs = 60000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = (await allIssues()).find((i) => i.topicId === topicId);
        if (found) return found;
        await wait(500);
      }
      throw new Error(`timeout waiting for linked issue: ${label}`);
    }
    const rIssue = await waitForLinkedIssue(realizeId, 'realize promotes to an issue');
    assert(rIssue.projectId === devhubProject.id, 'realized issue assigned to the devhub project');
    const rPr = await waitForIssueState(
      'dachrisch', 'devhub', rIssue.number, (i) => i.state === 'pr', 'realized issue → pr'
    );
    assert((rPr.resultPrUrl ?? '').includes('/pull/'), `realized issue reached pr (${rPr.resultPrUrl})`);

    await setGithubScenario({
      merged: [{ owner: 'dachrisch', repo: 'devhub', number: 999, sha: 'mockmerge7' }],
      tags: [{ owner: 'dachrisch', repo: 'devhub', name: 'v7.7.7-e2e', sha: 'mockmerge7' }],
    });
    await api('/api/issues', { method: 'POST' });
    const rDone = await waitForIssueState(
      'dachrisch', 'devhub', rIssue.number, (i) => i.state === 'rollout', 'realized issue → rollout'
    );
    assert(rDone.state === 'rollout', 'sweep rolled the realized issue out');
    async function waitForTopicShipped(topicId, label, timeoutMs = 60000) {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        last = (await api(`/api/topics/${topicId}`)).topic;
        if (last?.status === 'shipped') return last;
        await wait(500);
      }
      throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)}`);
    }
    const rShipped = await waitForTopicShipped(realizeId, 'realized topic → shipped');
    assert(rShipped.status === 'shipped', 'realized topic shipped');
    await screenshot(cdp, domSessionId, 's7-realize');

    const autoOn = await api(`/api/projects/${devhubProject.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoMerge: true }),
    });
    assert(autoOn.project?.autoMerge !== false, 'auto-merge restored for S8');

    // ── S8: auto-merge when green ───────────────────────────────────────
    console.log('\nS8: realize → worker merge+tag → rollout');
    await setGithubScenario({ merged: [], tags: [] });
    const autoTopic = await api('/api/topics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'E2E auto-merge: hands-off lamp', projectId: devhubProject.id }),
    });
    const autoId = autoTopic.topic?.id;
    assert(autoId, 'auto-merge idea created');
    await api(`/api/topics/${autoId}/ready`, { method: 'POST' });
    const autoStarted = await api(`/api/topics/${autoId}/realize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert(autoStarted.mode === 'full', `realize accepted (mode=${autoStarted.mode})`);
    const aIssue = await waitForLinkedIssue(autoId, 'auto-merge promotes to an issue');
    await waitForIssueState(
      'dachrisch', 'devhub', aIssue.number, (i) => i.state === 'pr' || i.state === 'rollout', 'auto-merge issue → pr', 60000
    );
    const aDone = await waitForIssueState(
      'dachrisch', 'devhub', aIssue.number, (i) => i.state === 'rollout', 'worker merge+tag → rollout', 150000
    );
    assert(aDone.state === 'rollout', 'worker merged green PR and cut the tag without clicks');
    const ghState = await (await fetch(`${mockGithubBase}/__mock/github`)).json();
    assert(
      (ghState.merged ?? []).some((m) => m.key === 'dachrisch/devhub#999'),
      'mock recorded the worker merge (dachrisch/devhub#999)'
    );
    assert(
      (ghState.tags ?? []).some((t) => t.key === 'dachrisch/devhub' && t.tags.length > 0),
      'mock recorded the worker release tag'
    );
    const aShipped = await waitForTopicShipped(autoId, 'auto-merged topic → shipped');
    assert(aShipped.status === 'shipped', 'auto-merged topic shipped');
    await screenshot(cdp, domSessionId, 's8-auto-merge');

    // ── S9: strategy thread (v2 command-first) ──────────────────────────
    console.log('\nS9: strategy thread → chip gate → confirm → serial queue → pr');
    await setScenario({ planner: 'split', refine: 'ready', develop: 'pr' });
    const beforeCount = (await allIssues()).length;
    const cmd = await api('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: 'look at the recent tickets in dachrisch/devhub and bumbleflies/warehouse and come up with a combined strategy',
      }),
    });
    assert(typeof cmd.threadId === 'number', `strategy thread created (#${cmd.threadId})`);
    const proposed = await waitForSplit(cmd.threadId, 2, 'planner split proposal');
    assert(proposed.thread?.kind === 'strategy', 'thread is a strategy thread');
    assert(
      (await allIssues()).length === beforeCount,
      'chip-confirm gate: planner output created no issues by itself'
    );

    const conf = await api(`/api/threads/${cmd.threadId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accepted: [0, 1] }),
    });
    assert(conf.issueIds?.length === 2, `confirm created 2 cards (${JSON.stringify(conf.issueIds)})`);
    const doneThread = await api(`/api/threads/${cmd.threadId}`);
    assert(doneThread.thread?.state === 'done', 'thread is done after confirm');

    for (const issueId of conf.issueIds) {
      const created = (await allIssues()).find((i) => i.id === issueId);
      assert(created, `confirmed card ${issueId} exists`);
      const terminal = await waitForIssueState(
        created.owner, created.repo, created.number,
        (i) => i.state === 'pr' || i.state === 'rollout', `confirmed card ${issueId} → pr`, 90000
      );
      assert(terminal.state === 'pr' || terminal.state === 'rollout', `card ${issueId} worked (${terminal.state})`);
    }
    await screenshot(cdp, domSessionId, 's9-strategy-thread');

    if (cdp) cdp.close();
    console.log('\n────────────────────────────────────────────');
    console.log('E2E PASS — v2 command-first flow + engine behave as designed');
    console.log(`(mode: ${API_ONLY ? 'api-only' : 'dom + api'})`);
    console.log('────────────────────────────────────────────');
  } finally {
    if (chrome) {
      chrome.kill('SIGTERM');
      await wait(300);
    }
  }
}

main().catch((err) => {
  console.error('\nE2E FAIL:', err.message);
  process.exit(1);
});
