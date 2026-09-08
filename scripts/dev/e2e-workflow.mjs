// End-to-end test of the unified Work flow (devhub#132) + Projects & Topics
// cockpit (devhub#167) against a running start-dev.mjs instance (mocked
// GitHub + mocked opencode).
//
// Covers:
//   S1  happy path      backlog → refinement → developing → pr (PR URL shown)
//   S1b auto-refine     refinement rewrites the issue body, then develops
//   S2  needs input     refinement fails → card stays with "Needs input";
//                       after the issue is answerable, Work resumes → pr
//   S3  develop retry   develop fails → card stays developing with reason;
//                       Work retries → pr
//   S4  batch work      "Work on selected" advances two backlog cards → pr
//   S5  topic flow      idea → promote → work → pr (+run timeline) → mark
//                       shipped → rollout → project last-shipped updated
//   S6  shaping loop    idea → 3 options → choose → summary updates → reply →
//                       next options → ready (devhub#171 Phase 2)
//   S7  realize         ready → realize → promote → work → pr → merge+tag →
//                       rollout → shipped → Delivered (devhub#171 Phase 3)
//   S8  auto-merge      realize → worker merges green PR + cuts tag → rollout
//                       → shipped, no steering (devhub#171 Phase 4)
//   guard               no `blocked` column exists anywhere on the board
//
// The flat board is gone (devhub#167): S1-S4 drive the per-project boards at
// /projects/<id>; S5 additionally touches the projects home (badge/shipped).
//
// Usage:
//   node scripts/dev/start-dev.mjs --port 3111   # separate terminal
//   node scripts/dev/e2e-workflow.mjs --url http://localhost:3111
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

let base = arg('--url', 'http://localhost:3000').replace(/\/$/, '');
// Next 16 dev blocks "cross-origin" dev resources for non-localhost hosts,
// which stalls hydration — force localhost (see .opencode/skill/headless-dev).
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
  throw new Error('no chromium binary found (set CHROMIUM_BIN)');
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

// JS snippets evaluated in the page (current markup: .card root,
// .card-strip-repo pill, .card-strip-number, button.card-primary "Work").
const JS = {
  cardInfo: (ownerRepo, number) => `(() => {
    const cards = [...document.querySelectorAll('.card')];
    const card = cards.find((c) => {
      const pill = c.querySelector('.card-strip-repo')?.innerText ?? '';
      const num = [...c.querySelectorAll('.card-strip-number')].some((n) => n.textContent.trim() === '#${number}');
      return pill.includes('${ownerRepo}') && num;
    });
    if (!card) return null;
    return {
      text: card.innerText,
      inColumn: card.closest('section')?.querySelector('.column-head')?.innerText?.split('\\n')[0]?.trim().toLowerCase() ?? null,
      hasWork: [...card.querySelectorAll('button.card-primary')].some((b) => b.textContent.trim() === 'Work'),
      hasBlockedBanner: !!card.querySelector('.card-blocked'),
    };
  })()`,
  clickWork: (ownerRepo, number) => `(() => {
    const cards = [...document.querySelectorAll('.card')];
    const card = cards.find((c) => {
      const pill = c.querySelector('.card-strip-repo')?.innerText ?? '';
      const num = [...c.querySelectorAll('.card-strip-number')].some((n) => n.textContent.trim() === '#${number}');
      return pill.includes('${ownerRepo}') && num;
    });
    if (!card) return false;
    const btn = [...card.querySelectorAll('button.card-primary')].find((b) => b.textContent.trim() === 'Work');
    if (!btn) return false;
    btn.click();
    return true;
  })()`,
  clickStartWork: `(() => {
    const modal = document.querySelector('.modal');
    if (!modal) return false;
    const btn = [...modal.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Start work');
    if (!btn) return false;
    btn.click();
    return true;
  })()`,
  clickCheckbox: (ownerRepo, number) => `(() => {
    const cb = document.querySelector('input[aria-label="Select issue ${ownerRepo} #${number} for batch actions"]');
    if (!cb) return false;
    if (!cb.checked) cb.click();
    return true;
  })()`,
  clickWorkOnSelected: `(() => {
    const btn = [...document.querySelectorAll('.batch-actions button')].find((b) => b.textContent.startsWith('Work on selected'));
    if (!btn) return false;
    btn.click();
    return true;
  })()`,
  columnHeads: `[...document.querySelectorAll('.column-head')].map((h) => h.innerText.split('\\n')[0].trim())`,
};

