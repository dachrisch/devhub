'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { Issue, IssueEvent } from '@/lib/types';
import { activityLine, condense, eventSnippet, isNoise } from '@/lib/recap';
import { useAuth } from '@/components/use-auth';
import { WelcomeScreen } from '@/components/auth-ui';

interface OpencodeEventMsg {
  issueId: number;
  event: Record<string, unknown>;
}

function modelLabel(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const p = payload as { id?: unknown; providerID?: unknown };
  const id = typeof p.id === 'string' ? p.id : '';
  const provider = typeof p.providerID === 'string' ? p.providerID : '';
  return provider ? `${id} (${provider})` : id;
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
      <main className="recap-wrap">
        <WelcomeScreen />
      </main>
    );
  }

  if (!issue) {
    return (
      <main className="recap-wrap">
        <p className="muted">Loading…</p>
        <Link href="/" className="recap-link">← Back to board</Link>
      </main>
    );
  }

  const done = issue.state === 'pr' || issue.state === 'rollout' || issue.state === 'blocked' || issue.state === 'closed';
  // Strip tool calls / reasoning / keepalives and collapse consecutive
  // identical opencode events so the recap reads as a digest.
  const feed = condense(events.filter((e) => (e.kind === 'opencode' ? !isNoise(e.payload) : true)));
  const latest = feed.find((e) => e.kind === 'opencode');
  const modelEvent = events.find((e) => e.kind === 'model');

  return (
    <main className="recap-wrap">
      <header className="recap-head">
        <Link href="/" className="recap-link">← Board</Link>
        <span className={`dot ${issue.state}`} />
        <span className="recap-state">{issue.state}</span>
        <span
          className={`recap-conn conn-dot ${connected ? 'ok' : 'off'}`}
          title={connected ? 'live' : 'connecting…'}
          aria-label={connected ? 'live' : 'connecting…'}
        />
      </header>

      <div className="recap-title">
        <a href={issue.htmlUrl} target="_blank" rel="noreferrer">
          {issue.owner}/{issue.repo} #{issue.number}: {issue.title}
        </a>
      </div>

      {issue.linkedPrUrl && issue.state !== 'pr' && (
        <div className="recap-result pr">
          <h3>Linked pull request</h3>
          <p>
            PR: <a href={issue.linkedPrUrl}>{issue.linkedPrUrl}</a>
          </p>
        </div>
      )}

      {issue.state === 'developing' && (
        <div className="recap-live">
          <span className="pulse" /> {latest ? activityLine(latest.payload) : 'Starting agent…'}
          {modelEvent && <div className="recap-model">Model: {modelLabel(modelEvent.payload)}</div>}
          {latest && eventSnippet(latest.payload) && (
            <div className="recap-snippet">{eventSnippet(latest.payload)}</div>
          )}
        </div>
      )}

      {done && (
        <div className={`recap-result ${issue.state}`}>
          <h3>
            {issue.state === 'pr'
              ? 'Done — pull request opened'
              : issue.state === 'rollout'
                ? 'Done — released'
                : issue.state === 'closed'
                  ? 'Done — closed'
                  : 'Blocked'}
          </h3>
          {modelEvent && <p className="recap-model">Model: {modelLabel(modelEvent.payload)}</p>}
          {issue.resultPrUrl && (
            <p>
              PR: <a href={issue.resultPrUrl}>{issue.resultPrUrl}</a>
            </p>
          )}
          {issue.releaseTag && (
            <p>
              Released in <span className="release-tag">{issue.releaseTag}</span>
            </p>
          )}
          {issue.state === 'closed' && issue.stateReason && (
            <p>
              Closed on GitHub as <span className="release-tag">{issue.stateReason}</span>
            </p>
          )}
          {issue.resultText && <pre className="recap-text">{issue.resultText}</pre>}
        </div>
      )}

      <h4 className="recap-feed-head">Agent activity</h4>
      <div className="recap-feed">
        {feed.length === 0 && <p className="muted">No meaningful activity yet.</p>}
        {feed.map((e, idx) => (
          <div className="recap-event" key={`${e.ts}-${idx}`}>
            <span className="recap-event-type">{e.kind === 'opencode' ? activityLine(e.payload) : e.kind === 'model' ? 'Model' : e.kind}</span>
            <span className="recap-event-time">{e.ts}</span>
            <div className="recap-event-payload">
              {e.kind === 'opencode'
                ? eventSnippet(e.payload) || activityLine(e.payload)
                : e.kind === 'model'
                  ? modelLabel(e.payload)
                  : JSON.stringify(e.payload).slice(0, 200)}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
