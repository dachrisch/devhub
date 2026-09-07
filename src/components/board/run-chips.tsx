'use client';

import { useEffect, useState } from 'react';
import type { DevelopRun, Issue } from '@/lib/types';

// Per-run PR chips + scope badge + partial-shipped warning for board cards
// (devhub#167). Runs are fetched per card; the list is tiny (1-2 rows).
export function useRuns(issueId: number): DevelopRun[] {
  const [runs, setRuns] = useState<DevelopRun[]>([]);
  useEffect(() => {
    let active = true;
    fetch(`/api/issues/${issueId}/runs`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { runs?: DevelopRun[] } | null) => {
        if (active && data?.runs) setRuns(data.runs);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [issueId]);
  return runs;
}

function shortState(state: DevelopRun['state']): string {
  switch (state) {
    case 'developing':
      return 'dev';
    case 'merged':
      return 'merged';
    case 'released':
      return 'live';
    case 'failed':
      return 'failed';
    case 'pending':
      return 'pending';
    case 'pr':
      return 'pr';
  }
}

export function ScopeBadge({ issue }: { issue: Issue }) {
  if (!issue.repoScope || issue.repoScope === 'service') return null;
  return (
    <span className="scope-badge" title={issue.infraFirst ? 'infra runs first' : 'service runs first'}>
      {issue.repoScope === 'both' ? (issue.infraFirst ? 'infra→svc' : 'svc→infra') : issue.repoScope}
    </span>
  );
}

export function RunChips({ issue, runs }: { issue: Issue; runs: DevelopRun[] }) {
  if (runs.length === 0) return null;
  const released = runs.filter((r) => r.state === 'released').length;
  const partial = released > 0 && released < runs.length;
  return (
    <div className="run-chips">
      {runs.map((r) => (
        <span key={r.id} className={`run-chip ${r.state}`} title={`${r.role}: ${r.repoOwner}/${r.repoName} — ${r.state}${r.blockedReason ? ` — ${r.blockedReason}` : ''}`}>
          {r.role} #{runNumber(r.prUrl)} ●{shortState(r.state)}
        </span>
      ))}
      {partial && (
        <span className="run-partial" role="alert" title="Some repos shipped, others are still pending">
          partial: {runs.find((r) => r.state === 'released')?.role} live,{' '}
          {runs.find((r) => r.state !== 'released')?.role} pending
        </span>
      )}
      {runs.some((r) => r.blockedReason) && (
        <span className="run-blocked" role="alert">
          {runs.find((r) => r.blockedReason)?.role}: {runs.find((r) => r.blockedReason)?.blockedReason?.slice(0, 120)}
        </span>
      )}
      {issue.topicId != null && <span className="topic-tag">topic #{issue.topicId}</span>}
    </div>
  );
}

function runNumber(prUrl: string | null): string {
  if (!prUrl) return '—';
  const m = prUrl.match(/\/pull\/(\d+)/);
  return m ? m[1] : 'pr';
}