async function waitForDom(cdp, sessionId, expression, label, timeoutMs = 15000, predicate) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(cdp, sessionId, expression);
    // Default: wait for any non-null value. With a predicate (e.g. the card
    // must sit in the expected column), keep polling until it holds — the
    // first non-null render can still lag the SSE state change.
    if (last && (!predicate || predicate(last))) return last;
    await wait(400);
  }
  throw new Error(`timeout waiting for DOM: ${label} (last=${JSON.stringify(last)})`);
}

async function clickWorkAndStart(cdp, sessionId, ownerRepo, number, label) {
  const clicked = await waitForDom(cdp, sessionId, JS.clickWork(ownerRepo, number), `Work button on ${label}`);
  if (!clicked) throw new Error(`Work button not clickable on ${label}`);
  await waitForDom(cdp, sessionId, JS.clickStartWork, `Start work button for ${label}`);
  await wait(500); // modal close + POST
}

async function screenshot(cdp, sessionId, name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const file = path.join(shotDir, `${name}.png`);
  await writeFile(file, Buffer.from(shot.data, 'base64'));
  console.log(`  📸 ${path.resolve(file)}`);
}

async function main() {
  mkdirSync(shotDir, { recursive: true });

  // 0. Server sanity + fresh mock scenario.
  const me = await api('/api/auth/me');
  assert(me.user?.login === 'octocat', `signed in as ${me.user?.login}`);
  await setScenario({ refine: 'ready', develop: 'pr' });
  const seeded = findIssue(await allIssues(), 'dachrisch', 'devhub', 105);
  assert(seeded?.state === 'developing' && seeded?.blockedReason, 'retry fixture (devhub#105) seeded: developing + blocked_reason');

  // Launch Chromium over CDP (no driver deps; see headless-check.mjs).
  const bin = findChromium();
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const profile = mkdtempSync(path.join(tmpdir(), 'devhub-e2e-chrome-'));
  const chrome = spawn(bin, [
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

  try {
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
    const cdp = new Cdp(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Network.setCookie', { name: 'devhub_session', value: session, url: base }, sessionId);

    // Resolve the per-project boards (migration auto-creates skeleton
    // projects from the seeded repos on server startup).
    const projects = (await api('/api/projects')).projects;
    const findProject = (owner, repo) =>
      projects.find((p) => p.project?.serviceRepoOwner === owner && p.project?.serviceRepoName === repo)?.project
      ?? projects.find((p) => p.project?.name === repo)?.project;
    const devhubProject = findProject('dachrisch', 'devhub');
    const warehouseProject = findProject('bumbleflies', 'warehouse');
    assert(devhubProject?.id, `devhub project resolved (got ${JSON.stringify(projects.map((p) => p.project?.name))})`);
    assert(warehouseProject?.id, `warehouse project resolved`);
    const devhubBoard = `${base}/projects/${devhubProject.id}`;
    const warehouseBoard = `${base}/projects/${warehouseProject.id}`;

    async function gotoBoard(url, label) {
      const loaded = cdp.waitForEvent('Page.loadEventFired');
      await cdp.send('Page.navigate', { url }, sessionId);
      await loaded;
      await wait(7000); // hydration + /api/issues + topics + SSE
      const bodyText = await evaluate(cdp, sessionId, 'document.body.innerText.slice(0,120)');
      assert(!/sign in/i.test(bodyText ?? ''), `${label}: no login wall`);
    }

    await gotoBoard(devhubBoard, 'devhub board');

    const guardHeads = async (label) => {
      const heads = await evaluate(cdp, sessionId, JS.columnHeads);
      assert(
        Array.isArray(heads) && heads.length > 0 && heads.every((h) => !/blocked/i.test(h)),
        `${label}: board columns are ${JSON.stringify(heads)} — no blocked column`
      );
    };
    await guardHeads('startup');

    // ── S1: happy path ────────────────────────────────────────────────────
    console.log('\nS1: backlog → refinement → developing → pr');
    await clickWorkAndStart(cdp, sessionId, 'dachrisch/devhub', 101, 'devhub#101');
    const s1 = await waitForIssueState('dachrisch', 'devhub', 101, (i) => i.state === 'pr' && i.resultPrUrl, 'to reach pr');
    assert(s1.resultPrUrl.includes('/pull/'), `devhub#101 reached pr with ${s1.resultPrUrl}`);
    const s1dom = await waitForDom(
      cdp, sessionId, JS.cardInfo('dachrisch/devhub', 101), 'devhub#101 card re-render',
      15000, (d) => d.inColumn === 'pr'
    );
    assert(s1dom.inColumn === 'pr', 'devhub#101 card sits in the pr column');
    assert(s1dom.text.includes(s1.resultPrUrl), 'pr card shows the PR URL');
    await guardHeads('S1');
    await screenshot(cdp, sessionId, 's1-happy-path');

    // ── S1b: auto-refine writes the improved body back ────────────────────
    console.log('\nS1b: refinement auto-refines the issue body, then develops');
    await setScenario({ refine: 'improve', develop: 'pr' });
    await clickWorkAndStart(cdp, sessionId, 'dachrisch/devhub', 103, 'devhub#103');
    const s1b = await waitForIssueState('dachrisch', 'devhub', 103, (i) => i.state === 'pr', 'to reach pr');
    assert(
      (s1b.body ?? '').includes('Mock-refined body'),
      'improvedBody was persisted to the DevHub row (develop prompt used the refined body)'
    );
    await screenshot(cdp, sessionId, 's1b-auto-refine');

    // ── S2: needs input → resume ──────────────────────────────────────────
    console.log('\nS2: refinement blocks with questions, then resumes');
    await setScenario({ refine: 'blocked' });
    await clickWorkAndStart(cdp, sessionId, 'dachrisch/devhub', 102, 'devhub#102');
    const s2a = await waitForIssueState('dachrisch', 'devhub', 102, (i) => i.state === 'refinement' && Boolean(i.blockedReason), 'to need input');
    assert(s2a.blockedReason.includes('SQLite or Postgres'), 'blocked_reason carries the blocking questions');
    const bannerText = await waitForDom(
      cdp,
      sessionId,
      `(() => {
        const c = [...document.querySelectorAll('.card')].find((c) =>
          c.querySelector('.card-blocked') &&
          [...c.querySelectorAll('.card-strip-number')].some((n) => n.textContent.trim() === '#102'));
        return c ? c.querySelector('.card-blocked').innerText : null;
      })()`,
      'Needs input banner'
    );
    assert(String(bannerText).includes('Needs input'), 'card shows the "Needs input" banner');
    assert((await evaluate(cdp, sessionId, JS.cardInfo('dachrisch/devhub', 102))).inColumn === 'refinement', 'card stayed in refinement');

    await setScenario({ refine: 'ready' });
    await clickWorkAndStart(cdp, sessionId, 'dachrisch/devhub', 102, 'devhub#102 (resume)');
    const s2b = await waitForIssueState('dachrisch', 'devhub', 102, (i) => i.state === 'pr', 'to resume to pr');
    assert(s2b.state === 'pr' && !s2b.blockedReason, 'devhub#102 resumed all the way to pr with no reason left');
    await screenshot(cdp, sessionId, 's2-needs-input-resumed');

    // ── S3: develop failure → retry from developing ───────────────────────
    console.log('\nS3: develop failure keeps the card in developing, Work retries');
    await gotoBoard(warehouseBoard, 'warehouse board');
    await setScenario({ develop: 'cannot' });
    await clickWorkAndStart(cdp, sessionId, 'bumbleflies/warehouse', 101, 'warehouse#101');
    const s3a = await waitForIssueState('bumbleflies', 'warehouse', 101, (i) => i.state === 'developing' && Boolean(i.blockedReason), 'to fail back into developing');
    assert(s3a.blockedReason.includes('simulated develop failure'), 'blocked_reason carries the develop failure');
    const s3domA = await evaluate(cdp, sessionId, JS.cardInfo('bumbleflies/warehouse', 101));
    assert(s3domA.inColumn === 'developing', 'card stayed in the developing column');
    assert(s3domA.hasBlockedBanner && s3domA.hasWork, 'failed developing card shows Needs input and a Work button');

    await setScenario({ develop: 'pr' });
    await clickWorkAndStart(cdp, sessionId, 'bumbleflies/warehouse', 101, 'warehouse#101 (retry)');
    const s3b = await waitForIssueState('bumbleflies', 'warehouse', 101, (i) => i.state === 'pr', 'to reach pr after retry');
    assert(s3b.state === 'pr', 'retry took warehouse#101 to pr');
    await screenshot(cdp, sessionId, 's3-develop-retry');

    // ── S4: batch work on selected ────────────────────────────────────────
    console.log('\nS4: batch "Work on selected" runs the flow for each card');
    await setScenario({ refine: 'ready', develop: 'pr' });
    for (const n of [102, 103]) {
      const ok = await evaluate(cdp, sessionId, JS.clickCheckbox('bumbleflies/warehouse', n));
      if (!ok) throw new Error(`checkbox not found for warehouse#${n}`);
    }
    await waitForDom(cdp, sessionId, JS.clickWorkOnSelected, 'Work on selected button');
    await wait(500);
    for (const n of [102, 103]) {
      const done = await waitForIssueState('bumbleflies', 'warehouse', n, (i) => i.state === 'pr', 'batch → pr');
      assert(done.state === 'pr', `warehouse#${n} reached pr via batch work`);
    }
    await screenshot(cdp, sessionId, 's4-batch-work');

    // ── S5: topic flow (devhub#167) ─────────────────────────────────────
    // idea → promote → work → pr (+run timeline) → mark shipped → rollout →
    // project last-shipped updated.
    console.log('\nS5: idea → promote → work → mark shipped → rollout');
    await setScenario({ refine: 'ready', develop: 'pr' });
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

    await gotoBoard(devhubBoard, 'devhub board (S5)');
    const s5dom = await waitForDom(
      cdp, sessionId, JS.cardInfo('dachrisch/devhub', promotedIssue.number), 'promoted card re-render',
      15000, (d) => d.inColumn === 'pr'
    );
    assert(s5dom.inColumn === 'pr', 'promoted card sits in the pr column');
    assert(s5dom.text.includes('●pr'), 'pr card shows the per-run PR chip');

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
    await screenshot(cdp, sessionId, 's5-topic-flow');

    // ── S6: shaping loop (devhub#171 Phase 2) ─────────────────────────────
    // create idea → 3 options → choose → summary updates → reply → ready.
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

    await gotoBoard(`${base}/topics/${shapingId}`, 'idea page (S6)');
    const s6dom = await waitForDom(
      cdp, sessionId, 'document.body.innerText', 'idea page thread render',
      15000, (t) => typeof t === 'string' && t.includes(picked.title) && t.includes('Ready')
    );
    assert(s6dom.includes('Choose') || s6dom.includes('Chosen'), 'idea page shows the options thread');
    await screenshot(cdp, sessionId, 's6-shaping-loop');

    // ── S7: one-click Realize (devhub#171 Phase 3) ─────────────────────────
    // ready → realize (202) → promote → work → pr → mock merge+tag → sweep →
    // rollout → topic shipped → idea page shows Delivered. Auto-merge is
    // toggled OFF first so the PR waits stably for the external merge (this
    // also covers the per-project opt-out); S8 covers the worker path.
    console.log('\nS7: realize → pr → merge+tag → rollout → Delivered');
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

    // Drive the merge + release tag through the mock-github control plane,
    // then refresh so the sweep observes them immediately (the realize waiter
    // also sweeps on its own cadence).
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

    await gotoBoard(`${base}/topics/${realizeId}`, 'idea page (S7)');
    const s7dom = await waitForDom(
      cdp, sessionId, 'document.body.innerText', 'idea page Delivered render',
      15000, (t) => typeof t === 'string' && t.includes('Delivered')
    );
    assert(s7dom.includes('Delivered'), 'idea page shows Delivered without opening kanban');
    await screenshot(cdp, sessionId, 's7-realize');

    const autoOn = await api(`/api/projects/${devhubProject.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoMerge: true }),
    });
    assert(autoOn.project?.autoMerge !== false, 'auto-merge restored for S8');

    // ── S8: auto-merge when green (devhub#171 Phase 4) ─────────────────────
    // Same chain, but NO steering: the worker merges the green PR and cuts
    // the release tag itself, the sweep observes both, topic ships.
    console.log('\nS8: realize → worker merge+tag → rollout → Delivered');
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
    // The worker can merge + release within one poll gap, so pr may never be
    // observable — accept pr or straight-to-rollout here.
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
    await gotoBoard(`${base}/topics/${autoId}`, 'idea page (S8)');
    const s8dom = await waitForDom(
      cdp, sessionId, 'document.body.innerText', 'idea page Delivered render',
      15000, (t) => typeof t === 'string' && t.includes('Delivered')
    );
    assert(s8dom.includes('Delivered'), 'idea page shows Delivered after worker merge');
    await screenshot(cdp, sessionId, 's8-auto-merge');

    cdp.close();
    console.log('\n────────────────────────────────────────────');
    console.log('E2E PASS — unified Work flow + Projects & Topics cockpit behave as designed');
    console.log('────────────────────────────────────────────');
  } finally {
    chrome.kill('SIGTERM');
    await wait(300);
  }
}

main().catch((err) => {
  console.error('\nE2E FAIL:', err.message);
  process.exit(1);
});
