import type { IssueState } from './types';

// Manual card moves the operator is allowed to make on the board. Everything
// else is owned by the develop flow (`developing`/`pr`/`blocked`) or by the
// rollout sweep (`rollout`), so it must not be reachable via this endpoint.
export const ALLOWED_TRANSITIONS: Partial<Record<IssueState, IssueState[]>> = {
  backlog: ['refinement'],
  refinement: ['backlog'],
};

export function canTransition(from: IssueState, to: IssueState): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

// Batch advance transitions: used by the "Advance selected" batch action.
export const BATCH_ADVANCE_TRANSITIONS: Partial<Record<IssueState, IssueState>> = {
  backlog: 'refinement',
  refinement: 'backlog',
};

export function canBatchAdvance(from: IssueState): boolean {
  return from in BATCH_ADVANCE_TRANSITIONS;
}

export function getBatchAdvanceTarget(from: IssueState): IssueState | null {
  return BATCH_ADVANCE_TRANSITIONS[from] ?? null;
}