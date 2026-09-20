'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { Issue, IssueState, Topic } from '@/lib/types';
import {
  matchesIssue,
  matchesTopic,
  notifyStateChange,
  runSupersededByBroadcast,
} from '@/lib/board-ui';
import { funnelColumnForIssue, funnelColumnForTopicWithIssues } from '@/lib/funnel';
import { useAuth } from '@/components/use-auth';
import { WelcomeScreen } from '@/components/auth-ui';
import { AppHeader } from '@/components/app-header';
import { StatusPill } from '@/components/status-pill';
import { useMediaQuery, MOBILE_QUERY } from '@/components/board/use-media-query';
import { KanbanBoard } from '@/components/board/kanban-board';
import { RepoChips } from '@/components/board/board-toolbar';
import { DeliveredSection } from '@/components/board/delivered-section';
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
    autoMerge: boolean | null;
  }>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [query, setQuery] = useState('');
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [ideaOpen, setIdeaOpen] = useState(false);
  const [ideaTitle, setIdeaTitle] = useState('');
  const [ideaBusy, setIdeaBusy] = useState(false);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [autoMergeBusy, setAutoMergeBusy] = useState(false);

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
    () => issues.filter((i) => i.projectId === projectId && matchesIssue(i, query)),
    [issues, projectId, query]
  );

  // Linked issue states per topic: the funnel column of a topic follows its
  // work once promoted (backlog reads as ready, started work as realizing).
  const issueStatesByTopic = useMemo(() => {
    const map = new Map<number, IssueState[]>();
    for (const i of issues) {
      if (i.projectId !== projectId || i.topicId == null) continue;
      const arr = map.get(i.topicId) ?? [];
      arr.push(i.state);
      map.set(i.topicId, arr);
    }
    return map;
  }, [issues, projectId]);

  const columnOfTopic = useCallback(
    (t: Topic) => funnelColumnForTopicWithIssues(t.status, issueStatesByTopic.get(t.id) ?? []),
    [issueStatesByTopic]
  );

  // Live funnel pools vs delivered history (closed + rollout issues and
  // shipped/dropped topics render muted below the board, never as columns).
  const liveIssues = useMemo(
    () => scopedIssues.filter((i) => funnelColumnForIssue(i.state) !== 'delivered'),
    [scopedIssues]
  );
  const deliveredIssues = useMemo(
    () =>
      scopedIssues.filter(
        (i) =>
          (i.state === 'closed' || i.state === 'rollout') &&
          (!repoFilter || `${i.owner}/${i.repo}` === repoFilter)
      ),
    [scopedIssues, repoFilter]
  );
  // Once a topic has spawned an issue, the issue card is the live
  // representation of that work — a topic card next to it would just
  // duplicate the same idea on the board (and in delivered history).
  const visibleTopics = useMemo(
    () =>
      topics.filter((t) => {
        // Unified funnel Phase 4 rules:
        //   unlinked ideas ................................ visible (idea column)
        //   unshaped ideas w/ fresh backlog work ... visible (idea column)
        //   started (ready/realizing) ................. hidden — issue cards
        //                                               carry the work; the
        //                                               ⋯ menu has the studio row
        //   shipped/dropped .......................... visible — grouped into
        //                                               delivered ribbons below
        const column = columnOfTopic(t);
        const linked = (issueStatesByTopic.get(t.id) ?? []).length;
        if (linked === 0 || column === 'delivered') return true;
        return column === 'idea';
      }),
    [topics, issueStatesByTopic, columnOfTopic]
  );
  const liveTopics = useMemo(
    () => visibleTopics.filter((t) => columnOfTopic(t) !== 'delivered'),
    [visibleTopics, columnOfTopic]
  );
  const deliveredTopics = useMemo(
    () => visibleTopics.filter((t) => columnOfTopic(t) === 'delivered' && matchesTopic(t, query)),
    [visibleTopics, columnOfTopic, query]
  );

  const deliveredRef = useRef<HTMLElement | null>(null);
  const scrollToDone = useCallback(() => {
    // Ref-first with a DOM fallback: the section renders null when there is
    // no delivered history, so a stale/missing ref must not swallow the tap.
    const el = deliveredRef.current ?? document.querySelector('[aria-label="Delivered history"]');
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const repos = useMemo(() => {
    const set = new Set<string>();
    for (const i of scopedIssues) set.add(`${i.owner}/${i.repo}`);
    return Array.from(set).sort();
  }, [scopedIssues]);

  // Batch bar names the real direction (backlog → refinement reads forward,
  // refinement → backlog reads back — never the ambiguous "Advance").
  const selectedIssues = useMemo(() => issues.filter((i) => selectedIds.has(i.id)), [issues, selectedIds]);
  const advanceLabel =
    selectedIssues.length > 0 && selectedIssues.every((i) => i.state === 'backlog')
      ? `Move to Refinement (${selectedIds.size})`
      : selectedIssues.length > 0 && selectedIssues.every((i) => i.state === 'refinement')
        ? `Move to Backlog (${selectedIds.size})`
        : `Move (${selectedIds.size})`;

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

  // Error banners persist until dismissed or superseded — an 8s timer
  // risks hiding the failure from an operator who looked away.

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

  // Linked issues per topic for the card lineage line (idea → issue without
  // a drill-in). Filing happens inside the studio — the board only links.
  const linkedIssuesByTopic = useMemo(() => {
    const map = new Map<number, Issue[]>();
    for (const i of issues) {
      if (i.projectId !== projectId || i.topicId == null) continue;
      const arr = map.get(i.topicId) ?? [];
      arr.push(i);
      map.set(i.topicId, arr);
    }
    return map;
  }, [issues, projectId]);

  // Idea cards render inside KanbanBoard via the unified card shells (the
  // stage vocabulary lives in board-ui.ts, not per-page renderers).

  // Per-project auto-merge opt-out (devhub#171 Phase 4): off means Realize
  // stops at an open PR and a human merges + releases by hand.
  const toggleAutoMerge = useCallback(async () => {
    if (!project || autoMergeBusy) return;
    setAutoMergeBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoMerge: project.autoMerge === false }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `toggle failed (HTTP ${res.status})`);
      }
      const data = (await res.json()) as { project?: typeof project };
      if (data.project) setProject(data.project);
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setAutoMergeBusy(false);
    }
  }, [project, autoMergeBusy, projectId]);

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
        <AppHeader title="DevHub" />
        <main className="board-main">
          {!loading && <WelcomeScreen denied={denied} />}
        </main>
      </div>
    );
  }

  if (!validId || (projectError && !project)) {
    return (
      <div className="page-wrap">
        <AppHeader title="DevHub" />
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
      <AppHeader
        back={{ href: '/', label: 'Back to projects' }}
        title={project?.name ?? `Project #${projectId}`}
        status={project ? <StatusPill status={{ key: project.status === 'healthy' ? 'idea' : project.status === 'in-flight' ? 'realizing' : 'ready', label: statusBadge(project.status) }} /> : undefined}
        connection={{ connected }}
        user={user ? { login: user.login, avatarUrl: user.avatarUrl, onLogout: logout } : undefined}
        controls={
          <>
            {!isMobile && (
              <input
                className="search"
                placeholder="Search issues + ideas… e.g. repo:devhub status:shaping"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search issues and ideas"
              />
            )}
            {selectedIds.size > 0 && (
              <div className="batch-actions">
                <button className="develop-batch-btn" onClick={workSelected} disabled={refreshing}>
                  Work on selected ({selectedIds.size})
                </button>
                <button className="advance-btn" onClick={advanceSelected} disabled={refreshing}>
                  {advanceLabel}
                </button>
                <div className="keyboard-hints">
                  <span>Ctrl+Enter to move</span>
                  <span>Esc to clear</span>
                </div>
              </div>
            )}
          </>
        }
      />

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
        {project && (
          <div className="project-sub-line">
            <button
              type="button"
              className="ghost"
              disabled={autoMergeBusy}
              onClick={() => void toggleAutoMerge()}
              title={
                project.autoMerge === false
                  ? 'Realize stops at an open PR; you merge by hand'
                  : 'Realize merges green PRs and releases on its own'
              }
            >
              Auto-merge {autoMergeBusy ? '…' : project.autoMerge === false ? 'off' : 'on'}
            </button>
          </div>
        )}

        <KanbanBoard
          issues={liveIssues}
          topics={liveTopics}
          query={query}
          repoFilter={repoFilter}
          isMobile={isMobile}
          refreshing={refreshing}
          onRefresh={refresh}
          filterChips={
            isMobile ? (
              <RepoChips repos={repos} repoFilter={repoFilter} onRepoFilterChange={setRepoFilter} />
            ) : undefined
          }
          justStartedIds={justStartedIds}
          markJustStarted={markJustStarted}
          clearJustStarted={clearJustStarted}
          selectedIds={selectedIds}
          toggleSelection={toggleSelection}
          columnOfTopic={columnOfTopic}
          linkedIssues={linkedIssuesByTopic}
          columnExtras={{
            idea: (
              <div className="idea-col-actions">
                <button
                  type="button"
                  className="ghost"
                  disabled={suggestBusy}
                  onClick={() => void suggestNext()}
                  title="Propose the next feature as a suggested topic"
                >
                  {suggestBusy ? 'Suggesting…' : 'Suggest next'}
                </button>
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
            ),
          }}
          doneCount={deliveredIssues.length + deliveredTopics.length}
          onShowDone={scrollToDone}
        />
        <DeliveredSection issues={deliveredIssues} topics={deliveredTopics} sectionRef={deliveredRef} />
      </main>
    </div>
  );
}
