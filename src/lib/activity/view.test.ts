import { describe, expect, it } from 'vitest';
import type { ActivitySession } from './types';
import {
  contextPct,
  elapsed,
  formatDuration,
  formatTokens,
  harnessLabel,
  isPlaceholderTitle,
  isEmptySession,
  laneWindow,
  sessionLabel,
  sortFleet,
  statusLabel,
  sumCost,
  summarizeFleet,
  timelineTicks,
  timelineWindowMs,
  visibleFleet,
} from './view';

function s(over: Partial<ActivitySession>): ActivitySession {
  return {
    source: 'opencode-web',
    sessionId: 's',
    harness: 'opencode',
    title: null,
    project: null,
    repo: null,
    branch: null,
    model: null,
    agent: null,
    status: 'idle',
    activity: null,
    startedAt: null,
    updatedAt: 0,
    tokens: {},
    cost: null,
    costKind: 'reported',
    messages: 0,
    toolCalls: 0,
    client: null,
    issueId: null,
    attribution: null,
    lastSeen: '',
    ...over,
  };
}

describe('sortFleet', () => {
  it('pins needs-input first, then working, newest within status', () => {
    const fleet = [
      s({ sessionId: 'idle', status: 'idle', updatedAt: 10 }),
      s({ sessionId: 'work-old', status: 'working', updatedAt: 10 }),
      s({ sessionId: 'work-new', status: 'working', updatedAt: 20 }),
      s({ sessionId: 'blocked', status: 'needs-input', updatedAt: 1 }),
    ];
    expect(sortFleet(fleet).map((x) => x.sessionId)).toEqual(['blocked', 'work-new', 'work-old', 'idle']);
  });
});

describe('summarizeFleet', () => {
  it('counts statuses, harnesses, and clients', () => {
    const summary = summarizeFleet([
      s({ status: 'working', harness: 'opencode', client: 'devhub' }),
      s({ status: 'needs-input', harness: 'claude', client: 'claude-local' }),
      s({ status: 'working', harness: 'opencode', client: 'devhub' }),
    ]);
    expect(summary).toMatchObject({ total: 3, working: 2, needsInput: 1, claude: 1, opencode: 2 });
    expect(summary.clients[0]).toEqual({ key: 'devhub', count: 2 });
  });
});

describe('small formatters', () => {
  it('formats tokens', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(25000)).toBe('25k');
    expect(formatTokens(2_400_000)).toBe('2.4M');
  });

  it('computes context percentage with a guard', () => {
    expect(contextPct(s({ tokens: { contextUsed: 50, contextLimit: 100 } }))).toBe(50);
    expect(contextPct(s({ tokens: { contextUsed: 50 } }))).toBeNull();
    expect(contextPct(s({}))).toBeNull();
  });

  it('formats elapsed', () => {
    expect(elapsed(0, 5000)).toBe('5s');
    expect(elapsed(0, 5 * 60 * 1000)).toBe('5m');
    expect(elapsed(0, 90 * 60 * 1000)).toBe('1h30m');
    expect(elapsed(0, 2 * 60 * 60 * 1000)).toBe('2h');
    expect(elapsed(null, 1000)).toBeNull();
  });

  it('labels harnesses by source', () => {
    expect(harnessLabel(s({ source: 'opencode-web' }))).toBe('opencode-web');
    expect(harnessLabel(s({ source: 'laptop', harness: 'claude' }))).toBe('claude-local');
    expect(harnessLabel(s({ source: 'laptop', harness: 'opencode' }))).toBe('opencode-local');
  });

  it('humanizes needs-input', () => {
    expect(statusLabel('needs-input')).toBe('needs input');
    expect(statusLabel('working')).toBe('working');
  });

  it('sums reported and estimated cost separately', () => {
    const total = sumCost([
      { key: 'a', sessions: 1, tokens: 1, costReported: 0.5, costEstimated: 0 },
      { key: 'b', sessions: 1, tokens: 1, costReported: 0, costEstimated: 0.25 },
    ]);
    expect(total).toEqual({ reported: 0.5, estimated: 0.25 });
  });

  it('formats durations', () => {
    expect(formatDuration(5000)).toBe('5s');
    expect(formatDuration(5 * 60 * 1000)).toBe('5m');
    expect(formatDuration(90 * 60 * 1000)).toBe('1h30m');
    expect(formatDuration(-1)).toBe('0s');
  });
});

