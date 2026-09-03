import { describe, expect, it } from 'vitest';
import { canDevelop } from './develop.js';
import type { Issue } from './types.js';

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 1,
    githubIssueId: 1,
    owner: 'dachrisch',
    repo: 'devhub',
    number: 1,
    title: 'Test issue',
    body: null,
    htmlUrl: 'https://github.com/dachrisch/devhub/issues/1',
    state: 'backlog',
    sessionId: null,
    resultPrUrl: null,
    resultText: null,
    blockedReason: null,
    linkedPrUrl: null,
    releaseTag: null,
    releasedAt: null,
    stateReason: null,
    modelId: null,
    createdAt: '2026-01-01 00:00:00',
    updatedAt: '2026-01-01 00:00:00',
    ...overrides,
  };
}

describe('canDevelop', () => {
  it('allows backlog and refinement cards', () => {
    expect(canDevelop(issue({ state: 'backlog' }))).toBe(true);
    expect(canDevelop(issue({ state: 'refinement' }))).toBe(true);
  });

  it('allows a failed developing run (needs input) but not a live one', () => {
    expect(canDevelop(issue({ state: 'developing', blockedReason: 'CANNOT FULFILL: x' }))).toBe(true);
    expect(canDevelop(issue({ state: 'developing' }))).toBe(false);
  });

  it('rejects cards past the develop stage', () => {
    expect(canDevelop(issue({ state: 'pr', resultPrUrl: 'https://github.com/dachrisch/devhub/pull/1' }))).toBe(false);
    expect(canDevelop(issue({ state: 'rollout' }))).toBe(false);
    expect(canDevelop(issue({ state: 'closed' }))).toBe(false);
  });
});
