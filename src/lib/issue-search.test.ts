import { describe, expect, it } from 'vitest';
import { filterIssueCandidates, WORKABLE_STATES } from './issue-search';
import type { Issue } from './types';

function issue(over: Partial<Issue>): Issue {
  return {
    id: 1,
    githubIssueId: 1,
    owner: 'dachrisch',
    repo: 'devhub',
    number: 1,
    title: 'an issue',
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
    ...over,
  };
}

describe('filterIssueCandidates', () => {
  it('exposes the workable states', () => {
    expect([...WORKABLE_STATES].sort()).toEqual(['backlog', 'developing', 'refinement']);
  });

  it('scopes to the resolved repo(s)', () => {
    const issues = [
      issue({ id: 1, repo: 'devhub', number: 10, title: 'update deps' }),
      issue({ id: 2, repo: 'leaguesphere', number: 20, title: 'update deps' }),
    ];
    const out = filterIssueCandidates(issues, ['dachrisch/devhub'], '');
    expect(out.map((i) => i.id)).toEqual([1]);
  });

  it('shows all repos when no scope is given', () => {
    const issues = [issue({ id: 1, repo: 'devhub' }), issue({ id: 2, repo: 'other' })];
    expect(filterIssueCandidates(issues, [], '').map((i) => i.id)).toEqual([1, 2]);
  });

  it('drops non-workable states', () => {
    const issues = [
      issue({ id: 1, state: 'backlog' }),
      issue({ id: 2, state: 'pr' }),
      issue({ id: 3, state: 'rollout' }),
      issue({ id: 4, state: 'closed' }),
      issue({ id: 5, state: 'refinement' }),
      issue({ id: 6, state: 'developing' }),
    ];
    expect(filterIssueCandidates(issues, [], '').map((i) => i.id)).toEqual([1, 5, 6]);
  });

  it('fuzzy-matches title, repo, and number', () => {
    const issues = [
      issue({ id: 1, repo: 'devhub', number: 132, title: 'read-first shell' }),
      issue({ id: 2, repo: 'warehouse', number: 8, title: 'keyboard shortcuts' }),
    ];
    expect(filterIssueCandidates(issues, [], 'shell').map((i) => i.id)).toEqual([1]);
    expect(filterIssueCandidates(issues, [], 'warehouse').map((i) => i.id)).toEqual([2]);
    expect(filterIssueCandidates(issues, [], '#8').map((i) => i.id)).toEqual([2]);
  });

  it('caps the result list', () => {
    const issues = Array.from({ length: 30 }, (_, i) => issue({ id: i + 1 }));
    expect(filterIssueCandidates(issues, [], '')).toHaveLength(8);
  });
});
