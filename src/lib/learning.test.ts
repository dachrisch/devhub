import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDb = path.join(os.tmpdir(), `devhub-learning-test-${process.pid}.db`);
process.env.DEVHUB_DB = tmpDb;

const store = await import('./store.js');
const knowledge = await import('./knowledge.js');
const learning = await import('./learning.js');
const router = await import('./router.js');

afterAll(() => {
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    try {
      fs.rmSync(f);
    } catch {
      /* ignore */
    }
  }
});

describe('cockpit self-learning', () => {
  it('grounds the router prompt with past corrections', () => {
    knowledge.remember(
      'router-correction',
      'Correction: "create github issue" -> "create github issue in dontforget" (fix)',
      { originalInput: 'create github issue', correctedInput: 'create github issue in dontforget', action: 'fix' },
      1
    );
    const learnings = learning.getRouterLearnings('create github issue in dontforget repo');
    expect(learnings).toContain('Past corrections');
    const prompt = router.buildRouterPrompt('create github issue in dontforget repo');
    expect(prompt).toContain('Past corrections');
    expect(prompt).toContain('User input: create github issue');
  });

  it('leaves the prompt ungrounded when nothing was learned', () => {
    const prompt = router.buildRouterPrompt('zzqqxx totally novel request 98765');
    expect(prompt).toContain('User input: zzqqxx');
    expect(prompt).not.toContain('Past corrections');
  });

  it('clusters repeated unknown failures into a skill proposal', () => {
    const a1 = store.appendAction('create new github issue in dontforget repo', 'pending', {});
    store.setActionStatus(a1.id, 'failed', 'Not sure what you mean. Could you rephrase?');
    const a2 = store.appendAction('create github issue in dontforget: styled recap', 'pending', {});
    store.setActionStatus(a2.id, 'failed', 'Not sure what you mean. Could you rephrase?');
    store.setActionIntent(a1.id, 'unknown', null, { task: 'create_github_issue' });
    store.setActionIntent(a2.id, 'unknown', null, { task: 'create_github_issue' });

    const clusters = learning.clusterUnknowns(50);
    const match = clusters.find((c) => c.key === 'create_github_issue');
    expect(match).toBeDefined();
    expect(match!.count).toBeGreaterThanOrEqual(2);
    expect(match!.suggestedSkill).toBe('create-github-issue');
  });

  it('learns teach-by-rerun corrections', () => {
    const original = store.appendAction('create issue', 'pending', {});
    store.setActionStatus(original.id, 'failed', 'Not sure what you mean. Could you rephrase?');
    const retry = store.appendAction('create github issue in dontforget with title X', 'pending', { retryOf: original.id });
    learning.learnCorrection(retry.id, original.id, 'create github issue in dontforget with title X', 'fix', {});
    const hits = knowledge.recall('create issue', 'router-correction', 5);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('persists classified intent on the action row', () => {
    const a = store.appendAction('launch a blog api', 'pending', {});
    store.setActionIntent(a.id, 'launch', 'launch', { name: 'blog-api' });
    const row = store.getAction(a.id)!;
    expect(row.action).toBe('launch');
    expect(row.skillId).toBe('launch');
    expect(JSON.parse(row.params).name).toBe('blog-api');
  });
});
