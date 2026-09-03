'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Issue, IssueState } from '@/lib/types';
import { countRepos, closedReasonLabel, excerpt, isWorkable, matchesIssue, relTime, repoColor } from '@/lib/board-ui';
import { useAuth } from '@/components/use-auth';
import { Avatar, WelcomeScreen } from '@/components/auth-ui';
import { Logo } from '@/components/logo';
import { useCardActions } from '@/components/board/use-card-actions';
import { DevelopModal } from '@/components/board/develop-modal';
import { useMediaQuery, MOBILE_QUERY } from '@/components/board/use-media-query';
import { MobileCard } from '@/components/board/mobile-card';
import { CardActionsSheet } from '@/components/board/card-actions-sheet';
import { MobileStatusStrip, statusPanelId, statusTabId } from '@/components/board/mobile-status-strip';
import { MobileSearchSheet } from '@/components/board/mobile-search-sheet';
import type { CardActionId } from '@/lib/board-ui';
import {
  ActionStatusStrip,
  actionFromApi,
  isTerminalActionStatus,
  mergeAction,
  type ApiActionRow,
  type CockpitAction,
} from '@/components/board/action-status-strip';

const COLUMNS: IssueState[] = ['backlog', 'refinement', 'developing', 'pr'];

// Released tickets are shown in a slim strip under the header, capped so the
// strip stays compact.
const RELEASED_CAP = 5;

// Similarly-capped strip for issues reconciled to the `closed` terminal state
// (closed on GitHub outside DevHub's own pipeline).
const CLOSED_CAP = 5;

// Staleness tier for a card, based on time since last update. Used as a
// lightweight urgency cue for triaging a crowded backlog.
function urgencyTier(iso: string): 'fresh' | 'aging' | 'stale' {
  const then = new Date(iso.replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(then)) return 'fresh';
  const days = (Date.now() - then) / 86400000;
  if (days >= 14) return 'stale';
  if (days >= 4) return 'aging';
  return 'fresh';
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

  // Batch selection state
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [batchStatus, setBatchStatus] = useState<{
    operation: string;
    total: number;
    completed: number;
    errors: number;
  } | null>(null);

  // Cockpit input bar
  const [actionInput, setActionInput] = useState('');
  const [cockpitOpen, setCockpitOpen] = useState(false);
  // Recent cockpit actions with live status: hydrated from GET /api/action on
  // load, updated by `type:'action'` SSE broadcasts, and drilled into
  // GET /api/action/[id] for summary/duration when we lack the row.
  const [actions, setActions] = useState<CockpitAction[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const knownActionIdsRef = useRef<Set<number>>(new Set());
  const actionDetailFetchedRef = useRef<Set<string>>(new Set());

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

  const repos = useMemo(() => {
    const set = new Set<string>();
    for (const i of issues) set.add(`${i.owner}/${i.repo}`);
    return Array.from(set).sort();
  }, [issues]);

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
          upsert(issue);
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
  }, [signedIn, upsert, hydrateAction]);

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

  const submitAction = useCallback(async () => {
    const input = actionInput.trim();
    if (!input) return;
    try {
      const res = await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; actionId?: number; error?: string }
        | null;
      if (!res.ok || !data?.ok || typeof data.actionId !== 'number') {
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
      setActionInput('');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, [actionInput]);

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
        results?: Array<{ id: number; success: boolean; error?: string }>;
      };

      if (!res.ok) {
        throw new Error(data.error || `batch work failed (HTTP ${res.status})`);
      }

      const succeeded = data.results?.filter((r) => r.success).length ?? 0;
      const failed = data.results?.filter((r) => !r.success) ?? [];

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
  }, [selectedIds, clearSelection]);

  // Keyboard shortcuts for batch operations
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      // Ctrl/Cmd + A to select all visible issues (skip when in a text input)
      if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !isInput) {
        e.preventDefault();
        const visibleIssues = issues.filter((i) => matchesIssue(i, query));
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
  }, [issues, query, selectedIds, clearSelection, advanceSelected]);

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
          plus recent history, fed by SSE + GET /api/action. */}
      <ActionStatusStrip actions={actions} />

      {!isMobile && (
        <div style={{ padding: '0 16px 12px' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={actionInput}
              onChange={(e) => setActionInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitAction()}
              placeholder='Tell me what you want... (e.g. "Launch a new API", "Fix issue #42")'
              style={{
                flex: 1, padding: '10px 14px', borderRadius: 8,
                border: '1px solid var(--border)', background: 'var(--surface)',
                color: 'var(--text)', fontSize: 14, outline: 'none',
              }}
            />
            <button
              onClick={submitAction}
              style={{
                padding: '10px 20px', borderRadius: 8, border: 'none',
                background: 'var(--accent)', color: '#fff', fontWeight: 600,
                cursor: 'pointer', fontSize: 14,
              }}
            >
              Go
            </button>
          </div>
        </div>
      )}

      <RecentlyReleased issues={issues} />
      <RecentlyClosed issues={issues} />

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
            COLUMNS.map((c) => [c, issues.filter((i) => i.state === c).length])
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
          const items = issues
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
                items.map((issue) =>
                  isMobile ? (
                    <MobileCardWithActions
                      key={issue.id}
                      issue={issue}
                      onOpenActions={() => setOpenActionsFor(issue)}
                    />
                  ) : (
                    <Card
                      key={issue.id}
                      issue={issue}
                      selected={selectedIds.has(issue.id)}
                      onToggleSelection={toggleSelection}
                    />
                  )
                )
              )}
            </section>
          );
        })}
      </div>

      {openActionsFor && isMobile && (
        <CardActionsSheetWithActions
          issue={openActionsFor}
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
          bar doesn't consume fixed chrome above the first card. */}
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
            onClick={(e) => e.stopPropagation()}
          >
            <div className="card-sheet-handle" />
            <form
              className="cockpit-form"
              onSubmit={(e) => {
                e.preventDefault();
                void submitAction();
                setCockpitOpen(false);
              }}
            >
              <input
                className="cockpit-input"
                type="text"
                value={actionInput}
                onChange={(e) => setActionInput(e.target.value)}
                placeholder='Tell me what you want…'
                autoFocus
              />
              <button type="submit" className="cockpit-go" disabled={!actionInput.trim()}>
                Go
              </button>
            </form>
            <div className="cockpit-hint">e.g. “Launch a new API”, “Fix issue #42”</div>
          </div>
        </div>
      )}
      </main>
    </div>
  );
}

