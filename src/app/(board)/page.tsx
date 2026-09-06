'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Issue, IssueState } from '@/lib/types';
import { countRepos, matchesIssue } from '@/lib/board-ui';
import { useAuth } from '@/components/use-auth';
import { Avatar, WelcomeScreen } from '@/components/auth-ui';
import { Logo } from '@/components/logo';
import { CockpitComposer } from '@/components/board/cockpit-composer';
import { ActionDetail } from '@/components/board/action-detail';
import { useKeyboardInset } from '@/components/board/use-keyboard-inset';
import type { ModelOption } from '@/lib/types';
import { useMediaQuery, MOBILE_QUERY } from '@/components/board/use-media-query';
import { MobileStatusStrip, statusPanelId, statusTabId } from '@/components/board/mobile-status-strip';
import { MobileSearchSheet } from '@/components/board/mobile-search-sheet';
import { ProjectsHome } from '@/components/board/projects-home';
import { BoardToolbar } from '@/components/board/board-toolbar';
import { RecentlyClosed, RecentlyReleased } from '@/components/board/released-strips';
import { IssueCard, IssueCardSheet, MobileIssueCard } from '@/components/board/issue-card';
import {
  ActionStatusStrip,
  actionFromApi,
  isTerminalActionStatus,
  mergeAction,
  type ApiActionRow,
  type CockpitAction,
} from '@/components/board/action-status-strip';

const COLUMNS: IssueState[] = ['backlog', 'refinement', 'developing', 'pr'];

// A "just started" flag outlives the initial click: the develop route returns
// 202 before startWork broadcasts anything, and a backlog card's first
// broadcast (backlog → refinement) still leaves the run live. The flag is
// dropped only when a broadcast shows the server has taken over with its own
// live signal or the run has stopped:
//   developing            → run confirmed live (or failed — blocked drives UI)
//   pr/rollout/closed     → run finished
//   blocked_reason set    → run stopped, "Needs input" + Work must return
// A bare refinement/backlog broadcast (the initial stage move, session-id
// updates) leaves the flag in place — the run is still going.
function runSupersededByBroadcast(issue: Pick<Issue, 'state' | 'blockedReason'>): boolean {
  if (issue.state === 'developing' || issue.state === 'pr' || issue.state === 'rollout' || issue.state === 'closed') {
    return true;
  }
  return Boolean(issue.blockedReason);
}

// Fire a browser notification when a card lands in a state that needs the
// operator's attention (PR opened = success, blocked_reason = needs input).
// Only fires for changes seen live over SSE; existing cards on load are not
// re-notified.
function notifyStateChange(issue: Issue): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  const blocked = Boolean(issue.blockedReason);
  const title = blocked
    ? 'DevHub: needs input'
    : issue.state === 'pr'
      ? 'DevHub: pull request opened'
      : `DevHub: ${issue.state}`;
  const body = `${issue.owner}/${issue.repo} #${issue.number}: ${issue.title}`;
  try {
    new Notification(title, { body, tag: `devhub-${issue.id}-${blocked ? 'blocked' : issue.state}` });
  } catch {
    // ignore
  }
}

