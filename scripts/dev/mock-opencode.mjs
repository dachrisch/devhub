// Dev-only mock of the opencode server (code.lehel.xyz contract) so the full
// Work flow — refinement → develop → pr — can run end-to-end without real
// opencode credentials. Started in-process by start-dev.mjs; the Next child
// gets OPENCODE_BASE_URL pointing here.
//
// Contract mirrored from src/lib/opencode.ts:
//   POST /api/session            -> {"data":{"id":"ses_..."}}
//   POST /api/session/:id/prompt -> ack
//   GET  /api/session/:id/message-> {"data":[assistant message, newest first]}
//   GET  /api/session/:id/event  -> SSE (closes immediately; the /message poll
//                                   is the authoritative completion signal)
//   GET  /api/model              -> {"data":[{id,providerID},...]}
//
// Canned replies are chosen per prompt type ("You are refining" vs "You are
// implementing") from the current scenario, controllable mid-run:
//   POST /__mock/scenario  {"refine":"ready|improve|blocked","develop":"pr|cannot"}
//   GET  /__mock/scenario
'use strict';

import http from 'node:http';

const MODELS = [{ id: 'mock-model', providerID: 'opencode' }];

const REFINE_REPLIES = {
  ready: {
    ready: true,
    summary: 'Clear scope with testable acceptance criteria.',
    improvedBody: null,
    blockingQuestions: [],
  },
  improve: {
    ready: true,
    summary: 'Scope inferred; body rewritten with acceptance criteria.',
    improvedBody: '# Mock-refined body\n\n## Acceptance criteria\n- [x] produced by mock-opencode',
    blockingQuestions: [],
  },
  blocked: {
    ready: false,
    summary: 'Cannot infer the storage backend.',
    improvedBody: null,
    blockingQuestions: ['Use SQLite or Postgres?', 'Which auth flow?'],
  },
};

const DEVELOP_REPLIES = {
  pr: 'Implemented the change, lint and tests pass.\n\nhttps://github.com/dachrisch/devhub/pull/999',
  cannot: 'CANNOT FULFILL: simulated develop failure (mock-opencode)',
};

let scenario = { refine: 'ready', develop: 'pr' };
let sessionCounter = 0;
/** sessionId -> { kind: 'refine'|'develop', text } */
const pending = new Map();

function classify(prompt) {
  if (typeof prompt === 'string' && prompt.includes('You are refining')) return 'refine';
  if (typeof prompt === 'string' && prompt.includes('You are implementing')) return 'develop';
  return 'develop';
}

function json(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

export function startMockOpencode(port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '');

    if (req.method === 'POST' && path === '/__mock/scenario') {
      const body = JSON.parse((await readBody(req)) || '{}');
      scenario = {
        refine: REFINE_REPLIES[body.refine] ? body.refine : scenario.refine,
        develop: DEVELOP_REPLIES[body.develop] ? body.develop : scenario.develop,
      };
      return json(res, { ok: true, scenario });
    }
    if (req.method === 'GET' && path === '/__mock/scenario') {
      return json(res, { scenario });
    }

    if (req.method === 'GET' && (path === '/api/model' || path === '/api/model/list' || path === '/api/config')) {
      return json(res, { data: MODELS });
    }

    if (req.method === 'POST' && path === '/api/session') {
      const id = `ses_mock_${++sessionCounter}`;
      return json(res, { data: { id } });
    }

    let m = /^\/api\/session\/([^/]+)\/prompt$/.exec(path);
    if (req.method === 'POST' && m) {
      let prompt = '';
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        prompt = body?.prompt?.text ?? '';
      } catch {
        /* keep empty */
      }
      const kind = classify(prompt);
      const text =
        kind === 'refine'
          ? JSON.stringify(REFINE_REPLIES[scenario.refine])
          : DEVELOP_REPLIES[scenario.develop];
      pending.set(m[1], { kind, text });
      return json(res, { data: { id: `msg_mock_${m[1]}` } });
    }

    m = /^\/api\/session\/([^/]+)\/message$/.exec(path);
    if (req.method === 'GET' && m) {
      const p = pending.get(m[1]);
      const text = p?.text ?? 'CANNOT FULFILL: mock-opencode had no canned reply';
      return json(res, {
        data: [{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text }] }],
      });
    }

    m = /^\/api\/session\/([^/]+)\/event$/.exec(path);
    if (req.method === 'GET' && m) {
      // Live event stream is best-effort in the real client; closing
      // immediately is a valid stream that simply has no events.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end();
      return;
    }

    // Abort / delete / anything else: ack so best-effort calls succeed.
    return json(res, {});
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
