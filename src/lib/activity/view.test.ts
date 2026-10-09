import { describe, expect, it } from 'vitest';
import type { ActivitySession } from './types';
import {
  contextPct,
  elapsed,
  formatTokens,
  harnessLabel,
  sortFleet,
  statusLabel,
  sumCost,
  summarizeFleet,
} from './view';

function s(over: Partial<ActivitySession>): ActivitySession {
  return {
    source: 'opencode-web',
    sessionId: 's',
    harness: 'opencode',
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
});