describe('placeholder/empty filtering', () => {
  it('detects opencode default titles', () => {
    expect(isPlaceholderTitle('New session - 2026-10-09T19:52:10.660Z')).toBe(true);
    expect(isPlaceholderTitle('Child session - 2026-10-09T19:52:10.660Z')).toBe(true);
    expect(isPlaceholderTitle('Real work')).toBe(false);
    expect(isPlaceholderTitle(null)).toBe(false);
  });

  it('treats tokenless, messageless, activity-less sessions as empty', () => {
    expect(isEmptySession(s({}))).toBe(true);
    expect(isEmptySession(s({ tokens: { input: 5 } }))).toBe(false);
    expect(isEmptySession(s({ messages: 1 }))).toBe(false);
    expect(isEmptySession(s({ activity: 'edit x' }))).toBe(false);
  });

  it('visibleFleet drops placeholder and empty, keeps the rest', () => {
    const fleet = [
      s({ sessionId: 'placeholder', title: 'New session - 2026-10-09T19:52:10.660Z' }),
      s({ sessionId: 'empty', title: 'Real title' }),
      s({ sessionId: 'real', title: 'Do the thing', tokens: { input: 10 } }),
    ];
    expect(visibleFleet(fleet).map((x) => x.sessionId)).toEqual(['real']);
  });

  it('labels by title then repo/project', () => {
    expect(sessionLabel(s({ title: 'Do the thing' }))).toBe('Do the thing');
    expect(sessionLabel(s({ title: 'New session - 2026-10-09T19:52:10.660Z', repo: 'a/b' }))).toBe('a/b');
    expect(sessionLabel(s({ project: '/p' }))).toBe('/p');
  });
});

describe('laneWindow', () => {
  const HOUR = 60 * 60 * 1000;
  const end = 10 * HOUR;
  const start = end - HOUR;

  it('clips a session that starts before the window', () => {
    const g = laneWindow(s({ startedAt: start - HOUR / 2, updatedAt: start + HOUR / 2 }), start, end, end);
    expect(g).not.toBeNull();
    expect(g!.outOfWindow).toBe(false);
    expect(g!.clippedLeft).toBe(true);
    expect(g!.x0).toBe(0);
    expect(g!.x1).toBeCloseTo(0.5);
    expect(g!.runtimeMs).toBe(HOUR);
  });

  it('pins a session that ended before the window', () => {
    const g = laneWindow(s({ startedAt: start - 3 * HOUR, updatedAt: start - HOUR }), start, end, end);
    expect(g!.outOfWindow).toBe(true);
    expect(g!.runtimeMs).toBe(2 * HOUR);
  });

  it('extends a working session to now', () => {
    const g = laneWindow(s({ startedAt: start, updatedAt: start + HOUR / 4, status: 'working' }), start, end, end);
    expect(g!.x0).toBe(0);
    expect(g!.x1).toBeCloseTo(1);
    expect(g!.runtimeMs).toBe(HOUR);
  });

  it('returns null without any timing', () => {
    expect(laneWindow(s({ startedAt: null, updatedAt: null }), start, end, end)).toBeNull();
  });
});

describe('timeline window + ticks', () => {
  it('resolves window lengths', () => {
    expect(timelineWindowMs('1h')).toBe(60 * 60 * 1000);
    expect(timelineWindowMs('24h')).toBe(24 * 60 * 60 * 1000);
  });

  it('emits clock steps across the window', () => {
    const start = 30 * 60 * 1000;
    const end = start + 6 * 60 * 60 * 1000;
    const ticks = timelineTicks(start, end, 4);
    expect(ticks.map((t) => t.at)).toEqual([2 * 3600e3, 4 * 3600e3, 6 * 3600e3]);
  });
});
