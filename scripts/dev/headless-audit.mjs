// Headless layout audit for DevHub — the regression net for the desktop/mobile
// audit in devhub#248. Unlike headless-check.mjs (a smoke test that the board
// renders), this drives real interactions and asserts the specific layout
// invariants the audit found broken:
//
//   F1  Start-work modal overlay fills the viewport (not clipped to a column)
//   F2  Topic reply composer: Send hugs the input instead of stranding
//   F3  Cockpit action strips stay inside a phone viewport
//   F4  Home project/idea titles clamp instead of hard-truncating
//
// Usage:
//   node scripts/dev/start-dev.mjs --port 3111
//   node scripts/dev/headless-audit.mjs --url http://localhost:3111 \
//     [--out .devhub-audit] [--session dev-headless-session-0001]
//
// Exits non-zero when any assertion fails. Screenshots land in --out.
'use strict';

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEV_SESSION_ID } from './seed.mjs';

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

let base = arg('--url', 'http://localhost:3000').replace(/\/$/, '');
// Next 16 dev blocks cross-origin dev resources for non-localhost hosts (see
// the headless-dev skill) — force localhost so hydration runs.
base = new URL(Object.assign(new URL(base), { hostname: 'localhost' })).toString().replace(/\/$/, '');
const session = arg('--session', DEV_SESSION_ID);
const outDir = path.resolve(arg('--out', '.devhub-audit'));

// Desktop audit viewports from the issue; 1280×800 included as a laptop case.
const DESKTOP = { width: 1440, height: 900, mobile: false };
const LAPTOP = { width: 1280, height: 800, mobile: false };
const PHONE = { width: 390, height: 844, mobile: true };

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  close() {
    this.ws.close();
  }
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? 'ok  ' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function evaluate(cdp, sid, expression) {
  const res = await cdp.send(
    'Runtime.evaluate',
    { expression: `(() => { ${expression} })()`, returnByValue: true, awaitPromise: true },
    sid
  );
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails));
  }
  return res.result.value;
}

async function screenshot(cdp, sid, name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  const file = path.join(outDir, `${name}.png`);
  await writeFile(file, Buffer.from(shot.data, 'base64'));
  return file;
}

// Create a Cockpit action so the home page renders the action strip (F3) with
// real content. The mocked opencode answers instantly, so one item suffices.
async function seedAction(cdp, sid) {
  await evaluate(
    cdp,
    sid,
    `return fetch('/api/action', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ input: 'audit: verify action strip width' }),
     }).then((r) => r.ok);`
  );
}

// Create a shaping topic and return its id so the reply composer (F2) mounts.
async function seedTopic(cdp, sid) {
  const id = await evaluate(
    cdp,
    sid,
    `return fetch('/api/topics', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ title: 'audit: composer layout', projectId: 1 }),
     }).then((r) => r.json()).then((d) => d.topic?.id ?? null);`
  );
  return id;
}

async function load(cdp, sid, url, viewport, settle = 5500) {
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile },
    sid
  );
  const loaded = new Promise((resolve) => {
    const l = (msg) => {
      if (msg.method === 'Page.loadEventFired') {
        cdp.listeners = cdp.listeners.filter((x) => x !== l);
        resolve();
      }
    };
    cdp.listeners.push(l);
  });
  await cdp.send('Page.navigate', { url }, sid);
  await loaded;
  await wait(settle);
}

const MODAL_ASSERT = `
  const vw = innerWidth, vh = innerHeight;
  const overlay = document.querySelector('.modal-overlay');
  if (!overlay) return { ok: false, reason: 'modal overlay not rendered' };
  const o = overlay.getBoundingClientRect();
  const modalEl = document.querySelector('.modal');
  const m = modalEl ? modalEl.getBoundingClientRect() : null;
  const near = (a, b) => Math.abs(a - b) <= 2;
  const fills = near(o.left, 0) && near(o.top, 0) && o.width >= vw - 2 && o.height >= vh - 2;
  const modalInside = !!m && m.left >= -1 && m.top >= -1 && m.right <= vw + 1 && m.bottom <= vh + 1;
  return {
    ok: fills && modalInside,
    vw, vh,
    overlay: { left: o.left, top: o.top, width: o.width, height: o.height },
    modal: m ? { left: m.left, top: m.top, right: m.right, bottom: m.bottom } : null,
  };
`;

