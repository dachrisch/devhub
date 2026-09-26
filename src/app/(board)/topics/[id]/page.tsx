'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import type { DevelopRun, IdeaMessage, Issue, IssueEvent, Project, Topic } from '@/lib/types';
import { isTopicThreadLocked, relTime } from '@/lib/board-ui';
import { useAuth } from '@/components/use-auth';
import { WelcomeScreen } from '@/components/auth-ui';
import { AppHeader } from '@/components/app-header';
import { StatusPill } from '@/components/status-pill';
import { IssueRef } from '@/components/board/issue-ref';
import { IssueWorkDetail } from '@/components/board/issue-work-detail';
import { deriveTopicDisplayStatus } from '@/lib/status-display';

// Client-safe copy of realizeStage (src/lib/realize.ts) — the page cannot
// import that server module (it pulls in undici via develop/opencode).
type RealizeStage = 'understanding' | 'building' | 'checking' | 'delivered' | 'needs-input';
const STAGE_LABELS: Record<RealizeStage, string> = {
  understanding: 'Understanding…',
  building: 'Building…',
  checking: 'Checking…',
  delivered: 'Delivered',
  'needs-input': 'Needs input',
};
function stageFor(status: Topic['status'], issues: Issue[]): RealizeStage {
  if (status === 'shipped' || (issues.length > 0 && issues.every((i) => i.state === 'rollout' || i.state === 'closed'))) {
    return 'delivered';
  }
  if (issues.some((i) => i.blockedReason)) return 'needs-input';
  if (issues.some((i) => i.state === 'pr')) return 'checking';
  if (issues.some((i) => i.state === 'developing')) return 'building';
  return 'understanding';
}
const TIMELINE_STEPS: Exclude<RealizeStage, 'needs-input'>[] = ['understanding', 'building', 'checking', 'delivered'];

// Plain-words state for the work panel rows (issue states stay on the expert
// recap; the studio speaks the same words as the realize timeline).
const TOPIC_WORK_STATE: Record<Issue['state'], string> = {
  backlog: 'queued',
  refinement: 'understanding',
  developing: 'building',
  pr: 'checking',
  rollout: 'released',
  closed: 'closed',
};

