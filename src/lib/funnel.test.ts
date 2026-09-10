import { describe, expect, it } from 'vitest';
import {
  FUNNEL_COLUMNS,
  funnelColumnForIssue,
  funnelColumnForTopic,
  funnelColumnForTopicWithIssues,
} from './funnel.js';
import type { IssueState, TopicStatus } from './types.js';

describe('funnel columns', () => {
  it('exposes the four live columns in display order (delivered renders below the board)', () => {
    expect([...FUNNEL_COLUMNS]).toEqual(['idea', 'ready', 'realizing', 'rollout']);
  });

  it('maps every topic status', () => {
    const cases: Array<[TopicStatus, string]> = [
      ['new', 'idea'],
      ['shaping', 'idea'],
      ['ready', 'ready'],
      ['realizing', 'ready'],
      ['shipped', 'delivered'],
      ['dropped', 'delivered'],
    ];
    for (const [status, column] of cases) {
      expect(funnelColumnForTopic(status)).toBe(column);
    }
  });

  it('maps every issue state', () => {
    const cases: Array<[IssueState, string]> = [
      ['backlog', 'ready'],
      ['refinement', 'realizing'],
      ['developing', 'realizing'],
      ['pr', 'rollout'],
      ['rollout', 'delivered'],
      ['closed', 'delivered'],
    ];
    for (const [state, column] of cases) {
      expect(funnelColumnForIssue(state)).toBe(column);
    }
  });

  it('keeps the status-derived column with no linked issues', () => {
    expect(funnelColumnForTopicWithIssues('ready', [])).toBe('ready');
    expect(funnelColumnForTopicWithIssues('new', [])).toBe('idea');
  });

  it('moves a topic to realizing once work starts', () => {
    expect(funnelColumnForTopicWithIssues('ready', ['backlog'])).toBe('ready');
    expect(funnelColumnForTopicWithIssues('realizing', ['backlog'])).toBe('ready');
    expect(funnelColumnForTopicWithIssues('ready', ['backlog', 'refinement'])).toBe('realizing');
    expect(funnelColumnForTopicWithIssues('ready', ['developing'])).toBe('realizing');
    expect(funnelColumnForTopicWithIssues('ready', ['pr'])).toBe('realizing');
    expect(funnelColumnForTopicWithIssues('ready', ['pr', 'rollout'])).toBe('realizing');
  });

  it('moves a topic to delivered once all linked work settles', () => {
    expect(funnelColumnForTopicWithIssues('realizing', ['closed'])).toBe('delivered');
    expect(funnelColumnForTopicWithIssues('ready', ['closed', 'closed'])).toBe('delivered');
    expect(funnelColumnForTopicWithIssues('realizing', ['rollout'])).toBe('delivered');
    expect(funnelColumnForTopicWithIssues('ready', ['closed', 'rollout'])).toBe('delivered');
  });

  it('keeps shipped/dropped topics delivered even with live linked issues', () => {
    expect(funnelColumnForTopicWithIssues('shipped', ['rollout'])).toBe('delivered');
    expect(funnelColumnForTopicWithIssues('shipped', ['pr'])).toBe('delivered');
    expect(funnelColumnForTopicWithIssues('dropped', ['backlog'])).toBe('delivered');
  });
});
