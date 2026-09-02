import { describe, expect, it } from 'vitest';
import { ALLOWED_TRANSITIONS, canTransition, canBatchAdvance, getBatchAdvanceTarget } from './transitions.js';
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
    expect(isIssueState('closed')).toBe(true);
    expect(isIssueState('bogus')).toBe(false);
  });
});

describe('batch transitions', () => {
  it('allows batch advance from backlog to refinement', () => {
    expect(canBatchAdvance('backlog')).toBe(true);
    expect(getBatchAdvanceTarget('backlog')).toBe('refinement');
  });

  it('allows batch advance from refinement to backlog', () => {
    expect(canBatchAdvance('refinement')).toBe(true);
    expect(getBatchAdvanceTarget('refinement')).toBe('backlog');
  });

  it('rejects batch advance from other states', () => {
    expect(canBatchAdvance('developing')).toBe(false);
    expect(canBatchAdvance('pr')).toBe(false);
    expect(canBatchAdvance('rollout')).toBe(false);
    expect(canBatchAdvance('blocked')).toBe(false);
    expect(canBatchAdvance('closed')).toBe(false);
  });

  it('returns null for getBatchAdvanceTarget from unsupported states', () => {
    expect(getBatchAdvanceTarget('developing')).toBeNull();
    expect(getBatchAdvanceTarget('pr')).toBeNull();
  });
});
