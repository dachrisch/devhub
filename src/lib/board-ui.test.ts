import { describe, expect, it } from 'vitest';
import {
  cardActions,
  closedReasonLabel,
  countRepos,
  excerpt,
  matchesIssue,
  primaryCardAction,
  relTime,
  repoColor,
} from './board-ui.js';
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
    linkedPrUrl: null,
    releaseTag: null,
    releasedAt: null,
    stateReason: null,
    createdAt: '2026-01-01 00:00:00',
    updatedAt: '2026-01-01 00:00:00',
    ...overrides,
  };
}

describe('cardActions', () => {
  it('offers develop + move-to-refinement for a backlog issue', () => {
    expect(cardActions(issue({ state: 'backlog' })).map((a) => a.id)).toEqual([
      'develop-validated',
      'to-refinement',
      'recap',
      'select-batch',
      'open-github',
    ]);
  });

  it('offers develop + move-to-backlog for a refinement issue', () => {
    expect(cardActions(issue({ state: 'refinement' })).map((a) => a.id)).toEqual([
      'develop-validated',
      'to-backlog',
      'recap',
      'select-batch',
      'open-github',
    ]);
  });

  it('offers develop but no transition for a blocked issue', () => {
    expect(cardActions(issue({ state: 'blocked' })).map((a) => a.id)).toEqual([
      'develop-validated',
      'recap',
      'select-batch',
      'open-github',
    ]);
  });

  it('drops develop for a developing issue and labels recap as live', () => {
    const actions = cardActions(issue({ state: 'developing' }));
    expect(actions.map((a) => a.id)).toEqual(['recap', 'select-batch', 'open-github']);
    expect(actions.find((a) => a.id === 'recap')?.label).toBe('Recap (live)');
  });

  it('drops develop for pr and rollout issues', () => {
    expect(cardActions(issue({ state: 'pr' })).map((a) => a.id)).toEqual([
      'recap',
      'select-batch',
      'open-github',
    ]);
    expect(cardActions(issue({ state: 'rollout' })).map((a) => a.id)).toEqual([
      'recap',
      'select-batch',
      'open-github',
    ]);
    expect(cardActions(issue({ state: 'closed' })).map((a) => a.id)).toEqual([
      'recap',
      'select-batch',
      'open-github',
    ]);
  });
});

describe('closedReasonLabel', () => {
  it('renders GitHub state reasons human-readably', () => {
    expect(closedReasonLabel('completed')).toBe('completed');
    expect(closedReasonLabel('not_planned')).toBe('not planned');
    expect(closedReasonLabel('reopened')).toBe('reopened');
    expect(closedReasonLabel(null)).toBe('closed');
  });
});

describe('primaryCardAction', () => {
  it('is Develop for backlog, refinement and blocked', () => {
    for (const state of ['backlog', 'refinement', 'blocked'] as const) {
      expect(primaryCardAction(issue({ state }))).toEqual({ label: 'Develop', kind: 'develop' });
    }
  });

  it('is Recap (live) while developing', () => {
    expect(primaryCardAction(issue({ state: 'developing' }))).toEqual({
      label: 'Recap (live)',
      kind: 'recap',
    });
  });

  it('is plain Recap for pr and rollout', () => {
    expect(primaryCardAction(issue({ state: 'pr' }))).toEqual({ label: 'Recap', kind: 'recap' });
    expect(primaryCardAction(issue({ state: 'rollout' }))).toEqual({ label: 'Recap', kind: 'recap' });
    expect(primaryCardAction(issue({ state: 'closed' }))).toEqual({ label: 'Recap', kind: 'recap' });
  });
});

describe('countRepos', () => {
  it('counts distinct owner/repo pairs', () => {
    expect(
      countRepos([
        { owner: 'a', repo: 'x' },
        { owner: 'a', repo: 'x' },
        { owner: 'a', repo: 'y' },
        { owner: 'b', repo: 'x' },
      ])
    ).toBe(3);
  });

  it('is zero for an empty list', () => {
    expect(countRepos([])).toBe(0);
  });
});

describe('repoColor', () => {
  it('is deterministic for the same key', () => {
    expect(repoColor('dachrisch/devhub')).toBe(repoColor('dachrisch/devhub'));
  });
});

describe('matchesIssue', () => {
  it('matches free text against title', () => {
    expect(matchesIssue(issue({ title: 'Fix the auth flow' }), 'auth')).toBe(true);
    expect(matchesIssue(issue({ title: 'Fix the auth flow' }), 'billing')).toBe(false);
  });

  it('matches field filters', () => {
    expect(matchesIssue(issue({ repo: 'web' }), 'repo:web')).toBe(true);
    expect(matchesIssue(issue({ repo: 'web' }), 'repo:api')).toBe(false);
  });
});

describe('relTime', () => {
  it('renders seconds for very recent timestamps', () => {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    expect(relTime(now)).toMatch(/^\d+s ago$/);
  });
});

describe('excerpt', () => {
  it('strips markdown and collapses whitespace', () => {
    expect(excerpt('# Title\n\nSome *body* text with `code`.')).toBe(
      'Title Some body text with code .'
    );
  });

  it('truncates long bodies to 180 chars with an ellipsis', () => {
    const long = 'a'.repeat(200);
    const result = excerpt(long);
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBe(181);
  });
});
