'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { Issue, IssueState, Topic } from '@/lib/types';
import { matchesIssue, notifyStateChange, runSupersededByBroadcast } from '@/lib/board-ui';
import { useAuth } from '@/components/use-auth';
import { Avatar, WelcomeScreen } from '@/components/auth-ui';
import { Logo } from '@/components/logo';
import { useMediaQuery, MOBILE_QUERY } from '@/components/board/use-media-query';
import { KanbanBoard } from '@/components/board/kanban-board';
import { BoardToolbar } from '@/components/board/board-toolbar';

// Staleness is irrelevant here; sorting/grouping is by status then recency.
const TOPIC_GROUPS: { status: Topic['status']; label: string }[] = [
  { status: 'idea', label: 'Ideas' },
  { status: 'active', label: 'Active' },
  { status: 'shipped', label: 'Shipped' },
];

function statusBadge(status: string | null): string {
  return status ?? 'stale';
}

export default function ProjectBoardPage() {
  const params = useParams<{ id: string }>();
  const projectId = Number(params.id);
  const validId = Number.isInteger(projectId) && projectId > 0;

  const [project, setProject] = useState<null | {
    id: number;
    name: string;
    domain: string | null;
    status: string | null;
    serviceRepoOwner: string | null;
    serviceRepoName: string | null;
  }>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [topicFilter, setTopicFilter] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [ideaOpen, setIdeaOpen] = useState(false);
  const [ideaTitle, setIdeaTitle] = useState('');
  const [ideaBusy, setIdeaBusy] = useState(false);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [promotingId, setPromotingId] = useState<number | null>(null);

  const { user, loading, denied, logout } = useAuth();
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const signedIn = Boolean(user);

  const prevStatesRef = useRef<Map<number, IssueState>>(new Map());
  const prevBlockedRef = useRef<Map<number, boolean>>(new Map());
  const batchStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [batchStatus, setBatchStatus] = useState<{
    operation: string;
    total: number;
    completed: number;
    errors: number;
  } | null>(null);
  const [justStartedIds, setJustStartedIds] = useState<Set<number>>(new Set());
  const markJustStarted = useCallback((id: number) => {
    setJustStartedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);
  const clearJustStarted = useCallback((id: number) => {
    setJustStartedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const toggleSelection = useCallback((issueId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(issueId)) next.delete(issueId);
      else next.add(issueId);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const fetchTopics = useCallback(async () => {
    if (!validId) return;
    try {
      const res = await fetch(`/api/topics?projectId=${projectId}`);
      if (res.ok) {
        const data = (await res.json()) as { topics?: Topic[] };
        if (data.topics) setTopics(data.topics);
      }
    } catch {
      // ignore
    }
  }, [projectId, validId]);

  // Initial load: project row + all issues (scoped client-side so SSE updates
  // for cards outside this project are ignored, not dropped).
  useEffect(() => {
    if (!signedIn || !validId) return;
    let active = true;
    Promise.all([
      fetch(`/api/projects/${projectId}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
      fetch('/api/issues').then((r) => r.json()),
    ])
      .then(([proj, iss]: [{ project: NonNullable<typeof project> | null }, { issues: Issue[] }]) => {
        if (!active) return;
        if (proj.project) setProject(proj.project);
        else setProjectError('project not found');
        setIssues(iss.issues);
        const prevState = prevStatesRef.current;
        const prevBlocked = prevBlockedRef.current;
        for (const i of iss.issues) {
          prevState.set(i.id, i.state);
          prevBlocked.set(i.id, Boolean(i.blockedReason));
        }
        setJustStartedIds(new Set());
      })
      .catch((err: unknown) => {
        if (active) setProjectError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [signedIn, validId, projectId]);

  useEffect(() => {
    if (!signedIn || !validId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchTopics();
  }, [signedIn, validId, fetchTopics]);

  // Live updates: only issues belonging to this project touch the board; a
  // `topic`/`project` id-notification refreshes the rail; a `run` event
  // re-fetches the issue list so per-run PR chips stay live (devhub#167).
  const refetchIssues = useCallback(async () => {
    try {
      const res = await fetch('/api/issues');
      if (!res.ok) return;
      const data = (await res.json()) as { issues: Issue[] };
      setIssues(data.issues);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!signedIn || !validId) return;
    const es = new EventSource('/api/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'issue') {
          const issue = msg.issue as Issue;
          if (issue.projectId !== projectId) return;
          const prevState = prevStatesRef.current.get(issue.id);
          const prevBlocked = prevBlockedRef.current.get(issue.id) ?? false;
          const nowBlocked = Boolean(issue.blockedReason);
          prevStatesRef.current.set(issue.id, issue.state);
          prevBlockedRef.current.set(issue.id, nowBlocked);
          if ((prevState !== undefined && prevState !== issue.state && issue.state === 'pr') || (nowBlocked && !prevBlocked)) {
            notifyStateChange(issue);
          }
          if (runSupersededByBroadcast(issue)) clearJustStarted(issue.id);
          setIssues((prev) => {
            const idx = prev.findIndex((i) => i.id === issue.id);
            if (idx === -1) return [issue, ...prev];
            const next = prev.slice();
            next[idx] = issue;
            return next;
          });
        } else if (msg.type === 'topic' || msg.type === 'project') {
          void fetchTopics();
        } else if (msg.type === 'run') {
          void refetchIssues();
        }
      } catch {
        // ignore malformed
      }
    };
    return () => es.close();
  }, [signedIn, validId, projectId, clearJustStarted, fetchTopics, refetchIssues]);

  const scopedIssues = useMemo(
    () =>
      issues.filter(
        (i) =>
          i.projectId === projectId &&
          (!topicFilter || i.topicId === topicFilter) &&
          matchesIssue(i, query)
      ),
    [issues, projectId, topicFilter, query]
  );

  const repos = useMemo(() => {
    const set = new Set<string>();
    for (const i of scopedIssues) set.add(`${i.owner}/${i.repo}`);
    return Array.from(set).sort();
  }, [scopedIssues]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/issues', { method: 'POST' });
      if (!res.ok) {
        let detail = '';
        try {
          const data = (await res.json()) as { error?: string };
          detail = data.error ?? '';
        } catch {
          // non-JSON body
        }
        throw new Error(detail || `refresh failed (HTTP ${res.status})`);
      }
      setRefreshError(null);
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!refreshError) return;
    const t = setTimeout(() => setRefreshError(null), 8000);
    return () => clearTimeout(t);
  }, [refreshError]);

  const addIdea = useCallback(async () => {
    const title = ideaTitle.trim();
    if (!title || ideaBusy) return;
    setIdeaBusy(true);
    try {
      const res = await fetch('/api/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, projectId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `add idea failed (HTTP ${res.status})`);
      }
      setIdeaTitle('');
      setIdeaOpen(false);
      await fetchTopics();
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setIdeaBusy(false);
    }
  }, [ideaTitle, ideaBusy, projectId, fetchTopics]);

  const suggestNext = useCallback(async () => {
    if (!validId || suggestBusy) return;
    setSuggestBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/suggest`, { method: 'POST' });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `suggest failed (HTTP ${res.status})`);
      }
      await fetchTopics();
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setSuggestBusy(false);
    }
  }, [validId, projectId, suggestBusy, fetchTopics]);

  const promoteTopic = useCallback(
    async (topicId: number) => {
      setPromotingId(topicId);
      try {
        const res = await fetch(`/api/topics/${topicId}/promote`, { method: 'POST' });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error ?? `promote failed (HTTP ${res.status})`);
        }
        await fetchTopics();
        await refetchIssues();
      } catch (err) {
        setRefreshError(err instanceof Error ? err.message : String(err));
      } finally {
        setPromotingId(null);
      }
    },
    [fetchTopics, refetchIssues]
  );

  const advanceSelected = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const total = selectedIds.size;
    setBatchStatus({ operation: 'advancing', total, completed: 0, errors: 0 });
    setRefreshing(true);
    try {
      const res = await fetch('/api/issues/batch-advance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueIds: Array.from(selectedIds) }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || `batch advance failed (HTTP ${res.status})`);
      }
      const result = (await res.json()) as { results: Array<{ id: number; success: boolean }> };
      const completed = result.results.filter((r) => r.success).length;
      setBatchStatus({ operation: 'advancing', total, completed, errors: total - completed });
      clearSelection();
      setRefreshError(null);
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
      if (batchStatusTimerRef.current) clearTimeout(batchStatusTimerRef.current);
      batchStatusTimerRef.current = setTimeout(() => setBatchStatus(null), 3000);
    }
  }, [selectedIds, clearSelection]);

  const workSelected = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const total = selectedIds.size;
    setBatchStatus({ operation: 'working', total, completed: 0, errors: 0 });
    setRefreshing(true);
    try {
      const res = await fetch('/api/issues/batch-advance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueIds: Array.from(selectedIds), mode: 'work' }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        results?: Array<{ id: number; success: boolean; error?: string; mode?: string }>;
      };
      if (!res.ok) throw new Error(data.error || `batch work failed (HTTP ${res.status})`);
      const succeeded = data.results?.filter((r) => r.success).length ?? 0;
      const failed = data.results?.filter((r) => !r.success) ?? [];
      for (const r of data.results ?? []) {
        if (r.success && r.mode === 'working') markJustStarted(r.id);
      }
      setBatchStatus({ operation: 'working', total, completed: succeeded, errors: failed.length });
      setRefreshError(
        failed.length > 0
          ? `Work started for ${succeeded} issue(s), ${failed.length} failed: ${failed.map((f) => `#${f.id} (${f.error})`).join(', ')}`
          : null
      );
      clearSelection();
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
      if (batchStatusTimerRef.current) clearTimeout(batchStatusTimerRef.current);
      batchStatusTimerRef.current = setTimeout(() => setBatchStatus(null), 3000);
    }
  }, [selectedIds, clearSelection, markJustStarted]);

  // Batch keyboard shortcuts, scoped to the visible project cards.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !isInput) {
        e.preventDefault();
        setSelectedIds(new Set(scopedIssues.map((i) => i.id)));
      }
      if (e.key === 'Escape') clearSelection();
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && selectedIds.size > 0) {
        e.preventDefault();
        void advanceSelected();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [scopedIssues, selectedIds, clearSelection, advanceSelected]);

  useEffect(() => {
    return () => {
      if (batchStatusTimerRef.current) clearTimeout(batchStatusTimerRef.current);
    };
  }, []);

  if (!signedIn) {
    return (
      <div className="page-wrap">
        <header className="app-head">
          <div className="brand">
            <Logo size={28} />
            <span className="brand-name">DevHub</span>
          </div>
        </header>
        <main className="board-main">
          {!loading && <WelcomeScreen denied={denied} />}
        </main>
      </div>
    );
  }

  if (!validId || (projectError && !project)) {
    return (
      <div className="page-wrap">
        <header className="app-head">
          <div className="brand">
            <Logo size={28} />
            <span className="brand-name">DevHub</span>
          </div>
        </header>
        <main className="board-main">
          <div className="banner" role="alert">
            <span>{projectError ?? 'Unknown project.'}</span>
            <Link href="/">Back to projects</Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="page-wrap">
      <header className="app-head">
        <div className="brand">
          <Link href="/" className="recap-link" aria-label="Back to projects">
            ←
          </Link>
          <Logo size={28} />
          <span className="brand-name">{project?.name ?? `Project #${projectId}`}</span>
          {project && <span className={`proj-badge ${statusBadge(project.status)}`}>{statusBadge(project.status)}</span>}
        </div>
        <div className="head-controls">
          {!isMobile && (
            <input
              className="search"
              placeholder="Search… e.g. repo:devhub title:auth"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          <span
            className={`conn-status ${connected ? 'ok' : 'off'}`}
            title={connected ? 'live' : 'connecting…'}
            aria-label={connected ? 'live' : 'connecting…'}
            role="status"
          >
            <span className="conn-dot" />
            {connected ? 'live' : 'connecting…'}
          </span>
          {user && (
            <>
              <Avatar login={user.login} avatarUrl={user.avatarUrl} />
              <span className="auth-login">{user.login}</span>
              <button className="header-icon-btn" onClick={logout} aria-label="Sign out">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M2 2.75C2 1.784 2.784 1 3.75 1h2.5a.75.75 0 010 1.5h-2.5a.25.25 0 00-.25.25v10.5c0 .138.112.25.25.25h2.5a.75.75 0 010 1.5h-2.5A1.75 1.75 0 012 13.25V2.75zm10.44 4.5H6.75a.75.75 0 000 1.5h5.69l-1.97 1.97a.75.75 0 101.06 1.06l3.25-3.25a.75.75 0 000-1.06l-3.25-3.25a.75.75 0 10-1.06 1.06l1.97 1.97z"/>
                </svg>
              </button>
            </>
          )}
          {selectedIds.size > 0 && (
            <div className="batch-actions">
              <button className="develop-batch-btn" onClick={workSelected} disabled={refreshing}>
                Work on selected ({selectedIds.size})
              </button>
              <button className="advance-btn" onClick={advanceSelected} disabled={refreshing}>
                Advance selected ({selectedIds.size})
              </button>
              <div className="keyboard-hints">
                <span>Ctrl+Enter to advance</span>
                <span>Esc to clear</span>
              </div>
            </div>
          )}
        </div>
      </header>

      <main className="board-main">
        {refreshError && (
          <div className="banner" role="alert">
            <span>
              {refreshError}
              {/401|auth/i.test(refreshError) && (
                <> — <a href="/api/auth/login" style={{ color: 'inherit', textDecoration: 'underline' }}>log in again</a></>
              )}
            </span>
            <button className="ghost" onClick={() => setRefreshError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {batchStatus && (
          <div className="batch-status">
            <span>{batchStatus.operation}: {batchStatus.completed}/{batchStatus.total}</span>
            {batchStatus.errors > 0 && <span className="batch-errors">({batchStatus.errors} errors)</span>}
          </div>
        )}

        {project?.domain && <div className="project-domain-line">{project.domain}</div>}

        <div className="topics-rail" role="toolbar" aria-label="Topics">
          <span className="released-label">Topics</span>
          <button type="button" className="ghost" disabled={suggestBusy} onClick={() => void suggestNext()} title="Propose the next feature as a suggested topic">
            {suggestBusy ? 'Suggesting…' : 'Suggest next'}
          </button>
          <div className="topics-groups">
            {TOPIC_GROUPS.map(({ status, label }) => {
              const items = topics.filter((t) => t.status === status);
              if (items.length === 0) return null;
              return (
                <div className="topics-group" key={status}>
                  <span className="topics-group-label">{label}</span>
                  <div className="topics-chips">
                    {items.map((t) => (
                      <span key={t.id} className="topic-chip-wrap">
                        <button
                          className={`topic-chip${topicFilter === t.id ? ' active' : ''}`}
                          onClick={() => setTopicFilter(topicFilter === t.id ? null : t.id)}
                          title={t.notes ?? t.title}
                        >
                          {t.title}
                        </button>
                        {(status === 'idea' || status === 'shipped') && (
                          <button
                            type="button"
                            className="ghost topic-promote"
                            disabled={promotingId === t.id}
                            onClick={() => void promoteTopic(t.id)}
                            title={status === 'idea' ? 'Promote to a GitHub issue' : 'Promote again as a follow-up issue'}
                          >
                            {promotingId === t.id ? '…' : '→ issue'}
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
            {topics.length === 0 && <span className="topics-empty">no topics yet — add an idea</span>}
          </div>
          {ideaOpen ? (
            <span className="topics-idea-form">
              <input
                className="search"
                placeholder="Idea title…"
                value={ideaTitle}
                autoFocus
                onChange={(e) => setIdeaTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addIdea();
                  if (e.key === 'Escape') {
                    setIdeaOpen(false);
                    setIdeaTitle('');
                  }
                }}
              />
              <button type="button" className="card-primary" disabled={!ideaTitle.trim() || ideaBusy} onClick={() => void addIdea()}>
                {ideaBusy ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setIdeaOpen(false);
                  setIdeaTitle('');
                }}
              >
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" className="ghost" onClick={() => setIdeaOpen(true)}>
              + Add idea
            </button>
          )}
        </div>

        {topicFilter != null && (
          <div className="project-filter-banner" role="status">
            <span>
              Showing issues for topic <strong>#{topicFilter}</strong>.
            </span>
            <button className="ghost" onClick={() => setTopicFilter(null)}>
              Show all
            </button>
          </div>
        )}

        <KanbanBoard
          issues={scopedIssues}
          query={query}
          repoFilter={repoFilter}
          isMobile={isMobile}
          toolbar={
            <BoardToolbar
              repos={repos}
              repoFilter={repoFilter}
              onRepoFilterChange={setRepoFilter}
              lastRefreshed={null}
              refreshing={refreshing}
              onRefresh={refresh}
              showLastRefreshed={false}
            />
          }
          justStartedIds={justStartedIds}
          markJustStarted={markJustStarted}
          clearJustStarted={clearJustStarted}
          selectedIds={selectedIds}
          toggleSelection={toggleSelection}
        />
      </main>
    </div>
  );
}
