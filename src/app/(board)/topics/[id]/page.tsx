'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import type { IdeaMessage, Issue, Project, Topic } from '@/lib/types';
import { TOPIC_STATUS_LABELS } from '@/lib/types';
import { useAuth } from '@/components/use-auth';
import { Avatar, WelcomeScreen } from '@/components/auth-ui';
import { Logo } from '@/components/logo';

// Idea page, the chat home (devhub#171 Phase 2): header with plain status,
// shaped summary ("So far"), the options thread (hub proposals with one-click
// Choose + free-text reply box), footer actions (Realize lands in Phase 3,
// Mark ready / Archive / Merge into live now), and the hidden execution layer
// as an expandable "How it was built" section.
export default function TopicDetailPage() {
  const params = useParams<{ id: string }>();
  const topicId = Number(params.id);
  const validId = Number.isInteger(topicId) && topicId > 0;
  const router = useRouter();

  const [topic, setTopic] = useState<Topic | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [messages, setMessages] = useState<IdeaMessage[]>([]);
  const [winner, setWinner] = useState<Topic | null>(null);
  const [candidates, setCandidates] = useState<Topic[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mergeInto, setMergeInto] = useState('');
  const [showMerge, setShowMerge] = useState(false);
  const [reply, setReply] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);
  const [chooseBusy, setChooseBusy] = useState<string | null>(null);
  const [readyBusy, setReadyBusy] = useState(false);
  const { user, loading, denied, logout } = useAuth();
  const signedIn = Boolean(user);
  const threadLocked =
    topic != null && (topic.status === 'dropped' || topic.status === 'shipped' || topic.status === 'realizing');

  const fetchMessages = useCallback(async () => {
    if (!validId || !signedIn) return;
    try {
      const res = await fetch(`/api/topics/${topicId}/messages`);
      if (!res.ok) return;
      const data = (await res.json()) as { messages?: IdeaMessage[] };
      if (data.messages) setMessages(data.messages);
    } catch {
      // ignore — the thread is best-effort next to the topic header
    }
  }, [validId, signedIn, topicId]);

  const fetchAll = useCallback(async () => {
    if (!validId || !signedIn) return;
    try {
      const res = await fetch(`/api/topics/${topicId}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `topic not found (HTTP ${res.status})`);
      }
      const data = (await res.json()) as { topic: Topic };
      setTopic(data.topic);
      setError(null);
      if (data.topic.projectId != null) {
        fetch(`/api/projects/${data.topic.projectId}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((p: { project?: Project } | null) => {
            if (p?.project) setProject(p.project);
          })
          .catch(() => {});
        // Merge candidates: other active ideas in the same project.
        fetch(`/api/topics?projectId=${data.topic.projectId}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((t: { topics?: Topic[] } | null) => {
            if (t?.topics) setCandidates(t.topics.filter((c) => c.id !== topicId && c.status !== 'dropped' && c.status !== 'shipped'));
          })
          .catch(() => {});
      }
      if (data.topic.mergedIntoTopicId != null) {
        fetch(`/api/topics/${data.topic.mergedIntoTopicId}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((t: { topic?: Topic } | null) => {
            if (t?.topic) setWinner(t.topic);
          })
          .catch(() => {});
      } else {
        setWinner(null);
      }
      const issRes = await fetch('/api/issues');
      if (issRes.ok) {
        const issData = (await issRes.json()) as { issues: Issue[] };
        setIssues(issData.issues.filter((i) => i.topicId === topicId));
      }
      await fetchMessages();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [validId, signedIn, topicId, fetchMessages]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (!signedIn || !validId) return;
    const es = new EventSource('/api/stream');
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (
          (msg.type === 'topic' || msg.type === 'idea-status' || msg.type === 'idea-message') &&
          Number(msg.topicId) === topicId
        ) {
          void fetchAll();
        } else if (msg.type === 'issue' && (msg.issue as Issue).topicId === topicId) void fetchAll();
      } catch {
        // ignore
      }
    };
    return () => es.close();
  }, [signedIn, validId, topicId, fetchAll, fetchMessages]);

  const archive = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/topics/${topicId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'dropped' }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `archive failed (HTTP ${res.status})`);
      }
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, topicId, fetchAll]);

  const merge = useCallback(async () => {
    const intoId = Number(mergeInto);
    if (!Number.isInteger(intoId) || intoId <= 0 || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/topics/${topicId}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intoId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `merge failed (HTTP ${res.status})`);
      }
      setShowMerge(false);
      setMergeInto('');
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [mergeInto, busy, topicId, fetchAll]);

  const sendReply = useCallback(async () => {
    const text = reply.trim();
    if (!text || replyBusy) return;
    setReplyBusy(true);
    try {
      const res = await fetch(`/api/topics/${topicId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `reply failed (HTTP ${res.status})`);
      }
      setReply('');
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReplyBusy(false);
    }
  }, [reply, replyBusy, topicId, fetchAll]);

  const chooseOption = useCallback(
    async (optionId: string) => {
      if (chooseBusy) return;
      setChooseBusy(optionId);
      try {
        const res = await fetch(`/api/topics/${topicId}/choose`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ optionId }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error ?? `choose failed (HTTP ${res.status})`);
        }
        await fetchAll();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setChooseBusy(null);
      }
    },
    [chooseBusy, topicId, fetchAll]
  );

  const markReady = useCallback(async () => {
    if (readyBusy) return;
    setReadyBusy(true);
    try {
      const res = await fetch(`/api/topics/${topicId}/ready`, { method: 'POST' });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `mark ready failed (HTTP ${res.status})`);
      }
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReadyBusy(false);
    }
  }, [readyBusy, topicId, fetchAll]);

  if (!signedIn) {
    return (
      <div className="page-wrap">
        <header className="app-head">
          <div className="brand">
            <Logo size={28} />
            <span className="brand-name">DevHub</span>
          </div>
        </header>
        <main className="board-main">{!loading && <WelcomeScreen denied={denied} />}</main>
      </div>
    );
  }

  return (
    <div className="page-wrap">
      <header className="app-head">
        <div className="brand">
          <button type="button" className="recap-link" onClick={() => router.back()} aria-label="Back">
            ←
          </button>
          <Logo size={28} />
          <span className="brand-name">Idea</span>
        </div>
        <div className="head-controls">
          {user && (
            <>
              <Avatar login={user.login} avatarUrl={user.avatarUrl} />
              <span className="auth-login">{user.login}</span>
              <button className="header-icon-btn" onClick={logout} aria-label="Sign out">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M2 2.75C2 1.784 2.784 1 3.75 1h2.5a.75.75 0 010 1.5h-2.5a.25.25 0 00-.25.25v10.5c0 .138.112.25.25.25h2.5a.75.75 0 010 1.5h-2.5A1.75 1.75 0 012 13.25V2.75z" />
                </svg>
              </button>
            </>
          )}
        </div>
      </header>
      <main className="board-main topic-detail">
        {error && (
          <div className="banner" role="alert">
            <span>{error}</span>
            <button className="ghost" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}
        {!topic ? (
          <div className="empty">loading idea…</div>
        ) : (
          <>
            <div className="topic-detail-head">
              <h1 className="topic-detail-title">{topic.title}</h1>
              <span className={`topic-status topic-status-${topic.status}`}>
                {TOPIC_STATUS_LABELS[topic.status] ?? topic.status}
              </span>
            </div>
            <div className="topic-detail-meta">
              {project ? (
                <Link href={`/projects/${project.id}`} className="ghost">
                  {project.name} →
                </Link>
              ) : (
                <span className="project-shipped none">Inbox (no project)</span>
              )}
              {topic.area && <span className="repo-chip">{topic.area}</span>}
              {topic.readyAt && <span title={topic.readyAt}>Ready since {topic.readyAt.slice(0, 10)}</span>}
            </div>
            {(topic.shapedSummary || topic.notes) && (
              <div className="topic-detail-summary">
                <span className="released-label">So far</span>
                <p>{topic.shapedSummary ?? topic.notes}</p>
              </div>
            )}
            <div className="topic-thread" aria-label="Shaping conversation">
              {messages.length === 0 ? (
                <div className="empty">shaping the idea… options appear here</div>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className={`topic-msg topic-msg-${m.role}`}>
                    <div className="topic-msg-role">{m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Hub' : 'Note'}</div>
                    <div className="topic-msg-body">{m.body}</div>
                    {m.options && m.options.length > 0 && (
                      <ul className="topic-options">
                        {m.options.map((o) => {
                          const chosen = m.chosenOption === o.id;
                          return (
                            <li key={o.id} className={`topic-option${chosen ? ' chosen' : ''}`}>
                              <div className="topic-option-title">{o.title}</div>
                              {o.desc && <div className="topic-option-desc">{o.desc}</div>}
                              {o.tradeoff && <div className="topic-option-tradeoff">Cost: {o.tradeoff}</div>}
                              {!threadLocked &&
                                (chosen ? (
                                  <span className="topic-option-picked">✓ Chosen</span>
                                ) : (
                                  <button
                                    type="button"
                                    className="ghost"
                                    disabled={chooseBusy === o.id}
                                    onClick={() => void chooseOption(o.id)}
                                  >
                                    {chooseBusy === o.id ? 'Choosing…' : 'Choose'}
                                  </button>
                                ))}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                ))
              )}
            </div>
            {!threadLocked && (
              <div className="topic-reply">
                <textarea
                  className="search topic-reply-input"
                  placeholder="…or describe it your way"
                  value={reply}
                  rows={2}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void sendReply();
                  }}
                />
                <button
                  type="button"
                  className="card-primary"
                  disabled={!reply.trim() || replyBusy}
                  onClick={() => void sendReply()}
                >
                  {replyBusy ? 'Sending…' : 'Send'}
                </button>
              </div>
            )}
            {topic.status === 'dropped' && (
              <div className="banner" role="status">
                <span>
                  Archived
                  {winner ? (
                    <>
                      {' '}— merged into <Link href={`/topics/${winner.id}`}>{winner.title}</Link>
                    </>
                  ) : (
                    topic.mergedIntoTopicId != null && <> — merged into idea #{topic.mergedIntoTopicId}</>
                  )}
                </span>
              </div>
            )}
            {issues.some((i) => i.blockedReason) && (
              <div className="banner" role="alert">
                <span>Needs input: {issues.find((i) => i.blockedReason)?.blockedReason}</span>
                <Link href={project ? `/projects/${project.id}` : '/'} className="ghost">
                  See what broke
                </Link>
              </div>
            )}
            <div className="topic-detail-actions">
              <button type="button" className="card-primary" disabled title="One-click Realize lands in Phase 3 — promote from the project board for now">
                Realize it
              </button>
              {!threadLocked && topic.status !== 'ready' && (
                <button type="button" className="ghost" disabled={readyBusy} onClick={() => void markReady()}>
                  {readyBusy ? 'Marking…' : "I'm happy — it's ready"}
                </button>
              )}
              <button type="button" className="ghost" disabled={busy || topic.status === 'dropped'} onClick={() => void archive()}>
                {busy ? 'Working…' : 'Archive'}
              </button>
              <button
                type="button"
                className="ghost"
                disabled={busy || topic.status === 'dropped'}
                onClick={() => setShowMerge((s) => !s)}
              >
                Merge into…
              </button>
            </div>
            {showMerge && topic.status !== 'dropped' && (
              <div className="topic-merge-form">
                <select
                  className="search"
                  value={mergeInto}
                  onChange={(e) => setMergeInto(e.target.value)}
                  aria-label="Merge into idea"
                >
                  <option value="" disabled>
                    Pick the winning idea…
                  </option>
                  {candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.id} {c.title}
                    </option>
                  ))}
                </select>
                <button type="button" className="card-primary" disabled={!Number(mergeInto) || busy} onClick={() => void merge()}>
                  {busy ? 'Merging…' : 'Link + archive'}
                </button>
              </div>
            )}
            <details className="topic-how">
              <summary>How it was built ({issues.length})</summary>
              {issues.length === 0 ? (
                <div className="empty">nothing built yet — this idea has no linked issues.</div>
              ) : (
                <ul className="released-list">
                  {issues.map((i) => (
                    <li key={i.id} className="released-item">
                      <span className={`dot ${i.state}`} />
                      <span className="released-title">
                        {i.owner}/{i.repo} #{i.number}: {i.title} ({i.state})
                      </span>
                      <Link href={`/issues/${i.id}`} className="ghost">
                        Recap →
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          </>
        )}
      </main>
    </div>
  );
}