const SHEET_ASSERT = `
  const vw = innerWidth, vh = innerHeight;
  const backdrop = document.querySelector('.card-sheet-backdrop');
  if (!backdrop) return { ok: false, reason: 'actions sheet not rendered' };
  const b = backdrop.getBoundingClientRect();
  const sheet = document.querySelector('.card-sheet');
  const s = sheet ? sheet.getBoundingClientRect() : null;
  const fills = Math.abs(b.left) <= 1 && Math.abs(b.top) <= 1 && b.width >= vw - 2 && b.height >= vh - 2;
  const sheetInside = !!s && s.left >= -1 && s.right <= vw + 1 && s.bottom <= vh + 1;
  return { ok: fills && sheetInside, vw, vh, backdrop: { width: b.width, height: b.height }, sheet: s && { left: s.left, right: s.right, bottom: s.bottom } };
`;

const COMPOSER_ASSERT = `
  const reply = document.querySelector('.topic-reply');
  if (!reply) return { ok: false, reason: 'reply composer not rendered' };
  const input = reply.querySelector('.topic-reply-input');
  const send = reply.querySelector('.card-primary');
  if (!input || !send) return { ok: false, reason: 'composer controls missing' };
  const ir = input.getBoundingClientRect();
  const sr = send.getBoundingClientRect();
  const rr = reply.getBoundingClientRect();
  const gap = sr.left - ir.right;
  return {
    ok: gap <= 24 && sr.right <= rr.right + 1 && sr.width <= 160,
    gap,
    sendWidth: sr.width,
    replyWidth: rr.width,
  };
`;

const STRIP_ASSERT = `
  const vw = innerWidth;
  const items = [...document.querySelectorAll('.action-item')];
  if (items.length === 0) return { ok: false, reason: 'no action items rendered' };
  const cap = Math.min(460, vw * 0.72) + 1;
  const oversized = items
    .map((el) => ({ w: el.getBoundingClientRect().width, text: el.textContent || '' }))
    .filter((x) => x.w > cap);
  return { ok: oversized.length === 0, count: items.length, cap, oversized };
`;

const CLAMP_ASSERT = `
  const bad = [];
  for (const el of document.querySelectorAll('.project-card-name, .project-idea-link')) {
    if (el.closest('.project-card-new')) continue;
    if (el.scrollWidth > el.clientWidth + 1) {
      bad.push({ cls: el.className, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
    }
  }
  return { ok: bad.length === 0, bad };
`;

const DELIVERED_ASSERT = `
  const vw = innerWidth;
  const bad = [...document.querySelectorAll('.issue-ref--full')]
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.right > vw + 1)
    .map((r) => ({ left: r.left, right: r.right }));
  return { ok: bad.length === 0, vw, bad };
`;

