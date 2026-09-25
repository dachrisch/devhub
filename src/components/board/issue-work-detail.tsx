'use client';

import type { DevelopRun, Issue, IssueEvent } from '@/lib/types';
import { relTime } from '@/lib/board-ui';
import { activityLine, condense, eventText, isNoise, truncateText } from '@/lib/recap';
import { Markdown } from '@/components/markdown';

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

// Agent/error/validation text renders as styled markdown via <Markdown>;
// short identifiers and raw JSON debug fallbacks stay plain text.
function feedContent(e: IssueEvent): { markdown: string } | { plain: string } {
  if (e.kind === 'opencode') {
    const text = truncateText(eventText(e.payload));
    return { markdown: text || activityLine(e.payload) };
  }
  if (e.kind === 'error' || e.kind === 'validation-error' || e.kind === 'refinement-error') {
    const msg =
      typeof e.payload === 'object' && e.payload !== null && 'message' in e.payload
        ? String((e.payload as { message: unknown }).message)
        : JSON.stringify(e.payload).slice(0, 200);
    return { markdown: msg };
  }
  if (e.kind === 'validation' || e.kind === 'refinement') {
    return { markdown: validationLabel(e.payload) };
  }
  if (e.kind === 'model') {
    return { plain: modelLabel(e.payload) };
  }
  return { plain: JSON.stringify(e.payload).slice(0, 200) };
}

function FeedPayload({ event }: { event: IssueEvent }) {
  const content = feedContent(event);
  if ('markdown' in content) return <Markdown text={content.markdown} />;
  return <>{content.plain}</>;
}

export interface IssueWorkDetailProps {
  issue: Issue;
  events: IssueEvent[];
  runs: DevelopRun[];
  connected: boolean;
  onMarkShipped: () => void;
  shipping: boolean;
}

export function IssueWorkDetail({ issue, events, runs, onMarkShipped, shipping }: IssueWorkDetailProps) {
  const done = issue.state === 'pr' || issue.state === 'rollout' || issue.state === 'closed';
  // Strip tool calls / reasoning / keepalives and collapse consecutive
  // identical opencode events so the recap reads as a digest.
  const feed = condense(
    events.filter((e) => {
      if (e.kind === 'validation-event' || e.kind === 'refinement-event') return false;
      if (e.kind === 'opencode') return !isNoise(e.payload);
      return true;
    })
  );
  // During refinement the opencode events live on `refinement-event` rows
  // (filtered out of the digest above), so the live line falls back to the
  // newest meaningful one — otherwise a refinement run renders as silence.
  const refinementLatest = [...events].reverse().find((e) => e.kind === 'refinement-event' && !isNoise(e.payload));
  const live = !issue.blockedReason && (issue.state === 'developing' || issue.state === 'refinement');
  const latest = feed.find((e) => e.kind === 'opencode') ?? (live ? refinementLatest : undefined);
  const modelEvent = events.find((e) => e.kind === 'model');
  const latestText = latest ? truncateText(eventText(latest.payload)) : '';

  return (
    <div className="issue-work-detail">
      {runs.length > 0 && (
        <div className="recap-result runs">
          <h3>Run timeline</h3>
          {runs.map((r) => (
            <p key={r.id}>
              <strong>{r.role}</strong> {r.repoOwner}/{r.repoName} — {r.state}
              {r.prUrl && (
                <>
                  {' '}· <a href={r.prUrl}>{r.prUrl}</a>
                </>
              )}
              {r.blockedReason && <> · needs input: {r.blockedReason.slice(0, 200)}</>}
            </p>
          ))}
          {(issue.state === 'pr' || issue.state === 'developing') && (
            <button type="button" className="ghost" disabled={shipping} onClick={onMarkShipped}>
              {shipping ? 'Marking…' : 'Mark shipped'}
            </button>
          )}
        </div>
      )}

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
          {latestText && (
            <div className="recap-snippet">
              <Markdown text={latestText} />
            </div>
          )}
        </div>
      )}

      {issue.blockedReason && (
        <div className="recap-result blocked" role="alert">
          <h3>Needs input</h3>
          <Markdown text={issue.blockedReason} />
        </div>
      )}

      {done && (
        <div className={`recap-result ${issue.state}`}>
          <h3>
            {issue.state === 'pr' ? 'Done — pull request opened' : issue.state === 'rollout' ? 'Done — released' : 'Done — closed'}
          </h3>
          {modelEvent && <p className="recap-model">Model: {modelLabel(modelEvent.payload)}</p>}
          {issue.resultPrUrl && (
            <p>
              <a href={issue.resultPrUrl} target="_blank" rel="noreferrer" title={issue.resultPrUrl}>
                Review it on GitHub ↗
              </a>
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
              <FeedPayload event={e} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
