'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Issue, IssueEvent } from '@/lib/types';
import { DetailShell } from './detail-shell';
import { MarkdownBody } from './markdown-body';
import { ActivityTimeline, type ActivityRow } from './activity-timeline';

// Card tap → detail (v3). Shared DetailShell (appbar stays visible, Esc/back
// close, ?card= URL sync). Markdown body via MarkdownBody, event history via
// ActivityTimeline, chip-style GitHub links, and ONE clear Work CTA. A card
// not linked to a thread still has the full reading view — and "Work on
// this" hands the issue to the same command pipeline the dock uses (never
// re-develops pr/rollout/closed cards; read-only there).

interface IssueDetailProps {
  issue: Issue;
  onClose: () => void;
  onWorked: (threadId: number) => void;
}

const WORKABLE = new Set(['backlog', 'refinement', 'developing']);

function eventText(event: IssueEvent): string {
  const p = event.payload;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    const rec = p as Record<string, unknown>;
    const candidate = rec.message ?? rec.summary ?? rec.reason ?? rec.status ?? rec.text;
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  try {
    return JSON.stringify(p);
  } catch {
    return event.kind;
  }
}

function activityRows(events: IssueEvent[]): ActivityRow[] {
  return events.map((e) => ({ id: String(e.id), kind: e.kind, ts: e.ts, text: eventText(e) }));
}

function relativeSynced(issue: Issue): string {
  const t = new Date(issue.updatedAt).getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'synced just now';
  if (mins < 60) return `synced ${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `synced ${hours}h ago`;
  return `synced ${Math.round(hours / 24)}d ago`;
}

export function IssueDetail({ issue, onClose, onWorked }: IssueDetailProps) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<IssueEvent[] | null>(null);

  const workable = WORKABLE.has(issue.state);

  const loadEvents = useCallback(async () => {
    try {
      const res = await fetch(`/api/issues/${issue.id}`);
      if (!res.ok) return;
      const json = (await res.json()) as { events?: IssueEvent[] };
      setEvents(json.events ?? []);
    } catch {
      // ignore — SSE keeps the card list live; timeline is best effort
    }
  }, [issue.id]);

  useEffect(() => {
    // Initial hydration — async fetch, not a sync setState cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadEvents();
  }, [loadEvents]);

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
    <DetailShell title={`${issue.owner}/${issue.repo}#${issue.number}`} onClose={onClose}>
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
          {issue.updatedAt && <span className="v2-detail-meta"> · {relativeSynced(issue)}</span>}
        </div>
        <h3>{issue.title}</h3>
        {issue.blockedReason && (
          <div className="card-blocked v2-needs-input" role="alert">
            <strong>Needs input</strong>
            <span>{issue.blockedReason}</span>
          </div>
        )}
        {issue.body && <MarkdownBody text={issue.body.slice(0, 4000)} />}
        {issue.resultText && (
          <details className="v2-result" open>
            <summary>Last result</summary>
            <MarkdownBody text={issue.resultText.slice(0, 4000)} />
          </details>
        )}
        <div className="v2-card-actions">
          <a className="v2-link-chip" href={issue.htmlUrl} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
          {issue.linkedPrUrl && (
            <a className="v2-link-chip" href={issue.linkedPrUrl} target="_blank" rel="noreferrer">
              Pull request ↗
            </a>
          )}
        </div>
        {events && <ActivityTimeline rows={activityRows(events)} defaultOpen={Boolean(issue.blockedReason)} />}
      </section>

      {workable && (
        <div className="v2-detail-actions">
          <button type="button" className="card-primary" onClick={() => void startWork()} disabled={starting}>
            {starting ? 'Starting…' : 'Work on this'}
          </button>
        </div>
      )}
      {!workable && (
        <div className="v2-detail-note">
          Read-only — card is in “{issue.state}”{issue.stateReason ? ` · ${issue.stateReason.replace(/_/g, ' ')}` : ''}
        </div>
      )}
    </DetailShell>
  );
}
