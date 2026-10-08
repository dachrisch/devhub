'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Issue, Thread, ThreadEvent } from '@/lib/types';
import type { SplitItem } from '@/lib/plan';

// Card tap → detail view (full-screen). Work thread: issue body, live agent
// progress, question-banner with reply field (reply resumes the run).
// Strategy thread: full chat; steering by typing follow-ups; split proposal
// chips (confirm / drop / edit title inline) — nothing created until confirm.

interface ThreadDetailData {
  thread: Thread;
  events: ThreadEvent[];
  issues: Issue[];
  blockedReason: string | null;
  queuePositions: Record<string, number | 'live'>;
  splitProposal: SplitItem[];
}

interface ThreadDetailProps {
  threadId: number;
  onClose: () => void;
  onChanged: () => void;
}

export function ThreadDetail({ threadId, onClose, onChanged }: ThreadDetailProps) {
  const [data, setData] = useState<ThreadDetailData | null>(null);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropped, setDropped] = useState<Set<number>>(new Set());
  const [titles, setTitles] = useState<Record<number, string>>({});
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/threads/${threadId}`);
      if (!res.ok) return;
      const json = (await res.json()) as ThreadDetailData;
      setData(json);
    } catch {
      // ignore — SSE will retry
    }
  }, [threadId]);

  useEffect(() => {
    // Initial hydration — async fetch, not a sync setState cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const es = new EventSource('/api/stream');
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as { type?: string; threadId?: number };
        if ((msg.type === 'thread' || msg.type === 'thread-event') && msg.threadId === threadId) {
          void load();
        }
      } catch {
        // ignore
      }
    };
    return () => es.close();
  }, [threadId, load]);

  const sendReply = async () => {
    const text = reply.trim();
    if (!text) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/threads/${threadId}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(err?.error ?? `reply failed (${res.status})`);
      }
      setReply('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const sendConfirm = async () => {
    if (!data) return;
    const accepted = data.splitProposal.map((_, i) => i).filter((i) => !dropped.has(i));
    if (accepted.length === 0) {
      setError('drop everything = nothing to do — go back to keep chatting');
      return;
    }
    setConfirming(true);
    setError(null);
    try {
      const res = await fetch(`/api/threads/${threadId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accepted, titles }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(json?.error ?? `confirm failed (${res.status})`);
      onChanged();
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="v2-detail" role="dialog" aria-modal="true" aria-label="Thread detail">
      <div className="v2-detail-head">
        <button type="button" className="ghost" onClick={onClose} aria-label="Back to list">
          ← Back
        </button>
        <span className="v2-detail-title">{data?.thread.title ?? 'Loading…'}</span>
        {data && <span className={`v2-chip v2-chip-${data.thread.state}`}>{data.thread.state}</span>}
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

        {data?.blockedReason && (
          <div className="card-blocked v2-needs-input" role="alert">
            <strong>Needs input</strong>
            <span>{data.blockedReason}</span>
          </div>
        )}

        {data?.issues.map((issue) => (
          <section key={issue.id} className="v2-detail-issue">
            <div className="v2-card-repo">
              {issue.owner}/{issue.repo}#{issue.number} · {issue.state}
            </div>
            <h3>{issue.title}</h3>
            {issue.body && <p className="v2-detail-body-text">{issue.body.slice(0, 2000)}</p>}
            {issue.blockedReason && (
              <div className="card-blocked v2-needs-input" role="alert">
                <strong>Needs input</strong>
                <span>{issue.blockedReason}</span>
              </div>
            )}
            <a className="ghost" href={issue.htmlUrl} target="_blank" rel="noreferrer">
              GitHub ↗
            </a>
          </section>
        ))}

        {data && data.thread.kind === 'strategy' && (
          <section className="v2-chat" aria-label="Strategy chat">
            {data.events.map((ev) => (
              <div key={ev.id} className={`v2-chat-msg v2-chat-${ev.kind}`}>
                <span className="v2-chat-role">{ev.kind}</span>
                <p>{ev.text.slice(0, 4000)}</p>
              </div>
            ))}
          </section>
        )}

        {data && data.splitProposal.length > 0 && (
          <section className="v2-split" aria-label="Split proposal">
            <h3>Split proposal ({data.splitProposal.length})</h3>
            {data.splitProposal.map((item, i) => (
              <div key={i} className={`v2-split-card${dropped.has(i) ? ' v2-split-dropped' : ''}`}>
                <div className="v2-card-repo">{item.repo}</div>
                <input
                  aria-label={`Card title ${i + 1}`}
                  value={titles[i] ?? item.title}
                  onChange={(e) => setTitles((t) => ({ ...t, [i]: e.target.value }))}
                  disabled={dropped.has(i)}
                />
                <p>{item.why}</p>
                <div className="v2-card-actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() =>
                      setDropped((d) => {
                        const next = new Set(d);
                        if (next.has(i)) next.delete(i);
                        else next.add(i);
                        return next;
                      })
                    }
                  >
                    {dropped.has(i) ? 'Keep' : 'Drop'}
                  </button>
                </div>
              </div>
            ))}
            <button type="button" className="card-primary" onClick={() => void sendConfirm()} disabled={confirming}>
              {confirming ? 'Confirming…' : 'Confirm split → create cards'}
            </button>
          </section>
        )}
      </div>

      <div className="v2-detail-reply">
        <input
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void sendReply();
          }}
          placeholder={data?.blockedReason ? 'Answer to resume…' : 'Steer with a follow-up…'}
          aria-label="Reply in thread"
          disabled={sending}
        />
        <button type="button" className="v2-dock-send" onClick={() => void sendReply()} disabled={sending || !reply.trim()}>
          {sending ? '…' : '➤'}
        </button>
      </div>
    </div>
  );
}