export default function BoardPage() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [connected, setConnected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  // Projects home (devhub#167): scoping the kanban to one project. Null = all.
  const [projectFilter, setProjectFilter] = useState<number | null>(null);
  // Bumped on refresh + live issue SSE so the project cards re-fetch.
  const [projectTick, setProjectTick] = useState(0);
  const [sorts, setSorts] = useState<Partial<Record<IssueState, 'newest' | 'oldest'>>>({});
  const [searchHelp, setSearchHelp] = useState(false);
  const [activeColumn, setActiveColumn] = useState<IssueState>('backlog');
  const [openActionsFor, setOpenActionsFor] = useState<Issue | null>(null);
  const [searchSheetOpen, setSearchSheetOpen] = useState(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const columnRefs = useRef<Map<IssueState, HTMLElement>>(new Map());
  const helpRef = useRef<HTMLDivElement>(null);
  const { user, loading, denied, logout } = useAuth();
  const isMobile = useMediaQuery(MOBILE_QUERY);
  // Last-seen state / blocked flag per issue, so live transitions to pr or a
  // newly-set blocked_reason can be told apart from cards that already were
  // in that situation on load.
  const prevStatesRef = useRef<Map<number, IssueState>>(new Map());
  const prevBlockedRef = useRef<Map<number, boolean>>(new Map());
  const batchStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Runs started from this client whose confirmation hasn't arrived via SSE
  // yet (the develop route is fire-and-forget: 202 first, broadcast later).
  // While an id is set here its card must show live/recap affordances instead
  // of the Work button — see runSupersededByBroadcast for when the server's
  // own state takes over again.
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

  // Batch selection state
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [batchStatus, setBatchStatus] = useState<{
    operation: string;
    total: number;
    completed: number;
    errors: number;
  } | null>(null);

  // Cockpit input bar — one shared composer (multiline prompt + model
  // override) rendered in both shells: the mobile FAB bottom sheet and the
  // desktop expanded form. Submitting keeps the shell open and the text
  // intact on failure; on success the detail view opens for the new action.
  const [actionInput, setActionInput] = useState('');
  const [cockpitOpen, setCockpitOpen] = useState(false);
  const [submittingAction, setSubmittingAction] = useState(false);
  const [cockpitModel, setCockpitModel] = useState<ModelOption | null>(null);
  // Lineage for a rerun: seeds POST /api/action params so the new row is
  // traceable to the action whose prompt was adjusted.
  const [retryOfId, setRetryOfId] = useState<number | null>(null);
  // Desktop cockpit starts collapsed to a trigger pill, same instinct as
  // mobile's FAB+sheet: don't spend fixed vertical space until it's wanted.
  const [desktopCockpitOpen, setDesktopCockpitOpen] = useState(false);
  // Recent cockpit actions with live status: hydrated from GET /api/action on
  // load, updated by `type:'action'` SSE broadcasts, and drilled into
  // GET /api/action/[id] for summary/duration when we lack the row.
  const [actions, setActions] = useState<CockpitAction[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  // Currently-open action detail view (null = closed). The strip items, the
  // error banner's "Details" affordance and a successful submit all open it.
  const [detailActionId, setDetailActionId] = useState<number | null>(null);
  // Model picker data for the cockpit (shared with the develop modal's
  // endpoint): the list plus the operator's last-used default.
  const [models, setModels] = useState<ModelOption[]>([]);
  const knownActionIdsRef = useRef<Set<number>>(new Set());
  const actionDetailFetchedRef = useRef<Set<string>>(new Set());
  const keyboardInset = useKeyboardInset();

  const toggleSelection = useCallback((issueId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(issueId)) {
        next.delete(issueId);
      } else {
        next.add(issueId);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const signedIn = Boolean(user);

  // Issues scoped to the selected project card (the Released/Closed strips
  // below stay global; the kanban columns, counts, repo chips and Ctrl+A
  // follow the selection).
  const scopedIssues = useMemo(
    () => (projectFilter == null ? issues : issues.filter((i) => i.projectId === projectFilter)),
    [issues, projectFilter]
  );

  const repos = useMemo(() => {
    const set = new Set<string>();
    for (const i of scopedIssues) set.add(`${i.owner}/${i.repo}`);
    return Array.from(set).sort();
  }, [scopedIssues]);

  const upsert = useCallback((issue: Issue) => {
    setIssues((prev) => {
      const idx = prev.findIndex((i) => i.id === issue.id);
      if (idx === -1) return [issue, ...prev];
      const next = prev.slice();
      next[idx] = issue;
      return next;
    });
  }, []);

  // Drill into GET /api/action/[id] for the full row (input text, stored
  // summary, duration). Used when an SSE broadcast references an action this
  // client doesn't know, and when an action finishes so the broadcast's terse
  // detail can be upgraded to the stored summary.
  const hydrateAction = useCallback(async (actionId: number) => {
    try {
      const res = await fetch(`/api/action/${actionId}`);
      if (!res.ok) return;
      const data = (await res.json()) as { action?: ApiActionRow };
      const row = data.action;
      if (!row || typeof row.id !== 'number') return;
      setActions((prev) => {
        const idx = prev.findIndex((a) => a.id === row.id);
        if (idx === -1) return prev;
        const next = prev.slice();
        next[idx] = mergeAction(next[idx], row);
        return next;
      });
    } catch {
      // ignore
    }
  }, []);

  // Recent action history so past cockpit runs are discoverable on load.
  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    fetch('/api/action?limit=20')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { actions?: ApiActionRow[] } | null) => {
        const rows = data?.actions;
        if (!active || !rows) return;
        knownActionIdsRef.current = new Set(rows.map((a) => a.id));
        setActions((prev) => {
          const byId = new Map(prev.map((a) => [a.id, a] as const));
          for (const row of rows) {
            const existing = byId.get(row.id);
            byId.set(row.id, existing ? mergeAction(existing, row) : actionFromApi(row));
          }
          return Array.from(byId.values()).sort((a, b) => b.id - a.id);
        });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [signedIn]);

  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    fetch('/api/issues')
      .then((r) => r.json())
      .then((data: { issues: Issue[] }) => {
        if (active) {
          setIssues(data.issues);
          setLastRefreshed(new Date());
          // Server state is authoritative on (re)load — drop any optimistic
          // just-started flags from before.
          setJustStartedIds(new Set());
          const prevState = prevStatesRef.current;
          const prevBlocked = prevBlockedRef.current;
          for (const i of data.issues) {
            prevState.set(i.id, i.state);
            prevBlocked.set(i.id, Boolean(i.blockedReason));
          }
        }
      })
      .catch(() => {});

    const es = new EventSource('/api/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'issue') {
          const issue = msg.issue as Issue;
          const prevState = prevStatesRef.current.get(issue.id);
          const prevBlocked = prevBlockedRef.current.get(issue.id) ?? false;
          const nowBlocked = Boolean(issue.blockedReason);
          prevStatesRef.current.set(issue.id, issue.state);
          prevBlockedRef.current.set(issue.id, nowBlocked);
          const stateChanged = prevState !== undefined && prevState !== issue.state;
          // Notify on a state transition into `pr` or when a card newly needs
          // input (including develop-stage failures, where the state itself
          // doesn't change).
          if ((stateChanged && issue.state === 'pr') || (nowBlocked && !prevBlocked)) {
            notifyStateChange(issue);
          }
          if (runSupersededByBroadcast(issue)) clearJustStarted(issue.id);
          upsert(issue);
          setProjectTick((t) => t + 1);
        } else if (msg.type === 'project' || msg.type === 'topic' || msg.type === 'run') {
          // Project cockpit id-notification (see sse.ts): the cards + inbox
          // re-fetch via refreshKey.
          setProjectTick((t) => t + 1);
        } else if (msg.type === 'action') {
          const actionId = Number(msg.actionId);
          const status = String(msg.status);
          const detail = typeof msg.detail === 'string' ? msg.detail : null;
          if (!Number.isInteger(actionId) || actionId <= 0) return;
          const known = knownActionIdsRef.current.has(actionId);
          knownActionIdsRef.current.add(actionId);
          setActions((prev) => {
            const idx = prev.findIndex((a) => a.id === actionId);
            if (idx === -1) {
              return [{ id: actionId, input: `Action #${actionId}`, status, detail, durationMs: null }, ...prev];
            }
            const next = prev.slice();
            const current = next[idx];
            next[idx] = {
              ...current,
              status,
              detail: detail ?? current.detail,
              durationMs: isTerminalActionStatus(status) ? null : current.durationMs,
            };
            return next;
          });
          // Fetch the stored row when we don't know the action (fills the
          // input text) or when it finishes (fills summary + duration).
          const phase = isTerminalActionStatus(status) ? 'final' : 'initial';
          const key = `${actionId}:${phase}`;
          if ((!known || phase === 'final') && !actionDetailFetchedRef.current.has(key)) {
            actionDetailFetchedRef.current.add(key);
            void hydrateAction(actionId);
          }
        }
      } catch {
        // ignore malformed
      }
    };
    return () => {
      active = false;
      es.close();
    };
  }, [signedIn, upsert, hydrateAction, clearJustStarted]);

  useEffect(() => {
    if (!signedIn) return;
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }, [signedIn]);

  useEffect(() => {
    if (!refreshError) return;
    const t = setTimeout(() => setRefreshError(null), 8000);
    return () => clearTimeout(t);
  }, [refreshError]);

  useEffect(() => {
    if (!actionError) return;
    const t = setTimeout(() => setActionError(null), 8000);
    return () => clearTimeout(t);
  }, [actionError]);

  useEffect(() => {
    return () => {
      if (batchStatusTimerRef.current) clearTimeout(batchStatusTimerRef.current);
    };
  }, []);

  // Model list for the cockpit picker. The endpoint returns the full server
  // registry plus the operator's last-used default (set by a develop run or a
  // cockpit run with an override).
  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    fetch('/api/models')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { models?: ModelOption[]; default?: ModelOption | null } | null) => {
        if (!active) return;
        if (data?.models) setModels(data.models);
        if (data?.default !== undefined) setCockpitModel(data.default ?? null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [signedIn]);

  const submitAction = useCallback(async () => {
    const input = actionInput.trim();
    if (!input) return;
    setSubmittingAction(true);
    try {
      const body: {
        input: string;
        params?: Record<string, unknown>;
        modelId?: string;
        providerID?: string;
      } = { input };
      if (retryOfId != null) body.params = { retryOf: retryOfId };
      if (cockpitModel) {
        body.modelId = cockpitModel.id;
        body.providerID = cockpitModel.providerID;
      }
      const res = await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; actionId?: number; error?: string }
        | null;
      if (!res.ok || !data?.ok || typeof data.actionId !== 'number') {
        // The prompt stays in the composer for adjustment (rerun-ready).
        setActionError(data?.error ?? `action failed (HTTP ${res.status})`);
        return;
      }
      // Optimistically surface the action as pending; the `type:'action'`
      // SSE broadcasts (starting immediately on the server) keep it live.
      knownActionIdsRef.current.add(data.actionId);
      const actionId = data.actionId;
      setActions((prev) =>
        prev.some((a) => a.id === actionId)
          ? prev
          : [{ id: actionId, input, status: 'pending', detail: null, durationMs: null }, ...prev]
      );
      // Success: clear the composer and hand over to the detail view so the
      // prompt, result and transcript stay fully visible while the run goes.
      setActionInput('');
      setRetryOfId(null);
      setCockpitOpen(false);
      setDesktopCockpitOpen(false);
      setDetailActionId(actionId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingAction(false);
    }
  }, [actionInput, cockpitModel, retryOfId]);

  // Rerun: seed the composer with the old prompt + its model override, mark
  // the lineage, and let the next submit create a fresh action.
  const rerunAction = useCallback(
    (input: string, model: ModelOption | null, retryOf: number) => {
      setActionInput(input);
      setCockpitModel(model);
      setRetryOfId(retryOf);
      setDetailActionId(null);
      if (isMobile) setCockpitOpen(true);
      else setDesktopCockpitOpen(true);
    },
    [isMobile]
  );

  useEffect(() => {
    if (!searchHelp) return;
    const onDown = (e: MouseEvent) => {
      if (helpRef.current && !helpRef.current.contains(e.target as Node)) setSearchHelp(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSearchHelp(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [searchHelp]);

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
        const data = await res.json() as { error?: string };
        throw new Error(data.error || `batch advance failed (HTTP ${res.status})`);
      }

      const result = await res.json() as { results: Array<{ id: number; success: boolean; error?: string }> };
      const completed = result.results.filter((r) => r.success).length;
      const errors = result.results.filter((r) => !r.success).length;

      setBatchStatus({ operation: 'advancing', total, completed, errors });
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
        body: JSON.stringify({
          issueIds: Array.from(selectedIds),
          mode: 'work'
        }),
      });

      const data = await res.json() as {
        ok?: boolean;
        error?: string;
        results?: Array<{ id: number; success: boolean; error?: string; mode?: string }>;
      };

      if (!res.ok) {
        throw new Error(data.error || `batch work failed (HTTP ${res.status})`);
      }

      const succeeded = data.results?.filter((r) => r.success).length ?? 0;
      const failed = data.results?.filter((r) => !r.success) ?? [];
      // Optimistically flip successful starts to their live/recap card state;
      // SSE broadcasts (and runSupersededByBroadcast) take over from here.
      for (const r of data.results ?? []) {
        if (r.success && r.mode === 'working') markJustStarted(r.id);
      }

      setBatchStatus({ operation: 'working', total, completed: succeeded, errors: failed.length });
      const summary = failed.length > 0
        ? `Work started for ${succeeded} issue(s), ${failed.length} failed: ${failed.map((f) => `#${f.id} (${f.error})`).join(', ')}`
        : null;

      setRefreshError(summary);
      clearSelection();
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
      if (batchStatusTimerRef.current) clearTimeout(batchStatusTimerRef.current);
      batchStatusTimerRef.current = setTimeout(() => setBatchStatus(null), 3000);
    }
  }, [selectedIds, clearSelection, markJustStarted]);

  // Keyboard shortcuts for batch operations
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      // Ctrl/Cmd + A to select all visible issues (skip when in a text input)
      if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !isInput) {
        e.preventDefault();
        const visibleIssues = scopedIssues.filter((i) => matchesIssue(i, query));
        setSelectedIds(new Set(visibleIssues.map((i) => i.id)));
      }

      // Escape to clear selection
      if (e.key === 'Escape') {
        clearSelection();
      }

      // Ctrl/Cmd + Enter to advance selected
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && selectedIds.size > 0) {
        e.preventDefault();
        advanceSelected();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [scopedIssues, query, selectedIds, clearSelection, advanceSelected]);

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
      setLastRefreshed(new Date());
      setProjectTick((t) => t + 1);
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // Tab state on mobile is driven directly by the status strip (only one
    // column is ever rendered), so the scroll-position sync below is only
    // needed on desktop where all five columns share the screen.
    if (typeof window === 'undefined' || isMobile) return;

    const observer = new IntersectionObserver(
      (entries) => {
        let best: { col: IssueState; ratio: number } | null = null;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          let col: IssueState | null = null;
          for (const [c, el] of columnRefs.current.entries()) {
            if (el === entry.target) {
              col = c;
              break;
            }
          }
          if (col && (!best || entry.intersectionRatio > best.ratio)) {
            best = { col, ratio: entry.intersectionRatio };
          }
        }
        if (best) setActiveColumn(best.col);
      },
      // Shrink the board viewport to a center band so a column counts as
      // active when it crosses the middle of the screen rather than when 50%
      // of its (potentially much taller) total height is visible. Per-batch
      // max-ratio selection avoids callbacks clobbering each other mid-swipe.
      { root: boardRef.current, rootMargin: '-45% 0px -45% 0px', threshold: 0 }
    );

    columnRefs.current.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [signedIn, isMobile]);

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

  return (
    <div className="page-wrap">
      <header className="app-head">
        <div className="brand">
          <Logo size={28} />
          <span className="brand-name">DevHub</span>
        </div>
        <div className="head-controls">
          <div className="search-wrapper">
            {isMobile ? (
              <button
                className="search-mobile-trigger"
                onClick={() => setSearchSheetOpen(true)}
                aria-label="Search issues"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M10.68 11.74a6 6 0 01-7.922-8.982 6 6 0 018.982 7.922l3.04 3.04a.749.749 0 01-1.06 1.06zM11.5 7a4.5 4.5 0 10-9 0 4.5 4.5 0 009 0z" />
                </svg>
                <span>{query || 'Search issues'}</span>
              </button>
            ) : (
              <>
                <input
                  className="search"
                  placeholder="Search… e.g. repo:devhub title:auth"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <div className="search-help" ref={helpRef}>
                  <button
                    className="search-help-btn"
                    onClick={() => setSearchHelp((h) => !h)}
                    aria-label="Search syntax help"
                    aria-expanded={searchHelp}
                  >
                    ?
                  </button>
                  {searchHelp && (
                    <div className="search-help-menu">
                      <div className="search-help-title">Search filters</div>
                      <div className="search-help-item"><code>repo:</code> match repo name</div>
                      <div className="search-help-item"><code>title:</code> match title</div>
                      <div className="search-help-item"><code>owner:</code> match owner</div>
                      <div className="search-help-item"><code>state:</code> match state</div>
                      <div className="search-help-item"><code>body:</code> match body</div>
                      <div className="search-help-item"><code>number:</code> match issue #</div>
                      <div className="search-help-note">Combine filters with plain text. e.g. repo:web auth</div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
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
              <button
                className="develop-batch-btn"
                onClick={workSelected}
                disabled={refreshing}
              >
                Work on selected ({selectedIds.size})
              </button>
              <button
                className="advance-btn"
                onClick={advanceSelected}
                disabled={refreshing}
              >
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
            Refresh failed: {refreshError}
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
          {batchStatus.errors > 0 && (
            <span className="batch-errors">({batchStatus.errors} errors)</span>
          )}
        </div>
      )}

      {actionError && (
        <div className="banner" role="alert">
          <span>
            Action failed: {actionError}
            {/401|auth/i.test(actionError) && (
              <> — <a href="/api/auth/login" style={{ color: 'inherit', textDecoration: 'underline' }}>log in again</a></>
            )}
          </span>
          <button className="ghost" onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Live status for cockpit submissions (pending → running → done/failed)
          plus recent history, fed by SSE + GET /api/action. Each item opens
          the full detail view — the only place long prompts/errors are
          readable. */}
      <ActionStatusStrip actions={actions} onSelect={(id) => setDetailActionId(id)} />

      {!isMobile && !desktopCockpitOpen && (
        <div className="cockpit-collapsed-wrap">
          <button
            type="button"
            className="cockpit-collapsed-trigger"
            onClick={() => setDesktopCockpitOpen(true)}
          >
            Tell me what you want… <span className="cockpit-collapsed-hint">e.g. &quot;Launch a new API&quot;, &quot;Fix issue #42&quot;</span>
          </button>
        </div>
      )}

      {!isMobile && desktopCockpitOpen && (
        <div className="cockpit-expanded-wrap">
          <CockpitComposer
            input={actionInput}
            onInputChange={setActionInput}
            models={models}
            selectedModel={cockpitModel}
            onSelectedModelChange={setCockpitModel}
            onSubmit={() => void submitAction()}
            busy={submittingAction}
            autoFocus
            onCancel={() => setDesktopCockpitOpen(false)}
            closable
          />
        </div>
      )}

      <RecentlyReleased issues={issues} />
      <RecentlyClosed issues={issues} />

      <ProjectsHome selectedId={projectFilter} onSelect={setProjectFilter} refreshKey={projectTick} />
      {projectFilter != null && (
        <div className="project-filter-banner" role="status">
          <span>
            Showing <strong>project #{projectFilter}</strong> — the kanban below is filtered.
          </span>
          <button className="ghost" onClick={() => setProjectFilter(null)}>
            Show all
          </button>
        </div>
      )}

      {!isMobile && (
        <BoardToolbar
          repos={repos}
          repoFilter={repoFilter}
          onRepoFilterChange={setRepoFilter}
          lastRefreshed={lastRefreshed}
          refreshing={refreshing}
          onRefresh={refresh}
          showLastRefreshed
        />
      )}

      {isMobile && (
        <MobileStatusStrip
          columns={COLUMNS}
          counts={Object.fromEntries(
            COLUMNS.map((c) => [c, scopedIssues.filter((i) => i.state === c).length])
          ) as Record<IssueState, number>}
          active={activeColumn}
          onSelect={setActiveColumn}
        />
      )}

      <div className="board" ref={boardRef}>
        {/* On mobile the toolbar lives inside the scroll container so it scrolls
            away with the board instead of eating into the fixed chrome. */}
        {isMobile && (
          <BoardToolbar
            repos={repos}
            repoFilter={repoFilter}
            onRepoFilterChange={setRepoFilter}
            lastRefreshed={lastRefreshed}
            refreshing={refreshing}
            onRefresh={refresh}
            showLastRefreshed={false}
          />
        )}
        {/* Mobile renders a single column (the active tab); desktop shows all
            four columns side by side with scroll-sync to the status strip. */}
        {(isMobile ? [activeColumn] : COLUMNS).map((col) => {
          const items = scopedIssues
            .filter((i) => i.state === col && matchesIssue(i, query) && (!repoFilter || `${i.owner}/${i.repo}` === repoFilter))
            .sort((a, b) => {
              // Cards needing input float to the top of their column.
              if (Boolean(a.blockedReason) !== Boolean(b.blockedReason)) {
                return a.blockedReason ? -1 : 1;
              }
              const dir = sorts[col] === 'oldest' ? 1 : -1;
              return a.updatedAt.localeCompare(b.updatedAt) * dir;
            });
          return (
            <section
              className="column"
              key={col}
              id={statusPanelId(col)}
              role={isMobile ? 'tabpanel' : undefined}
              aria-labelledby={isMobile ? statusTabId(col) : undefined}
              tabIndex={isMobile ? 0 : undefined}
              ref={(el) => {
                if (el) columnRefs.current.set(col, el);
              }}
            >
              {isMobile ? (
                <div className="column-meta">
                  <span>
                    {items.length} issues · {countRepos(items)} repos
                  </span>
                  <button
                    className="sort-toggle"
                    onClick={() =>
                      setSorts((s) => ({ ...s, [col]: s[col] === 'oldest' ? 'newest' : 'oldest' }))
                    }
                    title={`Sort ${sorts[col] === 'oldest' ? 'oldest' : 'newest'} first`}
                    aria-label={`Sort ${col} ${sorts[col] === 'oldest' ? 'oldest' : 'newest'} first`}
                  >
                    {sorts[col] === 'oldest' ? '↑ oldest' : '↓ newest'}
                  </button>
                </div>
              ) : (
                <div className="column-head">
                  <span className={`dot ${col}`} />
                  {col}
                  <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({items.length})</span>
                  <button
                    className="sort-toggle"
                    onClick={() =>
                      setSorts((s) => ({ ...s, [col]: s[col] === 'oldest' ? 'newest' : 'oldest' }))
                    }
                    title={`Sort ${sorts[col] === 'oldest' ? 'oldest' : 'newest'} first`}
                    aria-label={`Sort ${col} ${sorts[col] === 'oldest' ? 'oldest' : 'newest'} first`}
                  >
                    {sorts[col] === 'oldest' ? '↑ oldest' : '↓ newest'}
                  </button>
                </div>
              )}
              {items.length === 0 ? (
                <div className="empty">nothing here</div>
              ) : (
                items.map((issue) => {
                  const justStarted = justStartedIds.has(issue.id);
                  const onStarted = () => markJustStarted(issue.id);
                  const onStartFailed = () => clearJustStarted(issue.id);
                  return isMobile ? (
                    <MobileIssueCard
                      key={issue.id}
                      issue={issue}
                      justStarted={justStarted}
                      onStarted={onStarted}
                      onStartFailed={onStartFailed}
                      onOpenActions={() => setOpenActionsFor(issue)}
                    />
                  ) : (
                    <IssueCard
                      key={issue.id}
                      issue={issue}
                      justStarted={justStarted}
                      onStarted={onStarted}
                      onStartFailed={onStartFailed}
                      selected={selectedIds.has(issue.id)}
                      onToggleSelection={toggleSelection}
                    />
                  );
                })
              )}
            </section>
          );
        })}
      </div>

      {openActionsFor && isMobile && (
        <IssueCardSheet
          // Render from the live issue list, not the snapshot taken at open
          // time, so a run started elsewhere flips the sheet to live/recap.
          issue={issues.find((i) => i.id === openActionsFor.id) ?? openActionsFor}
          justStarted={justStartedIds.has(openActionsFor.id)}
          onStarted={() => markJustStarted(openActionsFor.id)}
          onStartFailed={() => clearJustStarted(openActionsFor.id)}
          onClose={() => setOpenActionsFor(null)}
          onToggleSelection={toggleSelection}
        />
      )}

      {searchSheetOpen && isMobile && (
        <MobileSearchSheet
          query={query}
          onQueryChange={setQuery}
          repos={repos}
          repoFilter={repoFilter}
          onRepoFilterChange={setRepoFilter}
          issues={issues}
          onClose={() => setSearchSheetOpen(false)}
        />
      )}

      {/* Mobile: the cockpit collapses to a FAB + bottom sheet so the input
          bar doesn't consume fixed chrome above the first card. The sheet
          lifts above the on-screen keyboard (iOS has no
          interactive-widget=resizes-content, hence the inline offset). */}
      {isMobile && (
        <button
          className="cockpit-fab"
          onClick={() => setCockpitOpen(true)}
          aria-label="Open command input"
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2.5 4l4 4-4 4" />
            <path d="M8.5 12h5" />
          </svg>
        </button>
      )}

      {cockpitOpen && isMobile && (
        <div className="cockpit-backdrop" onClick={() => setCockpitOpen(false)}>
          <div
            className="cockpit-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Command input"
            style={{ bottom: keyboardInset }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="card-sheet-handle" />
            <CockpitComposer
              input={actionInput}
              onInputChange={setActionInput}
              models={models}
              selectedModel={cockpitModel}
              onSelectedModelChange={setCockpitModel}
              onSubmit={() => void submitAction()}
              busy={submittingAction}
              autoFocus
              placeholder='Tell me what you want…'
              onCancel={() => setCockpitOpen(false)}
            />
          </div>
        </div>
      )}

      {detailActionId !== null && (
        <ActionDetail
          actionId={detailActionId}
          liveStatus={actions.find((a) => a.id === detailActionId)?.status ?? null}
          liveDetail={actions.find((a) => a.id === detailActionId)?.detail ?? null}
          isMobile={isMobile}
          onClose={() => setDetailActionId(null)}
          onRerun={rerunAction}
        />
      )}
      </main>
    </div>
  );
}
