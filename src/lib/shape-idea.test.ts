import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDb = path.join(os.tmpdir(), `devhub-shape-test-${process.pid}.db`);
process.env.DEVHUB_DB = tmpDb;

const fakeFetch = vi.fn();

vi.mock('undici', () => {
  class Agent {}
  return {
    Agent,
    fetch: (...args: unknown[]) => fakeFetch(...args),
  };
});

const store = await import('./store.js');
const { buildShapePrompt, parseShapeResult, runShapingRound } = await import('./shape-idea.js');

afterAll(() => {
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    try {
      fs.rmSync(f);
    } catch {
      /* ignore */
    }
  }
});

function jsonRes(body: unknown, ok = true) {
  const text = JSON.stringify(body);
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => text };
}

function emptyStreamRes() {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  return { ok: true, body: stream };
}

const SHAPE_JSON = JSON.stringify({
  summary: 'Shaped: sync highlights across devices.',
  options: [
    { id: 'opt-1', title: 'Lightweight', desc: 'Sync on save.', tradeoff: 'No offline.' },
    { id: 'opt-2', title: 'Realtime', desc: 'Push over socket.', tradeoff: 'More parts.' },
    { id: 'opt-3', title: 'Manual', desc: 'User triggers sync.', tradeoff: 'Forgettable.' },
  ],
  question: 'Which direction fits best?',
});

function mockShapeFetch(text: string) {
  fakeFetch.mockReset();
  fakeFetch.mockImplementation(async (url: string, opts: { method?: string }) => {
    if (String(url).includes('/api/model')) {
      return jsonRes({ data: [{ id: 'mock-model', providerID: 'opencode' }] });
    }
    if (opts?.method === 'POST' && String(url).endsWith('/api/session')) {
      return jsonRes({ data: { id: 'ses_shape_1' } });
    }
    if (String(url).includes('/prompt')) {
      return jsonRes({ data: { id: 'msg_shape_1' } });
    }
    if (String(url).includes('/event')) {
      return emptyStreamRes();
    }
    if (String(url).includes('/message')) {
      return jsonRes({
        data: [{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text }] }],
      });
    }
    return jsonRes({}, false);
  });
}

describe('shape-idea (devhub#171 Phase 2)', () => {
  it('parses a valid shape result with options', () => {
    const result = parseShapeResult(SHAPE_JSON);
    expect(result.summary).toContain('Shaped:');
    expect(result.options).toHaveLength(3);
    expect(result.options[0]).toEqual({ id: 'opt-1', title: 'Lightweight', desc: 'Sync on save.', tradeoff: 'No offline.' });
    expect(result.question).toBe('Which direction fits best?');
  });

  it('parses fenced JSON and generates ids when missing', () => {
    const fenced = '```json\n{"summary": "s", "options": [{"title": "A", "desc": "d"}], "question": "q?"}\n```';
    const result = parseShapeResult(fenced);
    expect(result.options).toHaveLength(1);
    expect(result.options[0].id).toBe('opt-1');
  });

  it('rejects output without a summary or without options', () => {
    expect(() => parseShapeResult('{"summary": "", "options": [{"title": "A"}]}')).toThrow(/summary/);
    expect(() => parseShapeResult('{"summary": "s", "options": []}')).toThrow(/options/);
    expect(() => parseShapeResult('not json at all')).toThrow();
    expect(() => parseShapeResult('{"summary": "s", "options": [{"desc": "no title"}]}')).toThrow(/title/);
  });

  it('builds a prompt with project config, open issues and the thread', () => {
    const project = store.createProject({ name: 'shape-proj', config: { stack: 'node' } });
    const topic = store.createTopic({ title: 'Sync it', projectId: project.id });
    store.appendIdeaMessage(topic.id, 'user', 'my idea is sync');
    const prompt = buildShapePrompt(store.getTopic(topic.id)!, store.getIdeaMessages(topic.id));
    expect(prompt).toContain('You are shaping an idea');
    expect(prompt).toContain('Sync it');
    expect(prompt).toContain('"stack":"node"');
    expect(prompt).toContain('USER: my idea is sync');
  });

  it('runs a shaping round: new→shaping, summary + 3 options land', async () => {
    mockShapeFetch(SHAPE_JSON);
    const topic = store.createTopic({ title: 'Shape me' });
    expect(topic.status).toBe('new');
    const assistant = await runShapingRound(topic.id);
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.options).toHaveLength(3);
    const updated = store.getTopic(topic.id)!;
    expect(updated.status).toBe('shaping');
    expect(updated.shapedSummary).toContain('Shaped:');
    const thread = store.getIdeaMessages(topic.id);
    expect(thread.map((m) => m.role)).toEqual(['assistant']);
  });

  it('skips topics that already left the shaping funnel', async () => {
    mockShapeFetch(SHAPE_JSON);
    const topic = store.createTopic({ title: 'Locked' });
    store.updateTopic(topic.id, { status: 'realizing' });
    fakeFetch.mockClear();
    expect(await runShapingRound(topic.id)).toBeNull();
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('lands a retryable assistant message when the model output is unusable', async () => {
    mockShapeFetch('CANNOT FULFILL: simulated shaping failure');
    const topic = store.createTopic({ title: 'Flaky shape' });
    const assistant = await runShapingRound(topic.id);
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.options).toBeNull();
    expect(assistant?.body).toContain("reply below and I'll try again");
    expect(store.getTopic(topic.id)?.status).toBe('shaping');
  });
});
