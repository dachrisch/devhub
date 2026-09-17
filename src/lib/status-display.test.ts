import { describe, expect, it } from 'vitest';
import { deriveIssueDisplayStatus, deriveTopicDisplayStatus } from './status-display.js';
import type { IssueState, TopicStatus } from './types.js';

describe('status-display', () => {
  describe('deriveIssueDisplayStatus', () => {
    it('maps every IssueState to the same FunnelColumn the board uses', () => {
      const cases: Array<[IssueState, string, string]> = [
        ['backlog', 'ready', 'Ready'],
        ['refinement', 'realizing', 'Realizing'],
        ['developing', 'realizing', 'Realizing'],
        ['pr', 'rollout', 'Rollout'],
        ['rollout', 'delivered', 'Delivered'],
        ['closed', 'delivered', 'Delivered'],
      ];
      for (const [state, key, label] of cases) {
        const result = deriveIssueDisplayStatus(state);
        expect(result.key).toBe(key);
        expect(result.label).toBe(label);
      }
    });
  });

  describe('deriveTopicDisplayStatus', () => {
    it('maps every TopicStatus with no linked issues to the status-derived column', () => {
      const cases: Array<[TopicStatus, string, string]> = [
        ['new', 'idea', 'Shaping…'],
        ['shaping', 'idea', 'Shaping…'],
        ['ready', 'ready', 'Ready'],
        ['realizing', 'ready', 'Realizing…'],
        ['shipped', 'delivered', 'Delivered'],
        ['dropped', 'delivered', 'Archived'],
      ];
      for (const [status, key, label] of cases) {
        const result = deriveTopicDisplayStatus(status);
        expect(result.key).toBe(key);
        expect(result.label).toBe(label);
      }
    });

    it('promotes a ready topic to realizing when work starts', () => {
      expect(deriveTopicDisplayStatus('ready', ['backlog', 'refinement']).key).toBe('realizing');
      expect(deriveTopicDisplayStatus('ready', ['developing']).key).toBe('realizing');
    });

    it('moves to delivered when all linked work settles', () => {
      expect(deriveTopicDisplayStatus('realizing', ['closed']).key).toBe('delivered');
      expect(deriveTopicDisplayStatus('ready', ['closed', 'rollout']).key).toBe('delivered');
    });

    it('keeps shipped/dropped topics delivered even with live linked issues', () => {
      expect(deriveTopicDisplayStatus('shipped', ['pr']).key).toBe('delivered');
      expect(deriveTopicDisplayStatus('dropped', ['backlog']).key).toBe('delivered');
    });
  });
});
