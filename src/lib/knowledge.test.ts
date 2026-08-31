import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDb = path.join(os.tmpdir(), `devhub-knowledge-test-${process.pid}.db`);
process.env.DEVHUB_DB = tmpDb;

const knowledge = await import('./knowledge.js');

afterAll(() => {
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    try {
      fs.rmSync(f);
    } catch {
      /* ignore */
    }
  }
});

describe('knowledge (SQLite FTS5)', () => {
  it('stores entries and lists them back', () => {
    knowledge.remember('fix', 'Fixed issue #1 in web: https://github.com/x/web/pull/1', {
      issueId: 1,
      repo: 'web',
      prUrl: 'https://github.com/x/web/pull/1',
    });
    const all = knowledge.listKnowledge();
    expect(all).toHaveLength(1);
    expect(all[0].domain).toBe('fix');
    expect(all[0].memory).toContain('Fixed issue #1');
    expect(all[0].sourceActionId).toBeNull();
    expect(JSON.parse(all[0].details).repo).toBe('web');
  });

  it('lists newest first', () => {
    knowledge.remember('launch', 'Launched alpha on prod', {});
    knowledge.remember('launch', 'Launched beta on prod', {});
    const list = knowledge.listKnowledge('launch');
    expect(list).toHaveLength(2);
    expect(list[0].memory).toContain('beta');
    expect(list[1].memory).toContain('alpha');
  });

  it('recalls entries by a keyword in the summary', () => {
    const hits = knowledge.recall('beta');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].memory).toContain('beta');
  });

  it('recalls entries by a keyword inside the details JSON', () => {
    knowledge.remember('fix', 'Fixed flaky login', { issueId: 42, owner: 'dachrisch', repo: 'auth' });
    const hits = knowledge.recall('dachrisch');
    expect(hits.some((e) => e.memory.includes('flaky login'))).toBe(true);
  });

  it('filters recall by domain', () => {
    const hits = knowledge.recall('launched', 'launch');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((e) => e.domain === 'launch')).toBe(true);
  });

  it('respects the recall limit', () => {
    for (let i = 0; i < 5; i++) knowledge.remember('fix', `noise entry ${i}`, {});
    const hits = knowledge.recall('noise', undefined, 2);
    expect(hits).toHaveLength(2);
  });

  it('returns bm25 relevance scores on recall', () => {
    const hits = knowledge.recall('flaky');
    expect(hits.length).toBeGreaterThan(0);
    expect(typeof hits[0].score).toBe('number');
  });

  it('survives punctuation-heavy and empty queries', () => {
    knowledge.remember('fix', 'Fixed issue #42 in web', {});
    expect(() => knowledge.recall('issue #42!!')).not.toThrow();
    expect(knowledge.recall('issue #42!!').length).toBeGreaterThan(0);
    expect(() => knowledge.recall('   ')).not.toThrow();
    expect(knowledge.recall('   ')).toEqual([]);
    expect(() => knowledge.recall('?.,;:')).not.toThrow();
    expect(knowledge.recall('?.,;:')).toEqual([]);
  });

  it('filters listKnowledge by domain', () => {
    const fixes = knowledge.listKnowledge('fix');
    expect(fixes.length).toBeGreaterThan(0);
    expect(fixes.every((e) => e.domain === 'fix')).toBe(true);
  });

  it('respects the listKnowledge limit', () => {
    const limited = knowledge.listKnowledge(undefined, 3);
    expect(limited.length).toBeLessThanOrEqual(3);
  });

  it('remember is best-effort and never throws on bad input', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    expect(() => knowledge.remember('fix', 'bad payload', circular)).not.toThrow();
    const hits = knowledge.recall('bad');
    expect(hits.every((e) => e.memory !== 'bad payload')).toBe(true);
  });

  it('captures the source action id when provided', () => {
    knowledge.remember('launch', 'Launched gamma on prod', {}, 77);
    const hits = knowledge.listKnowledge('launch');
    const gamma = hits.find((e) => e.memory.includes('gamma'));
    expect(gamma?.sourceActionId).toBe(77);
  });
});