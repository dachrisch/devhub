'use client';

import { useState } from 'react';

// One cockpit action as the board renders it. `detail` is the live status
// line from the SSE broadcast while running, and the stored summary/result
// once the action reaches a terminal state (drilled from GET /api/action/:id).
export interface CockpitAction {
  id: number;
  input: string;
  status: string;
  detail: string | null;
  durationMs: number | null;
}

// Shape returned by GET /api/action and GET /api/action/[id] (a subset of
// ActionRow — the fields the strip needs).
export interface ApiActionRow {
  id: number;
  input: string;
  status: string;
  result: string | null;
  durationMs: number | null;
}

export function actionFromApi(row: ApiActionRow): CockpitAction {
  return {
    id: row.id,
    input: row.input,
    status: row.status,
    detail: row.result,
    durationMs: row.durationMs,
  };
}

// Lifecycle ordering used to avoid a slow hydration response clobbering a
// newer SSE status (e.g. overwriting `failed` back to `running`).
const STATUS_RANK: Record<string, number> = { pending: 0, running: 1, success: 2, failed: 2 };

export function isTerminalActionStatus(status: string): boolean {
  return status === 'success' || status === 'failed';
}

// Merge a fetched row into an existing entry: fill placeholder input, but
// never roll the status back behind what SSE already showed.
export function mergeAction(existing: CockpitAction, row: ApiActionRow): CockpitAction {
  const merged = actionFromApi(row);
  const placeholder = existing.input === '' || existing.input === `Action #${existing.id}`;
  if (placeholder) return merged;
  if ((STATUS_RANK[merged.status] ?? 0) < (STATUS_RANK[existing.status] ?? 0)) {
    return {
      ...existing,
      detail: existing.detail ?? merged.detail,
      durationMs: merged.durationMs ?? existing.durationMs,
    };
  }
  return merged;
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return 'queued';
    case 'running':
      return 'running…';
    case 'success':
      return 'done';
    case 'failed':
      return 'failed';
    default:
      return status;
  }
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(secs < 10 ? 1 : 0)}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m${Math.round(secs % 60)}s`;
}

// Cap on finished actions surfaced directly in the strip before the rest
// collapse behind the "+N more" toggle, mirroring the released strip.
const DONE_CAP = 3;

export function ActionStatusStrip({
  actions,
  onSelect,
}: {
  actions: CockpitAction[];
  // When provided, every strip item becomes a button opening the action's
  // detail view (full input/result/transcript) — the only place where long
  // prompts and errors are readable.
  onSelect?: (actionId: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (actions.length === 0) return null;

  const isLive = (a: CockpitAction) => a.status === 'pending' || a.status === 'running';
  const live = actions.filter(isLive);
  const done = actions.filter((a) => !isLive(a));
  const visibleDone = expanded ? done : done.slice(0, DONE_CAP);

  return (
    <div className="action-strip" role="status" aria-live="polite" aria-label="Cockpit actions">
      <span className="released-label">Cockpit</span>
      <div className="action-strip-list">
        {live.map((a) => (
          <ActionItem key={a.id} action={a} onOpen={onSelect ? () => onSelect(a.id) : undefined} />
        ))}
        {visibleDone.map((a) => (
          <ActionItem key={a.id} action={a} onOpen={onSelect ? () => onSelect(a.id) : undefined} />
        ))}
        {done.length > DONE_CAP && (
          <button className="released-toggle" onClick={() => setExpanded((e) => !e)}>
            {expanded ? 'Collapse' : `+${done.length - DONE_CAP} more`}
          </button>
        )}
      </div>
    </div>
  );
}

function ActionItem({ action, onOpen }: { action: CockpitAction; onOpen?: () => void }) {
  const label = action.detail ?? statusLabel(action.status);
  const title = [
    action.input,
    isTerminalActionStatus(action.status) && action.durationMs != null
      ? `${statusLabel(action.status)} in ${fmtDuration(action.durationMs)}`
      : statusLabel(action.status),
  ]
    .filter(Boolean)
    .join(' — ');
  const content = (
    <>
      <span className="action-dot" aria-hidden="true" />
      <span className="action-item-input">{action.input || `Action #${action.id}`}</span>
      <span className="action-item-status">{label}</span>
      {onOpen && (
        <span className="action-item-chevron" aria-hidden="true">
          ›
        </span>
      )}
    </>
  );
  if (!onOpen) {
    return (
      <span className={`action-item ${action.status}`} title={title}>
        {content}
      </span>
    );
  }
  return (
    <button type="button" className={`action-item ${action.status}`} title={title} onClick={onOpen}>
      {content}
    </button>
  );
}
