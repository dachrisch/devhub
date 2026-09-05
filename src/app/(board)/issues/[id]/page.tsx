'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { Issue, IssueEvent } from '@/lib/types';
import { relTime } from '@/lib/board-ui';
import { activityLine, condense, eventSnippet, isNoise } from '@/lib/recap';
import { Markdown } from '@/components/markdown';
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

function validationLabel(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const p = payload as { status?: unknown; ready?: unknown; summary?: unknown };
  const status = typeof p.status === 'string' ? p.status : '';
  if (status === 'started') return 'Refinement started';
  const ready = p.ready === true;
  const summary = typeof p.summary === 'string' ? p.summary : '';
  return summary ? `Refinement ${ready ? 'passed' : 'needs input'}: ${summary}` : `Refinement ${ready ? 'passed' : 'needs input'}`;
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

  const done = issue.state === 'pr' || issue.state === 'rollout' || issue.state === 'closed';
  // Strip tool calls / reasoning / keepalives and collapse consecutive
  // identical opencode events so the recap reads as a digest.
  const feed = condense(events.filter((e) => {
    if (e.kind === 'validation-event' || e.kind === 'refinement-event') return false;
    if (e.kind === 'opencode') return !isNoise(e.payload);
    return true;
  }));
  // During refinement the opencode events live on `refinement-event` rows
  // (filtered out of the digest above), so the live line falls back to the
  // newest meaningful one — otherwise a refinement run renders as silence.
  const refinementLatest = [...events].reverse().find(
    (e) => e.kind === 'refinement-event' && !isNoise(e.payload)
  );
  const live = !issue.blockedReason && (issue.state === 'developing' || issue.state === 'refinement');
  const latest = feed.find((e) => e.kind === 'opencode') ?? (live ? refinementLatest : undefined);
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

      {live && (
        <div className="recap-live">
          <span className="pulse" /> {latest ? activityLine(latest.payload) : 'Starting agent…'}
          {modelEvent && <div className="recap-model">Model: {modelLabel(modelEvent.payload)}</div>}
          {latest && eventSnippet(latest.payload) && (
            <div className="recap-snippet">{eventSnippet(latest.payload)}</div>
          )}
        </div>
      )}

      {issue.blockedReason && (
        <div className="recap-result blocked" role="alert">
          <h3>Needs input</h3>
          <pre className="recap-text">{issue.blockedReason}</pre>
        </div>
      )}

      {done && (
        <div className={`recap-result ${issue.state}`}>
          <h3>
            {issue.state === 'pr'
              ? 'Done — pull request opened'
              : issue.state === 'rollout'
                ? 'Done — released'
                : 'Done — closed'}
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
          {issue.resultText && <Markdown text={issue.resultText} />}
        </div>
      )}

      <h4 className="recap-feed-head">Agent activity</h4>
      <div className="recap-feed">
        {feed.length === 0 && <p className="muted">No meaningful activity yet.</p>}
        {feed.map((e, idx) => (
          <div className="recap-event" key={`${e.ts}-${idx}`}>
            <span className="recap-event-type">{e.kind === 'opencode' ? activityLine(e.payload) : e.kind === 'model' ? 'Model' : e.kind === 'error' || e.kind === 'validation-error' || e.kind === 'refinement-error' ? 'Error' : e.kind === 'validation' ? 'Validation' : e.kind === 'refinement' ? 'Refinement' : e.kind}</span>
            <span className="recap-event-time" title={e.ts}>{relTime(e.ts)}</span>
            <div className="recap-event-payload">
              {e.kind === 'opencode'
                ? eventSnippet(e.payload) || activityLine(e.payload)
                : e.kind === 'model'
                  ? modelLabel(e.payload)
                  : e.kind === 'error' || e.kind === 'validation-error' || e.kind === 'refinement-error'
                    ? (typeof e.payload === 'object' && e.payload !== null && 'message' in e.payload ? String((e.payload as { message: unknown }).message) : JSON.stringify(e.payload).slice(0, 200))
                    : e.kind === 'validation' || e.kind === 'refinement'
                      ? validationLabel(e.payload)
                      : JSON.stringify(e.payload).slice(0, 200)}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
