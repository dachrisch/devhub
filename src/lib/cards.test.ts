import { describe, expect, it } from 'vitest';
import type { Issue, IssueState, Thread, ThreadState } from './types';
import { cardForIssue, cardForThread, cardRank } from './cards';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 1,
    githubIssueId: 100,
    owner: 'dachrisch',
    repo: 'servyy-container',
    number: 118,
    title: "Ofelia scheduler doesn't run on codey",
    body: null,
    htmlUrl: 'https://github.com/dachrisch/servyy-container/issues/118',
    state: 'refinement' as IssueState,
    sessionId: null,
    resultPrUrl: null,
    resultText: null,
    blockedReason: null,
    linkedPrUrl: null,
    releaseTag: null,
    releasedAt: null,
    stateReason: null,
    modelId: null,
    source: 'github',
    createdAt: '2026-10-08 22:00:00',
    updatedAt: '2026-10-08 22:00:00',
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 7,
    kind: 'work',
    issueIds: [1],
    title: 'Implement dachrisch/servyy-container#118',
    state: 'refining' as ThreadState,
    sessionId: null,
    summary: null,
    createdAt: '2026-10-08 22:00:00',
    updatedAt: '2026-10-08 22:00:00',
    ...overrides,
  };
}

describe('cardForThread', () => {
  it('uses the linked issue title, not the raw command', () => {
    const card = cardForThread(makeThread(), [makeIssue()]);
    expect(card.title).toBe("Ofelia scheduler doesn't run on codey");
  });

  it('falls back to the thread title when no issue is linked yet', () => {
    const card = cardForThread(makeThread({ issueIds: [] }), []);
    expect(card.title).toBe('Implement dachrisch/servyy-container#118');
  });

  it('keeps the command title for strategy threads', () => {
    const thread = makeThread({ kind: 'strategy', state: 'planning', title: 'combined strategy for XY and warehouse' });
    const card = cardForThread(thread, [makeIssue()]);
    expect(card.title).toBe('combined strategy for XY and warehouse');
  });

  it('derives the status from the linked issue for work threads', () => {
    const card = cardForThread(makeThread(), [makeIssue({ state: 'developing' })]);
    expect(card.statusKey).toBe('developing');
    expect(card.working).toBe(true);
  });

  it('marks a blocked work thread as not working', () => {
    const card = cardForThread(makeThread(), [makeIssue({ state: 'developing', blockedReason: 'need input' })]);
    expect(card.working).toBe(false);
    expect(card.blockedReason).toBe('need input');
  });

  it('never marks a strategy thread as working (no live-run marker)', () => {
    const thread = makeThread({ kind: 'strategy', state: 'planning' });
    expect(cardForThread(thread, [makeIssue({ state: 'developing' })]).working).toBe(false);
  });
});

describe('cardForIssue', () => {
  it('uses the issue title', () => {
    expect(cardForIssue(makeIssue()).title).toBe("Ofelia scheduler doesn't run on codey");
  });

  it('does not call an idle refinement card working', () => {
    expect(cardForIssue(makeIssue({ state: 'refinement' })).working).toBe(false);
  });

  it('is working for a develop run in flight but not backlog/pr/blocked', () => {
    expect(cardForIssue(makeIssue({ state: 'developing' })).working).toBe(true);
    expect(cardForIssue(makeIssue({ state: 'backlog' })).working).toBe(false);
    expect(cardForIssue(makeIssue({ state: 'pr' })).working).toBe(false);
    expect(cardForIssue(makeIssue({ state: 'developing', blockedReason: 'stuck' })).working).toBe(false);
  });

  it('is working while the server reports a live refinement run', () => {
    const idle = cardForIssue(makeIssue({ state: 'refinement' }));
    const live = cardForIssue(makeIssue({ state: 'refinement' }), {}, new Set([1]));
    expect(idle.working).toBe(false);
    expect(live.working).toBe(true);
  });

  it('does not trust a live set when the card is blocked', () => {
    const card = cardForIssue(makeIssue({ state: 'refinement', blockedReason: 'need input' }), {}, new Set([1]));
    expect(card.working).toBe(false);
  });
});

describe('queue positions', () => {
  it('shows queued and live positions on issue cards', () => {
    expect(cardForIssue(makeIssue(), { 1: 3 }).queuePosition).toBe(3);
    expect(cardForIssue(makeIssue(), { 1: 'live' }).queuePosition).toBe('live');
    expect(cardForIssue(makeIssue()).queuePosition).toBeNull();
  });

  it('surfaces the queue position of a linked issue on a thread card', () => {
    expect(cardForThread(makeThread(), [makeIssue()], { 1: 'live' }).queuePosition).toBe('live');
    expect(cardForThread(makeThread(), [makeIssue()]).queuePosition).toBeNull();
  });
});

describe('cardRank', () => {
  it('puts needs-input first, then live runs, then the rest by stage', () => {
    const blocked = cardForIssue(makeIssue({ state: 'developing', blockedReason: 'stuck' }));
    const working = cardForIssue(makeIssue({ state: 'developing' }));
    const ready = cardForIssue(makeIssue({ state: 'pr' }));
    const backlog = cardForIssue(makeIssue({ state: 'backlog' }));
    expect(cardRank(blocked)).toBeLessThan(cardRank(working));
    expect(cardRank(working)).toBeLessThan(cardRank(ready));
    expect(cardRank(ready)).toBeLessThan(cardRank(backlog));
  });
});
