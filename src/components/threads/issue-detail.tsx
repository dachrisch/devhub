'use client';

import { useState } from 'react';
import type { Issue } from '@/lib/types';

// Card tap → issue detail (full-screen), card-first reading view (v2). A
// card not linked to a thread has somewhere to go: title, body, Needs-input
// banner, GitHub link — and a "Work on this" action that hands the issue to
// the same command pipeline the dock uses (never re-develops
// pr/rollout/closed cards; read-only there).

interface IssueDetailProps {
  issue: Issue;
  onClose: () => void;
  onWorked: (threadId: number) => void;
}

const WORKABLE = new Set(['backlog', 'refinement', 'developing']);

export function IssueDetail({ issue, onClose, onWorked }: IssueDetailProps) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workable = WORKABLE.has(issue.state);

  const startWork = async () => {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch('/api/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: `Implement ${issue.owner}/${issue.repo}#${issue.number}` }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; threadId?: number; error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? `command failed (${res.status})`);
      if (typeof data?.threadId === 'number') onWorked(data.threadId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="v2-detail" role="dialog" aria-modal="true" aria-label="Issue detail">
      <div className="v2-detail-head">
        <button type="button" className="ghost" onClick={onClose} aria-label="Back to list">
          ← Back
        </button>
        <span
          className={`v2-chip v2-chip-${issue.state}`}
        >
          {issue.state}
        </span>
      </div>

      <div className="v2-detail-body">
        {error && (
          <div className="banner" role="alert">
            <span>{error}</span>
            <button type="button" className="ghost" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        <section className="v2-detail-issue">
          <div className="v2-card-repo">
            {issue.owner}/{issue.repo}#{issue.number}
          </div>
          <h3>{issue.title}</h3>
          {issue.blockedReason && (
            <div className="card-blocked v2-needs-input" role="alert">
              <strong>Needs input</strong>
              <span>{issue.blockedReason}</span>
            </div>
          )}
          {issue.body && <p className="v2-detail-body-text">{issue.body.slice(0, 4000)}</p>}
          {issue.resultText && <p className="v2-detail-body-text">{issue.resultText.slice(0, 4000)}</p>}
          <div className="v2-card-actions">
            <a className="ghost" href={issue.htmlUrl} target="_blank" rel="noreferrer">
              GitHub ↗
            </a>
            {issue.linkedPrUrl && (
              <a className="ghost" href={issue.linkedPrUrl} target="_blank" rel="noreferrer">
                Pull request ↗
              </a>
            )}
          </div>
        </section>
      </div>

      {workable && (
        <div className="v2-detail-actions">
          <button type="button" className="card-primary" onClick={() => void startWork()} disabled={starting}>
            {starting ? 'Starting…' : 'Work on this'}
          </button>
        </div>
      )}
    </div>
  );
}
