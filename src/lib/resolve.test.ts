import { describe, expect, test } from 'vitest';
import { formatMention, mapRepos, parseIntent, resolveCommand } from './resolve';

const REPOS = ['dachrisch/xy-app', 'bumbleflies/warehouse', 'dachrisch/devhub'];

describe('parseIntent', () => {
  test('defaults to implement', () => {
    expect(parseIntent('fix login in XY', false)).toBe('implement');
  });

  test('detects strategy for multi-target asks', () => {
    expect(parseIntent('look at the recent tickets in XY and DEF and come up with a combined strategy', false)).toBe(
      'strategy'
    );
  });

  test('detects question for follow-ups when a thread is open', () => {
    expect(parseIntent('actually make it cheaper', true)).toBe('question');
  });

  test('follow-up without an open thread is not a question', () => {
    expect(parseIntent('actually make it cheaper', false)).toBe('implement');
  });
});

describe('mapRepos', () => {
  test('maps XY shorthand to dachrisch/xy-app', () => {
    const r = mapRepos('implement login in XY', REPOS);
    expect(r.matched).toEqual(['dachrisch/xy-app']);
    expect(r.chips).toEqual([]);
  });

  test('matches full owner/repo', () => {
    const r = mapRepos('ship it in bumbleflies/warehouse', REPOS);
    expect(r.matched).toEqual(['bumbleflies/warehouse']);
  });

  test('unknown repo yields a chip, never a guess', () => {
    const r = mapRepos('implement login in ZZZ', REPOS);
    expect(r.matched).toEqual([]);
    expect(r.chips).toHaveLength(1);
    expect(r.chips[0].kind).toBe('repo-choice');
  });

  test('ambiguous shorthand yields a choose-one chip', () => {
    const r = mapRepos('fix it in app', ['dachrisch/xy-app', 'dachrisch/my-app']);
    expect(r.matched).toEqual([]);
    expect(r.chips).toHaveLength(1);
    expect(r.chips[0].kind).toBe('repo-choice');
    expect(r.chips[0].options).toHaveLength(2);
  });

  test('matches multiple repos for strategy', () => {
    const r = mapRepos('combined strategy for XY and warehouse', REPOS);
    expect(r.matched).toEqual(['dachrisch/xy-app', 'bumbleflies/warehouse']);
  });
});

describe('resolveCommand', () => {
  test('implement resolves to a single target with no chips', () => {
    const r = resolveCommand('Implement login in XY', REPOS, { openThread: false });
    expect(r.intent).toBe('implement');
    expect(r.targets).toEqual(['dachrisch/xy-app']);
    expect(r.chips).toEqual([]);
  });

  test('unrecognized repo resolves to chips', () => {
    const r = resolveCommand('Implement login in ZZZ', REPOS, { openThread: false });
    expect(r.targets).toEqual([]);
    expect(r.chips.length).toBeGreaterThan(0);
  });

  test('question routes into the open thread', () => {
    const r = resolveCommand('make it cheaper', REPOS, { openThread: true, openThreadId: 9 });
    expect(r.intent).toBe('question');
    expect(r.openThreadId).toBe(9);
  });

  test('extracts issue numbers', () => {
    const r = resolveCommand('Implement #132', REPOS, { openThread: false });
    expect(r.issueNumbers).toEqual([132]);
  });
});

describe('formatMention', () => {
  test('formats an issue mention', () => {
    expect(formatMention('dachrisch', 'devhub', 132)).toBe('dachrisch/devhub#132');
  });
});