// Idea page, the chat home (devhub#171 Phase 2): header with plain status,
// shaped summary ("So far"), the options thread (hub proposals with one-click
// Choose + free-text reply box), footer actions (Realize lands in Phase 3,
// Mark ready / Archive / Merge into live now), and the hidden execution layer
// as an expandable "How it was built" section.
export default function TopicDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const topicId = Number(params.id);
  const validId = Number.isInteger(topicId) && topicId > 0;

  const [topic, setTopic] = useState<Topic | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  // Mirrors `issues` ids for the SSE handler below without making the
  // EventSource-owning effect depend on `issues` state directly — a ref read
  // doesn't trigger re-renders/re-runs, so the connection only reconnects on
  // signedIn/validId/topicId changes, not on every unrelated broadcast that
  // happens to call fetchAll() and produce a fresh `issues` array reference.
  const issueIdsRef = useRef<Set<number>>(new Set());
  const [issueEvents, setIssueEvents] = useState<Record<number, IssueEvent[]>>({});
  const [issueRuns, setIssueRuns] = useState<Record<number, DevelopRun[]>>({});
  const [shippingId, setShippingId] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
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
  const [promotionError, setPromotionError] = useState<string | null>(null);
  const [resumeNote, setResumeNote] = useState<string | null>(null);
  const [realizeBusy, setRealizeBusy] = useState(false);
  const { user, loading, denied, logout } = useAuth();
  const signedIn = Boolean(user);

  // History-back with fallback: if the user arrived directly (bookmark, refresh,
  // shared URL) there is no previous history entry, so we navigate to the
  // topic's project board instead of leaving the app.
  const goBack = useCallback(() => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
    } else if (topic?.projectId != null) {
      router.push(`/projects/${topic.projectId}`);
    } else {
      router.push('/');
    }
  }, [router, topic]);

  // Blocked realizations unlock the thread: the reply/choice is the answer
  // and resumes the loop. Unknown state defaults to locked.
  const needsInput = issues.some((i) => i.blockedReason);
  const threadLocked = topic == null || isTopicThreadLocked(topic.status, needsInput);
  const firstBlocked = issues.find((i) => i.blockedReason);

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
        const linked = issData.issues.filter((i) => i.topicId === topicId);
        setIssues(linked);
        issueIdsRef.current = new Set(linked.map((i) => i.id));
        for (const i of linked) {
          fetch(`/api/issues/${i.id}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d: { events?: IssueEvent[] } | null) => {
              if (d?.events) setIssueEvents((prev) => ({ ...prev, [i.id]: d.events! }));
            })
            .catch(() => {});
          fetch(`/api/issues/${i.id}/runs`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d: { runs?: DevelopRun[] } | null) => {
              if (d?.runs) setIssueRuns((prev) => ({ ...prev, [i.id]: d.runs! }));
            })
            .catch(() => {});
        }
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
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (
          (msg.type === 'topic' || msg.type === 'idea-status' || msg.type === 'idea-message') &&
          Number(msg.topicId) === topicId
        ) {
          void fetchAll();
        } else if (msg.type === 'issue' && (msg.issue as Issue).topicId === topicId) {
          void fetchAll();
        } else if (msg.type === 'run' && issueIdsRef.current.has((msg as { issueId?: number }).issueId ?? -1)) {
          const issueId = (msg as { issueId: number }).issueId;
          fetch(`/api/issues/${issueId}/runs`)
            .then((r) => (r.ok ? r.json() : null))
            .then((d: { runs?: DevelopRun[] } | null) => {
              if (d?.runs) setIssueRuns((prev) => ({ ...prev, [issueId]: d.runs! }));
            })
            .catch(() => {});
        } else if (msg.type === 'opencode-event') {
          const m = msg as { issueId: number; event: Record<string, unknown> };
          if (issueIdsRef.current.has(m.issueId)) {
            setIssueEvents((prev) => ({
              ...prev,
              [m.issueId]: [
                { id: 0, issueId: m.issueId, kind: 'opencode', payload: m.event, ts: new Date().toISOString() },
                ...(prev[m.issueId] ?? []),
              ],
            }));
          }
        }
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

  const markShipped = useCallback(
    async (issueId: number) => {
      setShippingId(issueId);
      try {
        const res = await fetch(`/api/issues/${issueId}/mark-shipped`, { method: 'POST' });
        const data = (await res.json()) as { issue?: Issue };
        if (data.issue) setIssues((prev) => prev.map((i) => (i.id === issueId ? data.issue! : i)));
      } catch {
        // ignore — the SSE `issue` broadcast will reconcile state if the request landed
      } finally {
        setShippingId(null);
      }
    },
    []
  );

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
      const data = (await res.json().catch(() => null)) as { error?: string; resumed?: boolean } | null;
      if (!res.ok) throw new Error(data?.error ?? `reply failed (HTTP ${res.status})`);
      // A stored-but-not-resumed answer (loop already running) says so
      // honestly instead of implying work restarted.
      setResumeNote(
        data?.resumed === false
          ? 'Saved — a run is already going; your note applies on the next resume.'
          : null
      );
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
        const data = (await res.json().catch(() => null)) as { error?: string; resumed?: boolean } | null;
        if (!res.ok) throw new Error(data?.error ?? `choose failed (HTTP ${res.status})`);
        setResumeNote(
          data?.resumed === false
            ? 'Saved — a run is already going; your pick applies on the next resume.'
            : null
        );
        await fetchAll();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setChooseBusy(null);
      }
    },
    [chooseBusy, topicId, fetchAll]
  );

  // Filing the GitHub issue happens here, in the studio, with a named
  // consequence — never from a card. Filing can fail while shaping succeeds
  // (e.g. no service repo yet) — the banner carries the retry, and the
  // button below stays available until an issue exists.
  const [filedNote, setFiledNote] = useState<string | null>(null);
  const markReady = useCallback(async () => {
    if (readyBusy || !topic) return;
    const repo =
      project?.serviceRepoOwner && project?.serviceRepoName
        ? `${project.serviceRepoOwner}/${project.serviceRepoName}`
        : null;
    if (
      !window.confirm(
        `File a GitHub issue for "${topic.title}"${repo ? ` in ${repo}` : ''}? ` +
          `It will be public. Your shaped summary becomes the issue body — ` +
          `you can keep shaping before building.`
      )
    ) {
      return;
    }
    setReadyBusy(true);
    try {
      const res = await fetch(`/api/topics/${topicId}/ready`, { method: 'POST' });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
        promotion?: { ok: boolean; error?: string; issue?: Issue; created?: boolean };
      } | null;
      if (!res.ok) throw new Error(data?.error ?? `mark ready failed (HTTP ${res.status})`);
      if (data?.promotion && !data.promotion.ok) {
        setPromotionError(data.promotion.error ?? 'filing the GitHub issue failed');
        setFiledNote(null);
      } else {
        setPromotionError(null);
        const filed = data?.promotion && 'issue' in data.promotion ? data.promotion.issue : null;
        setFiledNote(
          filed
            ? `Filed as ${filed.owner}/${filed.repo} #${filed.number}${data?.promotion && 'created' in data.promotion && !data.promotion.created ? ' (already existed)' : ''} — keep shaping, or Build it when ready.`
            : 'Ready — the GitHub issue is filed. Keep shaping, or Build it when ready.'
        );
      }
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReadyBusy(false);
    }
  }, [readyBusy, topic, project, topicId, fetchAll]);

  const startRealize = useCallback(async () => {
    if (realizeBusy || !topic) return;
    // Every path states the itinerary before going hands-off: refine, build,
    // merge and release on its own, pinging only on needs-input.
    const draft = topic.status === 'new' || topic.status === 'shaping';
    if (
      !window.confirm(
        `${draft ? 'Build with the current draft? ' : ''}The hub will refine, build, merge and release on its own — pinging you only if it needs input.`
      )
    ) {
      return;
    }
    setRealizeBusy(true);
    try {
      const res = await fetch(`/api/topics/${topicId}/realize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `realize failed (HTTP ${res.status})`);
      }
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRealizeBusy(false);
    }
  }, [realizeBusy, topic, topicId, fetchAll]);

  if (!signedIn) {
    return (
      <div className="page-wrap">
        <AppHeader title="DevHub" />
        <main className="board-main">{!loading && <WelcomeScreen denied={denied} />}</main>
      </div>
    );
  }

  // Plain-words progress derived from the hidden execution layer (mirrors
  // realizeStage; the realizing button + timeline below consume it).
  const stage = topic ? stageFor(topic.status, issues) : null;
  const stagePos =
    stage === 'delivered' ? 3 : stage === 'checking' || stage === 'needs-input' ? 2 : stage === 'building' ? 1 : 0;

  return (
    <div className="page-wrap">
      <AppHeader
        back={{ href: project ? `/projects/${project.id}` : '/', label: project ? `Back to ${project.name}` : 'Back', onBack: goBack }}
        title={project?.name ?? 'Inbox'}
        status={topic ? <StatusPill status={deriveTopicDisplayStatus(topic.status, issues.map((i) => i.state))} /> : undefined}
        user={user ? { login: user.login, avatarUrl: user.avatarUrl, onLogout: logout } : undefined}
      />
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
              {topic.readyAt && <span title={topic.readyAt}>Ready {relTime(topic.readyAt)}</span>}
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
              <>
                {topic.status === 'realizing' && firstBlocked && (
                  <div className="topic-reply-target" role="status">
                    Answering{' '}
                    <a href={firstBlocked.htmlUrl} target="_blank" rel="noreferrer">
                      {firstBlocked.owner}/{firstBlocked.repo} #{firstBlocked.number}
                    </a>{' '}
                    — work resumes on its own.
                  </div>
                )}
                <div className="topic-reply">
                  <textarea
                    className="search topic-reply-input"
                    placeholder={
                      topic.status === 'realizing'
                        ? 'Answer the blocker — work resumes on its own'
                        : '…or describe it your way'
                    }
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
                {resumeNote && (
                  <div className="topic-resume-note" role="status">
                    {resumeNote}
                  </div>
                )}
              </>
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
            {promotionError && (
              <div className="banner" role="alert">
                <span>Ready, but filing the GitHub issue failed: {promotionError} — fix it, then retry below.</span>
                <button className="ghost" onClick={() => setPromotionError(null)}>
                  Dismiss
                </button>
              </div>
            )}
            {filedNote && (
              <div className="banner banner-success" role="status">
                <span>{filedNote}</span>
                <button className="ghost" onClick={() => setFiledNote(null)}>
                  Dismiss
                </button>
              </div>
            )}
            {(topic.status === 'realizing' || topic.status === 'shipped') && stage && (
              <div className="topic-timeline" role="status" aria-label="Realization progress">
                {TIMELINE_STEPS.map((step, idx) => (
                  <span
                    key={step}
                    className={`topic-step ${idx < stagePos ? 'done' : idx === stagePos ? (stage === 'needs-input' ? 'attention' : 'current') : 'todo'}`}
                  >
                    <span className="topic-step-dot">
                      {idx < stagePos || (step === 'delivered' && stage === 'delivered') ? '✓' : idx + 1}
                    </span>
                    {STAGE_LABELS[step]}
                  </span>
                ))}
                {stage === 'needs-input' && (
                  <span className="topic-timeline-note">Answer above — work resumes on its own.</span>
                )}
              </div>
            )}
            <div className="topic-detail-actions">
              {topic.status === 'shipped' ? (
                <span className="topic-delivered">Delivered ✓</span>
              ) : topic.status === 'dropped' ? null : topic.status === 'realizing' && stage !== 'needs-input' ? (
                <button type="button" className="card-primary" disabled title="Build running — progress streams in below">
                  {realizeBusy ? 'Starting…' : 'Building…'}
                </button>
              ) : (
                <button
                  type="button"
                  className="card-primary"
                  disabled={realizeBusy}
                  onClick={() => void startRealize()}
                  title="Refine, build, merge and release — hands-off, asks first"
                >
                  {realizeBusy ? 'Starting…' : stage === 'needs-input' ? 'Resume build' : 'Build it'}
                </button>
              )}
              {!threadLocked && (topic.status !== 'ready' || issues.length === 0) && (
                <button
                  type="button"
                  className="ghost"
                  disabled={readyBusy}
                  onClick={() => void markReady()}
                  title="Files a public GitHub issue with your shaped summary as the body"
                >
                  {readyBusy ? 'Filing…' : 'File GitHub issue'}
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
            {issues.length > 0 ? (
              <div className="topic-work-panel" aria-label="Work attached to this idea">
                <span className="released-label">Work ({issues.length})</span>
                <ul className="released-list">
                  {issues.map((i) => {
                    // De-dup: when one issue has the same title as its parent
                    // idea, show just the chip (the title is already in <h1>).
                    const titleMatches = issues.length === 1 && i.title === topic?.title;
                    return (
                      <li key={i.id} className="released-item">
                        <span className={`dot ${i.state}`} />
                        <a href={i.htmlUrl} target="_blank" rel="noreferrer" className="released-title topic-work-link">
                          {titleMatches ? (
                            <IssueRef issue={i} variant="chip" />
                          ) : (
                            <IssueRef issue={i} />
                          )}
                        </a>
                        {titleMatches && <StatusPill issueState={i.state} />}
                        <span className="topic-work-state">{TOPIC_WORK_STATE[i.state] ?? i.state}</span>
                      {(i.resultPrUrl || i.linkedPrUrl) && (
                        <a
                          className="ghost"
                          href={i.resultPrUrl ?? i.linkedPrUrl ?? ''}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Review PR ↗
                        </a>
                      )}
                      {i.blockedReason && (
                        <div className="topic-work-blocked" role="alert">
                          Needs input: {i.blockedReason}
                        </div>
                      )}
                      <IssueWorkDetail
                        issue={i}
                        events={issueEvents[i.id] ?? []}
                        runs={issueRuns[i.id] ?? []}
                        connected={connected}
                        onMarkShipped={() => void markShipped(i.id)}
                        shipping={shippingId === i.id}
                      />
                    </li>
                  );
                  })}
                </ul>
              </div>
            ) : (
              <details className="topic-how">
                <summary>How it was built</summary>
                <div className="empty">Nothing built yet — file the issue, then Build it from the actions above.</div>
              </details>
            )}
          </>
        )}
      </main>
    </div>
  );
}
