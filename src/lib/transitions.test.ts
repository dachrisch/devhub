import { describe, expect, it } from 'vitest';
import { ALLOWED_TRANSITIONS, canTransition } from './transitions.js';
import { isIssueState } from './types.js';

describe('transitions', () => {
  it('allows refinement moves in both directions', () => {
    expect(canTransition('backlog', 'refinement')).toBe(true);
    expect(canTransition('refinement', 'backlog')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(canTransition('backlog', 'developing')).toBe(false);
    expect(canTransition('developing', 'pr')).toBe(false);
    expect(canTransition('pr', 'rollout')).toBe(false);
    expect(canTransition('backlog', 'blocked')).toBe(false);
  });

  it('covers every state as a source (all stay unreachable for manual moves)', () => {
    for (const state of Object.keys(ALLOWED_TRANSITIONS)) {
      expect(ALLOWED_TRANSITIONS[state as keyof typeof ALLOWED_TRANSITIONS]?.length).toBeGreaterThan(0);
    }
  });

  it('recognizes the new states', () => {
    expect(isIssueState('refinement')).toBe(true);
    expect(isIssueState('rollout')).toBe(true);
    expect(isIssueState('bogus')).toBe(false);
  });
});