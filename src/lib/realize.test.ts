import { describe, expect, it } from 'vitest';
import { canRealize, realizeStage, shouldResumeOnReply } from './realize';
import type { Issue, Topic } from './types';

function topic(status: Topic['status']): Topic {
  return {
    id: 1,
    projectId: 1,
    area: null,
    title: 'Test idea',
    notes: null,
    shapedSummary: null,
    status,
    mergedIntoTopicId: null,
    readyAt: null,
    origin: 'manual',
    createdAt: 'now',
    updatedAt: 'now',
  };
}

function issue(state: Issue['state'], blockedReason: string | null = null): Issue {
  return {
    id: 1,
    githubIssueId: 1,
    owner: 'dachrisch',
    repo: 'devhub',
    number: 1,
    title: 'Test',
    body: null,
    htmlUrl: 'https://github.com/dachrisch/devhub/issues/1',
    state,
    sessionId: null,
    resultPrUrl: null,
    resultText: null,
    blockedReason,
    linkedPrUrl: null,
    releaseTag: null,
    releasedAt: null,
    stateReason: null,
    modelId: null,
    projectId: 1,
    topicId: 1,
    repoScope: null,
    infraFirst: false,
    createdAt: 'now',
    updatedAt: 'now',
  };
}

describe('realizeStage (devhub#171 Phase 3)', () => {
  it('maps hidden execution state to plain words', () => {
    expect(realizeStage('shipped', [])).toBe('delivered');
    expect(realizeStage('realizing', [issue('rollout')])).toBe('delivered');
    expect(realizeStage('realizing', [issue('developing', 'Which auth?')])).toBe('needs-input');
    expect(realizeStage('realizing', [issue('pr')])).toBe('checking');
    expect(realizeStage('realizing', [issue('developing')])).toBe('building');
    expect(realizeStage('realizing', [issue('backlog')])).toBe('understanding');
    expect(realizeStage('realizing', [issue('refinement')])).toBe('understanding');
    expect(realizeStage('new', [])).toBe('understanding');
  });
});

describe('canRealize guards (devhub#171 Phase 3)', () => {
  it('rejects archived and delivered ideas', () => {
    expect(canRealize(topic('dropped'), [], false)).toEqual({ ok: false, error: 'idea is archived', status: 400 });
    expect(canRealize(topic('shipped'), [], false)).toEqual({ ok: false, error: 'idea is already delivered', status: 400 });
  });

  it('rejects a second run while one is live', () => {
    const d = canRealize(topic('realizing'), [issue('backlog')], true);
    expect(d).toEqual({ ok: false, error: 'realization already running', status: 409 });
  });

  it('starts fresh ideas and retries blocked work', () => {
    expect(canRealize(topic('new'), [], false)).toEqual({ ok: true, action: 'full' });
    expect(canRealize(topic('ready'), [issue('backlog')], false)).toEqual({ ok: true, action: 'full' });
    // Auto-promote race: a ready idea with no linked issue yet still goes full
    // (realizeTopic promotes first, then works the fresh backlog issue).
    expect(canRealize(topic('ready'), [], false)).toEqual({ ok: true, action: 'full' });
    expect(canRealize(topic('realizing'), [issue('developing', 'Needs input')], false)).toEqual({ ok: true, action: 'full' });
  });

  it('waits (no new chain) on live developing/pr work', () => {
    expect(canRealize(topic('realizing'), [issue('developing')], false)).toEqual({ ok: true, action: 'wait-only' });
    expect(canRealize(topic('realizing'), [issue('pr')], false)).toEqual({ ok: true, action: 'wait-only' });
    expect(canRealize(topic('ready'), [issue('pr')], false)).toEqual({ ok: true, action: 'wait-only' });
  });

  it('reports done when every linked issue settled', () => {
    expect(canRealize(topic('realizing'), [issue('rollout')], false)).toEqual({ ok: true, action: 'done' });
    expect(canRealize(topic('ready'), [issue('rollout'), issue('closed')], false)).toEqual({ ok: true, action: 'done' });
  });
});

describe('shouldResumeOnReply (needs-input reply spec)', () => {
  const blocked = [{ blockedReason: 'Which auth?' }];
  const clear = [{ blockedReason: null }];
  it('resumes a blocked realization when no loop is live', () => {
    expect(shouldResumeOnReply('realizing', blocked, false)).toBe(true);
  });
  it('never resumes finished topics', () => {
    expect(shouldResumeOnReply('dropped', blocked, false)).toBe(false);
    expect(shouldResumeOnReply('shipped', blocked, false)).toBe(false);
  });
  it('never resumes shaping topics (replies shape, they do not resume)', () => {
    expect(shouldResumeOnReply('new', blocked, false)).toBe(false);
    expect(shouldResumeOnReply('shaping', blocked, false)).toBe(false);
    expect(shouldResumeOnReply('ready', blocked, false)).toBe(false);
  });
  it('never resumes an unblocked or already-live realization', () => {
    expect(shouldResumeOnReply('realizing', clear, false)).toBe(false);
    expect(shouldResumeOnReply('realizing', [], false)).toBe(false);
    expect(shouldResumeOnReply('realizing', blocked, true)).toBe(false);
  });
});