async function auditBoard(cdp, sid, viewport, label, projectId) {
  console.log(`\n[audit] board /projects/${projectId} @ ${viewport.width}×${viewport.height} (${label})`);
  await load(cdp, sid, `${base}/projects/${projectId}`, viewport);
  if (viewport.mobile) {
    // Mobile renders a single column (defaults to the empty Idea tab); switch
    // to a populated one so the card assertions have content to inspect.
    await evaluate(
      cdp,
      sid,
      `const tab = document.querySelector('[data-column="ready"]')
         ?? document.querySelector('.status-strip-tab[data-column]');
       tab?.click();
       return true;`
    );
    await wait(600);
  }
  await screenshot(cdp, sid, `board-${label}`);

  const cardCount = await evaluate(cdp, sid, `return document.querySelectorAll('.card, .mobile-card').length;`);
  record(`board ${label}: cards render`, cardCount > 0, `${cardCount} cards`);

  // F1: open the first Start-work modal and assert it fills the viewport.
  const clicked = await evaluate(
    cdp,
    sid,
    `const btn = [...document.querySelectorAll('button.card-primary, button.mobile-card-primary')]
       .find((b) => !b.disabled);
     if (!btn) return false;
     btn.click();
     return true;`
  );
  if (!clicked) {
    record(`board ${label}: work modal opens`, false, 'no enabled Work button');
  } else {
    await wait(700);
    const modal = await evaluate(cdp, sid, MODAL_ASSERT);
    record(`board ${label}: F1 modal fills viewport`, modal.ok, JSON.stringify(modal));
    await screenshot(cdp, sid, `board-modal-${label}`);
    // Close (overlay click) and let the page settle.
    await evaluate(cdp, sid, `document.querySelector('.modal-overlay')?.click(); return true;`);
    await wait(300);
  }

  // Mobile-only: the ⋯ button opens the actions bottom sheet, which (like the
  // modal) must escape the card's transformed/overflow-hidden containing block.
  if (viewport.mobile) {
    const opened = await evaluate(
      cdp,
      sid,
      `const btn = document.querySelector('.card-menu-trigger');
       if (!btn) return false;
       btn.click();
       return true;`
    );
    if (!opened) {
      record(`board ${label}: actions sheet opens`, false, 'no ⋯ trigger');
    } else {
      await wait(500);
      const sheet = await evaluate(cdp, sid, SHEET_ASSERT);
      record(`board ${label}: actions sheet fills viewport`, sheet.ok, JSON.stringify(sheet));
      await screenshot(cdp, sid, `board-sheet-${label}`);
      await evaluate(cdp, sid, `document.querySelector('.card-sheet-backdrop')?.click(); return true;`);
      await wait(300);
    }
  }
}

async function auditHome(cdp, sid, viewport, label) {
  console.log(`\n[audit] home / @ ${viewport.width}×${viewport.height} (${label})`);
  await load(cdp, sid, `${base}/`, viewport);
  await seedAction(cdp, sid);
  await wait(1200);
  await screenshot(cdp, sid, `home-${label}`);

  const strip = await evaluate(cdp, sid, STRIP_ASSERT);
  record(`home ${label}: F3 action strip stays in viewport`, strip.ok, JSON.stringify(strip));

  const clamp = await evaluate(cdp, sid, CLAMP_ASSERT);
  record(`home ${label}: F4 card titles clamp`, clamp.ok, JSON.stringify(clamp));

  // Desktop delivered history is a deliberate horizontal scroller (refs past
  // the viewport scroll into view); mobile wraps, so only mobile asserts fit.
  if (viewport.mobile) {
    const delivered = await evaluate(cdp, sid, DELIVERED_ASSERT);
    record(`home ${label}: F3 delivered refs stay in viewport`, delivered.ok, JSON.stringify(delivered));
  }
}

async function auditComposer(cdp, sid, viewport, label) {
  const topicId = await seedTopic(cdp, sid);
  if (!topicId) {
    record(`composer ${label}: topic created`, false, 'POST /api/topics returned no id');
    return;
  }
  console.log(`\n[audit] topic /topics/${topicId} @ ${viewport.width}×${viewport.height} (${label})`);
  await load(cdp, sid, `${base}/topics/${topicId}`, viewport);
  await screenshot(cdp, sid, `topic-${label}`);
  const composer = await evaluate(cdp, sid, COMPOSER_ASSERT);
  record(`composer ${label}: F2 Send hugs input`, composer.ok, JSON.stringify(composer));
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  console.log(`[audit] base=${base} out=${outDir}`);
  const bin = findChromium();
  const profile = mkdtempSync(path.join(tmpdir(), 'devhub-audit-'));
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

    await auditBoard(cdp, sessionId, DESKTOP, 'desktop-1440', 1);
    await auditBoard(cdp, sessionId, LAPTOP, 'desktop-1280', 1);
    await auditBoard(cdp, sessionId, PHONE, 'mobile-390', 1);
    await auditHome(cdp, sessionId, DESKTOP, 'desktop-1440');
    await auditHome(cdp, sessionId, PHONE, 'mobile-390');
    await auditComposer(cdp, sessionId, DESKTOP, 'desktop-1440');
    await auditComposer(cdp, sessionId, PHONE, 'mobile-390');

    cdp.close();
  } finally {
    chrome.kill('SIGTERM');
    await wait(300);
    await rm(profile, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[audit] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error('[audit] FAIL — ' + failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
  console.log('[audit] PASS');
}

main().catch((err) => {
  console.error('[audit] FAIL:', err.message);
  process.exit(1);
});
