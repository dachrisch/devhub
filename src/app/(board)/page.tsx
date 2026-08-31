'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Issue, IssueState } from '@/lib/types';
import { countRepos, excerpt, matchesIssue, relTime, repoColor } from '@/lib/board-ui';
import { useAuth } from '@/components/use-auth';
import { Avatar, WelcomeScreen } from '@/components/auth-ui';
import { Logo } from '@/components/logo';
import { useCardActions } from '@/components/board/use-card-actions';
import { DevelopModal } from '@/components/board/develop-modal';
import { useMediaQuery, MOBILE_QUERY } from '@/components/board/use-media-query';
import { MobileCard } from '@/components/board/mobile-card';
import { CardActionsSheet } from '@/components/board/card-actions-sheet';
import { MobileStatusStrip } from '@/components/board/mobile-status-strip';
import { MobileSearchSheet } from '@/components/board/mobile-search-sheet';
import type { CardActionId } from '@/lib/board-ui';

const COLUMNS: IssueState[] = ['backlog', 'refinement', 'developing', 'pr', 'blocked'];

// Released tickets are shown in a slim strip under the header, capped so the
// strip stays compact.
const RELEASED_CAP = 5;

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
// operator's attention (PR opened = success, blocked = needs a look). Only
// fires for transitions seen live over SSE; existing cards on load are not
// re-notified.
function notifyStateChange(issue: Issue): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  const title = issue.state === 'pr' ? 'DevHub: pull request opened' : 'DevHub: develop run blocked';
  const body = `${issue.owner}/${issue.repo} #${issue.number}: ${issue.title}`;
  try {
    new Notification(title, { body, tag: `devhub-${issue.id}-${issue.state}` });
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
  // Last-seen state per issue, so live transitions to pr/blocked can be told
  // apart from cards that already were in that state on load.
  const prevStatesRef = useRef<Map<number, IssueState>>(new Map());
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
  const [actionHistory, setActionHistory] = useState<{id: number; input: string; status: string}[]>([]);

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

  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    fetch('/api/issues')
      .then((r) => r.json())
      .then((data: { issues: Issue[] }) => {
        if (active) {
          setIssues(data.issues);
          setLastRefreshed(new Date());
          const prev = prevStatesRef.current;
          for (const i of data.issues) prev.set(i.id, i.state);
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
          prevStatesRef.current.set(issue.id, issue.state);
          if (prevState && prevState !== issue.state) {
            if (issue.state === 'pr' || issue.state === 'blocked') notifyStateChange(issue);
          }
          upsert(issue);
        }
      } catch {
        // ignore malformed
      }
    };
    return () => {
      active = false;
      es.close();
    };
  }, [signedIn, upsert]);

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
    return () => {
      if (batchStatusTimerRef.current) clearTimeout(batchStatusTimerRef.current);
    };
  }, []);

  const submitAction = useCallback(async () => {
    if (!actionInput.trim()) return;
    try {
      const res = await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: actionInput }),
      });
      const data = await res.json();
      if (data.ok) {
        setActionHistory((prev) => [{ id: data.actionId, input: actionInput, status: 'pending' }, ...prev]);
        setActionInput('');
      }
    } catch { /* ignore */ }
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

  const validateSelected = useCallback(async () => {
    if (selectedIds.size === 0) return;
    
    const total = selectedIds.size;
    setBatchStatus({ operation: 'validating', total, completed: 0, errors: 0 });
    setRefreshing(true);
    try {
      const res = await fetch('/api/issues/batch-advance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          issueIds: Array.from(selectedIds),
          mode: 'validate'
        }),
      });
      
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error || `batch validation failed (HTTP ${res.status})`);
      }

      const result = await res.json() as { results: Array<{ id: number; success: boolean; error?: string }> };
      const completed = result.results.filter((r) => r.success).length;
      const errors = result.results.filter((r) => !r.success).length;

      setBatchStatus({ operation: 'validating', total, completed, errors });
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

  const developSelected = useCallback(async () => {
    if (selectedIds.size === 0) return;
    
    const total = selectedIds.size;
    setBatchStatus({ operation: 'developing', total, completed: 0, errors: 0 });
    setRefreshing(true);
    try {
      const res = await fetch('/api/issues/batch-advance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          issueIds: Array.from(selectedIds),
          mode: 'develop'
        }),
      });
      
      const data = await res.json() as { 
        ok?: boolean;
        error?: string;
        results?: Array<{ id: number; success: boolean; error?: string; mode?: string }>;
      };

      if (!res.ok) {
        throw new Error(data.error || `batch develop failed (HTTP ${res.status})`);
      }
      
      const succeeded = data.results?.filter((r) => r.success).length ?? 0;
      const failed = data.results?.filter((r) => !r.success) ?? [];

      setBatchStatus({ operation: 'developing', total, completed: succeeded, errors: failed.length });
      const summary = failed.length > 0
        ? `Develop started for ${succeeded} issue(s), ${failed.length} failed: ${failed.map((f) => `#${f.id} (${f.error})`).join(', ')}`
        : `Develop started for ${succeeded} issue(s)`;
      
      setRefreshError(failed.length > 0 ? summary : null);
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
        {!loading && <WelcomeScreen denied={denied} />}
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
                  placeholder="Search…  e.g. repo:devhub title:auth or free text"
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
            <>
              <button
                className="develop-batch-btn"
                onClick={developSelected}
                disabled={refreshing}
              >
                Develop selected ({selectedIds.size})
              </button>
              <button
                className="validate-btn"
                onClick={validateSelected}
                disabled={refreshing}
              >
                Validate selected ({selectedIds.size})
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
            </>
          )}
        </div>
      </header>

      {refreshError && (
        <div className="banner" role="alert">
          <span>Refresh failed: {refreshError}</span>
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

      <RecentlyReleased issues={issues} />

      <div className="board-toolbar">
        {repos.length > 1 && (
          <div className="repo-chips" role="group" aria-label="Filter by repo">
            <button
              className={`repo-chip${repoFilter === null ? ' active' : ''}`}
              onClick={() => setRepoFilter(null)}
            >
              All
            </button>
            {repos.map((r) => {
              const color = repoColor(r);
              return (
                <button
                  key={r}
                  className={`repo-chip${repoFilter === r ? ' active' : ''}`}
                  onClick={() => setRepoFilter(repoFilter === r ? null : r)}
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
          {lastRefreshed && (
            <span className="last-refreshed">Last refreshed {fmtTime(lastRefreshed)}</span>
          )}
          <button className="refresh-btn" onClick={refresh} disabled={refreshing} aria-label="Refresh issues">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className={refreshing ? 'spin' : ''}>
              <path d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.001 7.001 0 0114.95 7.16a.75.75 0 01-1.49.178A5.501 5.501 0 008 2.5zM1.705 8.005a.75.75 0 01.834.656 5.501 5.501 0 009.592 2.97l-1.204-1.204a.25.25 0 01.177-.427h3.646a.25.25 0 01.25.25v3.646a.25.25 0 01-.427.177l-1.38-1.38A7.001 7.001 0 011.05 8.84a.75.75 0 01.656-.834z"/>
            </svg>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

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
        {/* Mobile renders a single column (the active tab); desktop shows all
            five columns side by side with scroll-sync to the status strip. */}
        {(isMobile ? [activeColumn] : COLUMNS).map((col) => {
          const items = issues
            .filter((i) => i.state === col && matchesIssue(i, query) && (!repoFilter || `${i.owner}/${i.repo}` === repoFilter))
            .sort((a, b) => {
              const dir = sorts[col] === 'oldest' ? 1 : -1;
              return a.updatedAt.localeCompare(b.updatedAt) * dir;
            });
          return (
            <section 
              className="column" 
              key={col}
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
    modalOpen,
    openModal,
    closeModal,
    command,
    setCommand,
    models,
    selectedModel,
    setSelectedModel,
    develop,
    stagedDevelop,
    transition,
  } = useCardActions(issue.id);

  return (
    <div className="card" style={{ borderLeftColor: color }}>
      <div className="card-header">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelection(issue.id)}
          className="card-checkbox"
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
      {issue.state === 'blocked' && issue.resultText && (
        <div className="result">{issue.resultText}</div>
      )}
      {issue.state === 'refinement' && issue.resultText && (
        <div className="result">
          <strong>Validation:</strong> {issue.resultText}
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
        {(issue.state === 'backlog' || issue.state === 'refinement' || issue.state === 'blocked') && (
          <>
            <button className="develop-btn" onClick={openModal}>
              Develop this
            </button>
            <button className="validate-btn" onClick={() => {
              setCommand('');
              openModal();
            }}>
              Develop (with validation)
            </button>
          </>
        )}
      </div>
      <div className="recap-row">
        <Link href={`/issues/${issue.id}`} className="recap-link">
          {developing ? 'Recap (live)' : 'Recap'}
        </Link>
      </div>
      {developing && <div className="result developing">developing… (live via opencode)</div>}

      {modalOpen && (
        <DevelopModal
          issue={issue}
          command={command}
          onCommandChange={setCommand}
          models={models}
          selectedModel={selectedModel}
          onSelectedModelChange={setSelectedModel}
          busy={busy}
          onCancel={closeModal}
          onDevelop={develop}
          onStagedDevelop={stagedDevelop}
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
  const { busy, develop } = useCardActions(issue.id);

  return (
    <MobileCard issue={issue} color={color} busy={busy} onPrimaryAction={develop} onOpenActions={onOpenActions} />
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
    modalOpen,
    openModal,
    command,
    setCommand,
    models,
    selectedModel,
    setSelectedModel,
    develop,
    stagedDevelop,
    transition,
  } = useCardActions(issue.id);

  const handleSelect = (id: CardActionId) => {
    switch (id) {
      case 'develop-validated':
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
        onCancel={onClose}
        onDevelop={() => {
          void develop();
          onClose();
        }}
        onStagedDevelop={() => {
          void stagedDevelop();
          onClose();
        }}
      />
    );
  }

  return <CardActionsSheet issue={issue} onClose={onClose} onSelect={handleSelect} />;
}