interface BoardToolbarProps {
  repos: string[];
  repoFilter: string | null;
  onRepoFilterChange: (repo: string | null) => void;
  lastRefreshed: Date | null;
  refreshing: boolean;
  onRefresh: () => void;
  showLastRefreshed: boolean;
}

// Repo filter chips + manual refresh. On desktop it sits above the board;
// on mobile it renders inside the scroll container (see BoardPage) and the
// "Last refreshed" stamp is dropped — SSE live updates make it redundant.
function BoardToolbar({
  repos,
  repoFilter,
  onRepoFilterChange,
  lastRefreshed,
  refreshing,
  onRefresh,
  showLastRefreshed,
}: BoardToolbarProps) {
  return (
    <div className="board-toolbar">
      {repos.length > 1 && (
        <div className="repo-chips" role="group" aria-label="Filter by repo">
          <button
            className={`repo-chip${repoFilter === null ? ' active' : ''}`}
            onClick={() => onRepoFilterChange(null)}
          >
            All
          </button>
          {repos.map((r) => {
            const color = repoColor(r);
            return (
              <button
                key={r}
                className={`repo-chip${repoFilter === r ? ' active' : ''}`}
                onClick={() => onRepoFilterChange(repoFilter === r ? null : r)}
                style={{ '--chip-color': color } as React.CSSProperties}
              >
                <span className="repo-chip-dot" />
                {r}
              </button>
            );
          })}
        </div>
      )}
      <div className="toolbar-actions">
        {showLastRefreshed && lastRefreshed && (
          <span className="last-refreshed">Last refreshed {fmtTime(lastRefreshed)}</span>
        )}
        <button className="refresh-btn" onClick={onRefresh} disabled={refreshing} aria-label="Refresh issues">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className={refreshing ? 'spin' : ''}>
            <path d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.001 7.001 0 0114.95 7.16a.75.75 0 01-1.49.178A5.501 5.501 0 008 2.5zM1.705 8.005a.75.75 0 01.834.656 5.501 5.501 0 009.592 2.97l-1.204-1.204a.25.25 0 01.177-.427h3.646a.25.25 0 01.25.25v3.646a.25.25 0 01-.427.177l-1.38-1.38A7.001 7.001 0 011.05 8.84a.75.75 0 01.656-.834z"/>
          </svg>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </div>
  );
}

