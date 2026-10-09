import { describe, expect, test } from 'vitest';
import {
  buildContextBrief,
  buildPlannerPrompt,
  capSplitProposal,
  parseSplitProposal,
} from './plan';
import type { Issue } from './types';

function issue(over: Partial<Issue> & { owner: string; repo: string; number: number }): Issue {
  return {
    id: over.number,
    githubIssueId: over.number,
    owner: over.owner,
    repo: over.repo,
    number: over.number,
    title: over.title ?? `Issue ${over.number}`,
    body: over.body ?? null,
    htmlUrl: `https://github.com/${over.owner}/${over.repo}/issues/${over.number}`,
    state: over.state ?? 'backlog',
    sessionId: null,
    resultPrUrl: null,
    resultText: null,
    blockedReason: null,
    linkedPrUrl: null,
    releaseTag: null,
    releasedAt: null,
    stateReason: null,
    modelId: null,
    projectId: null,
    topicId: null,
    repoScope: null,
    infraFirst: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('buildContextBrief', () => {
  test('condenses issues per repo to title/number/gist, not raw bodies', () => {
    const brief = buildContextBrief([
      issue({
        owner: 'dachrisch',
        repo: 'xy-app',
        number: 1,
        title: 'Login broken',
        body: 'First paragraph gist.\n\nSecond paragraph with details '.repeat(20),
      }),
    ]);
    expect(brief).toHaveLength(1);
    expect(brief[0].repo).toBe('dachrisch/xy-app');
    expect(brief[0].items[0].number).toBe(1);
    expect(brief[0].items[0].title).toBe('Login broken');
    expect(brief[0].items[0].gist.length).toBeLessThanOrEqual(200);
    expect(brief[0].items[0].gist).toContain('First paragraph gist');
  });

  test('excludes old closed issues', () => {
    const old = issue({ owner: 'a', repo: 'b', number: 9, state: 'closed' });
    old.updatedAt = new Date(Date.now() - 60 * 86400000).toISOString();
    const brief = buildContextBrief([old]);
    expect(brief).toEqual([]);
  });
});

describe('parseSplitProposal', () => {
  test('parses a fenced JSON array', () => {
    const text = 'Here is my proposal:\n```json\n[{"repo":"a/b","title":"T","body":"B","why":"W"}]\n```';
    expect(parseSplitProposal(text)).toEqual([{ repo: 'a/b', title: 'T', body: 'B', why: 'W' }]);
  });

  test('returns empty when there is no proposal', () => {
    expect(parseSplitProposal('just some strategy thoughts, no split')).toEqual([]);
  });

  test('drops malformed records', () => {
    const text = '```json\n[{"repo":"a/b","title":"T"},{"nope":1}]\n```';
    const out = parseSplitProposal(text);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('T');
  });
});

describe('capSplitProposal', () => {
  test('caps at 10 and reports the offer', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ repo: 'a/b', title: `t${i}`, body: '', why: '' }));
    const { kept, capped, offered } = capSplitProposal(items);
    expect(kept).toHaveLength(10);
    expect(capped).toBe(true);
    expect(offered).toBe(12);
  });

  test('small proposals pass through uncapped', () => {
    const { kept, capped } = capSplitProposal([{ repo: 'a/b', title: 't', body: '', why: '' }]);
    expect(kept).toHaveLength(1);
    expect(capped).toBe(false);
  });
});

describe('buildPlannerPrompt', () => {
  test('includes the brief and the 10-cap instruction', () => {
    const prompt = buildPlannerPrompt(
      [{ repo: 'a/b', items: [{ number: 1, title: 'T', gist: 'G' }] }],
      'come up with a strategy'
    );
    expect(prompt).toContain('a/b');
    expect(prompt).toContain('10');
    expect(prompt).toContain('come up with a strategy');
  });

  test('signals whole-board scope when there is no repo filter', () => {
    const prompt = buildPlannerPrompt(
      [{ repo: 'a/b', items: [{ number: 1, title: 'T', gist: 'G' }] }],
      'which low hanging fruits next?',
      true
    );
    expect(prompt).toContain('whole board');
  });
});
