'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { Issue, IssueEvent } from '@/lib/types';
import { useAuth } from '@/components/use-auth';
import { WelcomeScreen } from '@/components/auth-ui';

interface OpencodeEventMsg {
  issueId: number;
  event: Record<string, unknown>;
}

function activityLine(ev: Record<string, unknown> | undefined): string {
  const type = (ev?.type as string) ?? '';
  if (type.includes('tool.called')) return 'Running a tool…';
  if (type.includes('tool.success')) return 'Tool finished';
  if (type.includes('tool')) return 'Using a tool…';
  if (type.includes('text')) return 'Writing response…';
  if (type.includes('step')) return 'Working on a step…';
  if (type.includes('session')) return 'In session…';
  return type || 'Working…';
}

function eventSnippet(ev: Record<string, unknown> | undefined): string {
  const data = (ev?.data ?? {}) as Record<string, unknown>;
  const text =
    typeof data.text === 'string'
      ? data.text
      : typeof data.title === 'string'
        ? data.title
        : typeof data.tool === 'string'
          ? `tool: ${data.tool}`
          : '';
  return text.replace(/\s+/g, ' ').trim();
}

export default function RecapPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [events, setEvents] = useState<IssueEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const { user } = useAuth();
  const signedIn = Boolean(user);

  const applyIssue = useCallback((i: Issue) => setIssue(i), []);
  const applyEvent = useCallback((e: IssueEvent) => {
    setEvents((prev) => {
      if (prev.some((p) => p.ts === e.ts && p.kind === e.kind)) return prev;
      return [e, ...prev];
    });
  }, []);

  useEffect(() => {
    if (!signedIn || !Number.isInteger(id)) return;
    let active = true;
    fetch(`/api/issues/${id}`)
      .then((r) => r.json())
      .then((data: { issue: Issue; events: IssueEvent[] }) => {
        if (!active) return;
        setIssue(data.issue);
        setEvents(data.events);
      })
      .catch(() => {});

    const es = new EventSource('/api/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'issue' && (msg.issue as Issue).id === id) applyIssue(msg.issue);
        if (msg.type === 'opencode-event') {
          const m = msg as unknown as OpencodeEventMsg;
          if (m.issueId === id) {
            applyEvent({ id: 0, issueId: id, kind: 'opencode', payload: m.event, ts: new Date().toISOString() });
          }
        }
      } catch {
        /* ignore */
      }
    };
    return () => {
      active = false;
      es.close();
    };
  }, [signedIn, id, applyIssue, applyEvent]);

  if (!signedIn) {
    return (
      <div className="recap-wrap">
        <WelcomeScreen />
      </div>
    );
  }

  if (!issue) {
    return (
      <div className="recap-wrap">
        <p className="muted">Loading…</p>
        <Link href="/" className="recap-link">← Back to board</Link>
      </div>
    );
  }

  const done = issue.state === 'pr' || issue.state === 'blocked';
  const latest = events.find((e) => e.kind === 'opencode');

  return (
    <div className="recap-wrap">
      <header className="recap-head">
        <Link href="/" className="recap-link">← Board</Link>
        <span className={`dot ${issue.state}`} />
        <span className="recap-state">{issue.state}</span>
        <span className="recap-conn">{connected ? 'live' : 'connecting…'}</span>
      </header>

      <div className="recap-title">
        <a href={issue.htmlUrl} target="_blank" rel="noreferrer">
          {issue.owner}/{issue.repo} #{issue.number}: {issue.title}
        </a>
      </div>

      {issue.state === 'developing' && (
        <div className="recap-live">
          <span className="pulse" /> {latest ? activityLine(latest.payload as Record<string, unknown>) : 'Starting agent…'}
          {latest && eventSnippet(latest.payload as Record<string, unknown>) && (
            <div className="recap-snippet">{eventSnippet(latest.payload as Record<string, unknown>)}</div>
          )}
        </div>
      )}

      {done && (
        <div className={`recap-result ${issue.state}`}>
          <h3>{issue.state === 'pr' ? 'Done — pull request opened' : 'Blocked'}</h3>
          {issue.resultPrUrl && (
            <p>
              PR: <a href={issue.resultPrUrl}>{issue.resultPrUrl}</a>
            </p>
          )}
          {issue.resultText && <pre className="recap-text">{issue.resultText}</pre>}
        </div>
      )}

      <h4 className="recap-feed-head">Agent activity</h4>
      <div className="recap-feed">
        {events.length === 0 && <p className="muted">No events yet.</p>}
        {events.map((e, idx) => (
          <div className="recap-event" key={`${e.ts}-${idx}`}>
            <span className="recap-event-type">{e.kind}</span>
            <span className="recap-event-time">{e.ts}</span>
            <div className="recap-event-payload">
              {e.kind === 'opencode'
                ? eventSnippet(e.payload as Record<string, unknown>) || activityLine(e.payload as Record<string, unknown>)
                : JSON.stringify(e.payload).slice(0, 200)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