function RecentlyReleased({ issues }: { issues: Issue[] }) {
  const [expanded, setExpanded] = useState(false);
  const rolled = useMemo(
    () =>
      issues
        .filter((i) => i.state === 'rollout')
        .sort((a, b) => (b.releasedAt ?? '').localeCompare(a.releasedAt ?? '')),
    [issues]
  );
  if (rolled.length === 0) return null;
  const visible = expanded ? rolled : rolled.slice(0, RELEASED_CAP);
  return (
    <div className="released-strip">
      <span className="released-label">Released</span>
      <div className="released-list">
        {visible.map((issue) => (
          <Link key={issue.id} href={`/issues/${issue.id}`} className="released-item">
            <span className="released-tag">{issue.releaseTag ?? '?'}</span>
            <span className="released-title">
              {issue.owner}/{issue.repo} #{issue.number}: {issue.title}
            </span>
            <span className="released-time">{relTime(issue.releasedAt ?? issue.updatedAt)}</span>
          </Link>
        ))}
      </div>
      {rolled.length > RELEASED_CAP && (
        <button className="released-toggle" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Collapse' : `+${rolled.length - RELEASED_CAP} more`}
        </button>
      )}
    </div>
  );
}

function RecentlyClosed({ issues }: { issues: Issue[] }) {
  const [expanded, setExpanded] = useState(false);
  const closed = useMemo(
    () =>
      issues
        .filter((i) => i.state === 'closed')
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')),
    [issues]
  );
  if (closed.length === 0) return null;
  const visible = expanded ? closed : closed.slice(0, CLOSED_CAP);
  return (
    <div className="closed-strip">
      <span className="released-label">Closed</span>
      <div className="released-list">
        {visible.map((issue) => (
          <Link key={issue.id} href={`/issues/${issue.id}`} className="released-item">
            <span className="released-tag">{closedReasonLabel(issue.stateReason)}</span>
            <span className="released-title">
              {issue.owner}/{issue.repo} #{issue.number}: {issue.title}
            </span>
            <span className="released-time">{relTime(issue.updatedAt)}</span>
          </Link>
        ))}
      </div>
      {closed.length > CLOSED_CAP && (
        <button className="released-toggle" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Collapse' : `+${closed.length - CLOSED_CAP} more`}
        </button>
      )}
    </div>
  );
}

interface CardProps {
  issue: Issue;
  selected: boolean;
  onToggleSelection: (issueId: number) => void;
}

