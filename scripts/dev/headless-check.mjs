// Verifies DevHub dev server works headlessly: launches Chromium with CDP,
// injects the dev session cookie, loads the board, asserts mock issues render,
// and captures a screenshot. No OAuth, no real GitHub.
// Usage: node scripts/dev/headless-check.mjs [--url http://127.0.0.1:3000] [--screenshot out.png]
'use strict';

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEV_SESSION_ID } from './seed.mjs';

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

let base = arg('--url', 'http://localhost:3000').replace(/\/$/, '');
// Next 16 dev blocks "cross-origin" dev resources (the HMR websocket) for
// non-localhost hosts, which stalls hydration — force localhost.
base = new URL(Object.assign(new URL(base), { hostname: 'localhost' })).toString().replace(/\/$/, '');
const session = arg('--session', DEV_SESSION_ID);
const screenshotPath = arg('--screenshot', '.devhub-dev-board.png');
const lookFor = arg('--expect', 'Polish board card hover states');

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
        if (msg.error) {
          reject(new Error(msg.error.message));
        } else {
          resolve(msg.result);
        }
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
  on(fn) {
    this.listeners.push(fn);
  }
  waitForEvent(method, timeoutMs = 15000) {
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

async function serverChecks() {
  const cookie = `devhub_session=${session}`;
  const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
  const meBody = await me.json();
  if (!me.ok || meBody.user?.login !== 'octocat') {
    throw new Error(`/api/auth/me failed: ${me.status} ${JSON.stringify(meBody)}`);
  }
  const issues = await fetch(`${base}/api/issues`, { headers: { cookie } });
  const issuesBody = await issues.json();
  if (!issues.ok || !Array.isArray(issuesBody.issues) || issuesBody.issues.length === 0) {
    throw new Error(`/api/issues failed: ${issues.status} ${JSON.stringify(issuesBody).slice(0, 200)}`);
  }
  return { user: meBody.user.login, issueCount: issuesBody.issues.length };
}

async function main() {
  console.log(`[headless-check] server checks against ${base}`);
  const { user, issueCount } = await serverChecks();
  console.log(`[headless-check] ok: user=${user}, issues=${issueCount}`);
  const bin = findChromium();
  const profile = mkdtempSync(path.join(tmpdir(), 'devhub-chrome-'));
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

    const loaded = cdp.waitForEvent('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: base }, sessionId);
    await loaded;
    // let the client hydrate and pull /api/auth/me + /api/issues + SSE
    await wait(6000);

    const evalRes = await cdp.send(
      'Runtime.evaluate',
      { expression: 'document.body.innerText', returnByValue: true },
      sessionId
    );
    const text = evalRes.result.value ?? '';

    const pass =
      text.includes(user) && text.includes(lookFor) && !/sign in/i.test(text);
    console.log(`[headless-check] board text contains user "${user}": ${text.includes(user)}`);
    console.log(`[headless-check] board text contains "${lookFor}": ${text.includes(lookFor)}`);
    console.log(`[headless-check] no login wall: ${!/sign in/i.test(text)}`);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(screenshotPath, Buffer.from(shot.data, 'base64'));
    console.log(`[headless-check] screenshot: ${path.resolve(screenshotPath)}`);

    cdp.close();
    if (!pass) {
      console.error('[headless-check] FAIL — board did not render as expected. Text was:\n' + text.slice(0, 800));
      process.exitCode = 1;
    } else {
      console.log('[headless-check] PASS');
    }
  } finally {
    chrome.kill('SIGTERM');
    await wait(300).then(() => rm(profile, { recursive: true, force: true }));
  }
}

main().catch((err) => {
  console.error('[headless-check] FAIL:', err.message);
  process.exit(1);
});