function Card({ issue, selected, onToggleSelection }: CardProps) {
  const color = repoColor(`${issue.owner}/${issue.repo}`);
  const developing = issue.state === 'developing';
  const {
    busy,
    error,
    modalOpen,
    openModal,
    closeModal,
    command,
    setCommand,
    models,
    selectedModel,
    setSelectedModel,
    start,
    transition,
  } = useCardActions(issue.id);

  const isAuthError = error && (/401/.test(error) || /403/.test(error) || /auth/i.test(error));

  return (
    <div className="card" style={{ borderLeftColor: color }}>
      <div className="card-header">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelection(issue.id)}
          className="card-checkbox"
          aria-label={`Select issue ${issue.owner}/${issue.repo} #${issue.number} for batch actions`}
        />
        <div className="repo">
          <span
            className="repo-pill"
            style={{ color, borderColor: color, background: `${color}22` }}
          >
            {issue.owner}/{issue.repo}
          </span>
          <span className="issue-number">#{issue.number}</span>
          <span className={`age ${urgencyTier(issue.updatedAt)}`}>{relTime(issue.updatedAt)}</span>
        </div>
      </div>
      <div className="title">
        <Link href={`/issues/${issue.id}`} className="title-link">
          {issue.title}
        </Link>
      </div>
      {issue.body && <div className="excerpt">{excerpt(issue.body)}</div>}

      {issue.linkedPrUrl && issue.state !== 'pr' && (
        <div className="result">
          PR: <a href={issue.linkedPrUrl}>{issue.linkedPrUrl}</a>
        </div>
      )}

      {issue.state === 'pr' && issue.resultPrUrl && (
        <div className="result">
          PR: <a href={issue.resultPrUrl}>{issue.resultPrUrl}</a>
        </div>
      )}
      {issue.blockedReason && (
        <div className="card-blocked" role="alert">
          <strong>Needs input:</strong> {excerpt(issue.blockedReason)}
        </div>
      )}
      {issue.state === 'refinement' && !issue.blockedReason && issue.resultText && (
        <div className="result">
          <strong>Validation:</strong> {excerpt(issue.resultText)}
        </div>
      )}

      <div className="card-actions">
        {issue.state === 'backlog' && (
          <button className="ghost" onClick={() => transition('refinement')} disabled={busy}>
            Refine
          </button>
        )}
        {issue.state === 'refinement' && (
          <button className="ghost" onClick={() => transition('backlog')} disabled={busy}>
            Back to backlog
          </button>
        )}
        {isWorkable(issue) && (
          <button className="develop-btn" onClick={openModal}>
            Work
          </button>
        )}
      </div>
      {error && (
        <div className="card-error" role="alert">
          <span>{isAuthError ? 'Session expired — ' : `${error}`}</span>
          {isAuthError && <a href="/api/auth/login" className="card-error-login">log in again</a>}
        </div>
      )}
      <div className="recap-row">
        <Link href={`/issues/${issue.id}`} className="recap-link">
          {developing && !issue.blockedReason ? 'Recap (live)' : 'Recap'}
        </Link>
      </div>
      {developing && !issue.blockedReason && (
        <div className="result developing">developing{issue.modelId ? `… ${issue.modelId}` : '…'} (live via opencode)</div>
      )}

      {modalOpen && (
        <DevelopModal
          issue={issue}
          command={command}
          onCommandChange={setCommand}
          models={models}
          selectedModel={selectedModel}
          onSelectedModelChange={setSelectedModel}
          busy={busy}
          error={error}
          onCancel={closeModal}
          onStart={start}
        />
      )}
    </div>
  );
}

function MobileCardWithActions({
  issue,
  onOpenActions,
}: {
  issue: Issue;
  onOpenActions: () => void;
}) {
  const color = repoColor(`${issue.owner}/${issue.repo}`);
  const {
    busy,
    error,
    modalOpen,
    openModal,
    closeModal,
    command,
    setCommand,
    models,
    selectedModel,
    setSelectedModel,
    start,
  } = useCardActions(issue.id);

  return (
    <>
      <MobileCard issue={issue} color={color} busy={busy} onPrimaryAction={openModal} onOpenActions={onOpenActions} />
      {modalOpen && (
        <DevelopModal
          issue={issue}
          command={command}
          onCommandChange={setCommand}
          models={models}
          selectedModel={selectedModel}
          onSelectedModelChange={setSelectedModel}
          busy={busy}
          error={error}
          onCancel={closeModal}
          onStart={start}
        />
      )}
    </>
  );
}

function CardActionsSheetWithActions({
  issue,
  onClose,
  onToggleSelection,
}: {
  issue: Issue;
  onClose: () => void;
  onToggleSelection: (issueId: number) => void;
}) {
  const {
    busy,
    error,
    modalOpen,
    openModal,
    command,
    setCommand,
    models,
    selectedModel,
    setSelectedModel,
    start,
    transition,
  } = useCardActions(issue.id);

  const handleSelect = (id: CardActionId) => {
    switch (id) {
      case 'work':
        openModal();
        return;
      case 'to-refinement':
        void transition('refinement');
        break;
      case 'to-backlog':
        void transition('backlog');
        break;
      case 'select-batch':
        onToggleSelection(issue.id);
        break;
      case 'open-github':
        window.open(issue.htmlUrl, '_blank', 'noopener,noreferrer');
        break;
      case 'recap':
        // Recap navigates via its own Link in the sheet row — the sheet's
        // row onClick already closed it. Nothing to do here.
        return;
    }
    onClose();
  };

  if (modalOpen) {
    return (
      <DevelopModal
        issue={issue}
        command={command}
        onCommandChange={setCommand}
        models={models}
        selectedModel={selectedModel}
        onSelectedModelChange={setSelectedModel}
        busy={busy}
        error={error}
        onCancel={onClose}
        onStart={() => {
          void start();
          onClose();
        }}
      />
    );
  }

  return <CardActionsSheet issue={issue} onClose={onClose} onSelect={handleSelect} />;
}
