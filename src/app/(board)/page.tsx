'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Issue, IssueState } from '@/lib/types';
import { useAuth } from '@/components/use-auth';
import { Avatar, WelcomeScreen } from '@/components/auth-ui';
import { Logo } from '@/components/logo';

const COLUMNS: IssueState[] = ['backlog', 'refinement', 'developing', 'pr', 'blocked'];

// Released tickets are shown in a slim strip under the header, capped so the
// strip stays compact.
const RELEASED_CAP = 5;

interface ModelOption {
  id: string;
  providerID: string;
}

const REPO_COLORS = [
  '#58a6ff',
  '#3fb950',
  '#d29922',
  '#f85149',
  '#bc8cff',
  '#39c5cf',
  '#ff7b72',
  '#a5d6ff',
  '#7ee787',
  '#ffa657',
];

function repoColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return REPO_COLORS[h % REPO_COLORS.length];
}

const FIELD_FILTERS: Record<string, (i: Issue, v: string) => boolean> = {
  title: (i, v) => i.title.toLowerCase().includes(v),
  repo: (i, v) => i.repo.toLowerCase().includes(v),
  owner: (i, v) => i.owner.toLowerCase().includes(v),
  state: (i, v) => i.state.toLowerCase().includes(v),
  body: (i, v) => (i.body ?? '').toLowerCase().includes(v),
  number: (i, v) => String(i.number).includes(v),
};

function matchesIssue(issue: Issue, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const global: string[] = [];
  for (const token of tokens) {
    const m = token.match(/^([a-z]+):(.*)$/);
    if (m && FIELD_FILTERS[m[1]]) {
      if (!FIELD_FILTERS[m[1]](issue, m[2])) return false;
    } else {
      global.push(token);
    }
  }
  if (global.length === 0) return true;
  const haystack = [issue.owner, issue.repo, `#${issue.number}`, issue.title, issue.body ?? '']
    .join(' ')
    .toLowerCase();
  return global.every((term) => haystack.includes(term));
}

function relTime(iso: string): string {
  const then = new Date(iso.replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  const units: [number, string][] = [
    [31536000, 'y'],
    [2592000, 'mo'],
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm'],
  ];
  for (const [secsInUnit, label] of units) {
    if (secs >= secsInUnit) return `${Math.floor(secs / secsInUnit)}${label} ago`;
  }
  return `${secs}s ago`;
}

function excerpt(body: string): string {
  const flat = body.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*`_\-]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > 180 ? `${flat.slice(0, 180)}…` : flat;
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
  const [activeColumn, setActiveColumn] = useState<IssueState>('backlog');
  const [searchExpanded, setSearchExpanded] = useState(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const columnRefs = useRef<Map<IssueState, HTMLElement>>(new Map());
  const { user, loading, denied, logout } = useAuth();
  // Last-seen state per issue, so live transitions to pr/blocked can be told
  // apart from cards that already were in that state on load.
  const prevStatesRef = useRef<Map<number, IssueState>>(new Map());

  // Batch selection state
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- used in Task 2
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const signedIn = Boolean(user);

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

  const scrollToColumn = useCallback((col: IssueState) => {
    const el = columnRefs.current.get(col);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            for (const [col, el] of columnRefs.current.entries()) {
              if (el === entry.target) {
                setActiveColumn(col);
                break;
              }
            }
          }
        });
      },
      { root: boardRef.current, threshold: 0.5 }
    );
    
    columnRefs.current.forEach((el) => observer.observe(el));
    
    return () => observer.disconnect();
  }, [signedIn]);

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
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="search-wrapper">
            <button 
              className="search-toggle" 
              onClick={() => setSearchExpanded(true)}
              aria-label="Open search"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M11.5 7a4.499 4.499 0 11-8.998 0A4.499 4.499 0 0111.5 7zm-.82 4.74a6 6 0 111.06-1.06l3.04 3.04a.75.75 0 11-1.06 1.06l-3.04-3.04z"/>
              </svg>
            </button>
            <input
              className={`search${searchExpanded ? ' expanded' : ''}`}
              placeholder="Search…  e.g. repo:web title:auth or free text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onBlur={() => {
                if (!query) setSearchExpanded(false);
              }}
            />
            {searchExpanded && (
              <button 
                className="search-cancel" 
                onClick={() => {
                  setSearchExpanded(false);
                  setQuery('');
                }}
              >
                Cancel
              </button>
            )}
          </div>
          <span
            className={`conn-dot ${connected ? 'ok' : 'off'}`}
            title={connected ? 'live' : 'connecting…'}
            aria-label={connected ? 'live' : 'connecting…'}
          />
          {lastRefreshed && (
            <span className="last-refreshed">Last refreshed {fmtTime(lastRefreshed)}</span>
          )}
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
          <button className="header-icon-btn" onClick={refresh} disabled={refreshing} aria-label="Refresh issues">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className={refreshing ? 'spin' : ''}>
              <path d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.001 7.001 0 0114.95 7.16a.75.75 0 01-1.49.178A5.501 5.501 0 008 2.5zM1.705 8.005a.75.75 0 01.834.656 5.501 5.501 0 009.592 2.97l-1.204-1.204a.25.25 0 01.177-.427h3.646a.25.25 0 01.25.25v3.646a.25.25 0 01-.427.177l-1.38-1.38A7.001 7.001 0 011.05 8.84a.75.75 0 01.656-.834z"/>
            </svg>
          </button>
          {selectedIds.size > 0 && (
            <button
              className="advance-btn"
              onClick={() => {
                // Will be implemented in Task 2
                console.log('Advance selected:', Array.from(selectedIds));
              }}
              disabled={refreshing}
            >
              Advance selected ({selectedIds.size})
            </button>
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

      <RecentlyReleased issues={issues} />

      <div className="board" ref={boardRef}>
        {COLUMNS.map((col) => {
          const items = issues.filter((i) => i.state === col && matchesIssue(i, query));
          return (
            <section 
              className="column" 
              key={col}
              ref={(el) => {
                if (el) columnRefs.current.set(col, el);
              }}
            >
              <div className="column-head">
                <span className={`dot ${col}`} />
                {col}
                <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({items.length})</span>
              </div>
              {items.length === 0 ? (
                <div className="empty">nothing here</div>
              ) : (
                items.map((issue) => (
                  <Card
                    key={issue.id}
                    issue={issue}
                    selected={selectedIds.has(issue.id)}
                    onToggleSelection={toggleSelection}
                  />
                ))
              )}
            </section>
          );
        })}
      </div>

      <nav className="bottom-nav" role="tablist" aria-label="Board columns">
        {COLUMNS.map((col) => {
          const count = issues.filter((i) => i.state === col).length;
          return (
            <button
              key={col}
              className={`bottom-nav-tab${activeColumn === col ? ' active' : ''}`}
              onClick={() => {
                setActiveColumn(col);
                scrollToColumn(col);
              }}
              role="tab"
              aria-selected={activeColumn === col}
              aria-label={`${col} column, ${count} items`}
            >
              <span className={`dot ${col}`} />
              <span>{col}</span>
              <span className="bottom-nav-badge">{count}</span>
            </button>
          );
        })}
      </nav>
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
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<ModelOption | null>(null);
  const color = repoColor(`${issue.owner}/${issue.repo}`);
  const developing = issue.state === 'developing';

  const loadModels = useCallback(async () => {
    try {
      const res = await fetch('/api/models');
      if (!res.ok) return;
      const data = (await res.json()) as { models: ModelOption[]; default: ModelOption | null };
      setModels(data.models ?? []);
      setSelectedModel(data.default ?? null);
    } catch {
      /* non-fatal: fall back to no override */
    }
  }, []);

  const openModal = useCallback(() => {
    setOpen(true);
    void loadModels();
  }, [loadModels]);

  const develop = useCallback(async () => {
    setBusy(true);
    try {
      const body: { command: string; modelId?: string; providerID?: string } = { command };
      if (selectedModel) {
        body.modelId = selectedModel.id;
        body.providerID = selectedModel.providerID;
      }
      await fetch(`/api/issues/${issue.id}/develop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }, [issue.id, command, selectedModel]);

  const transition = useCallback(
    async (target: IssueState) => {
      setBusy(true);
      try {
        await fetch(`/api/issues/${issue.id}/transition`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: target }),
        });
      } finally {
        setBusy(false);
      }
    },
    [issue.id]
  );

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
          <span className="age">{relTime(issue.updatedAt)}</span>
        </div>
      </div>
      <div className="title">
        <a href={issue.htmlUrl} target="_blank" rel="noreferrer">
          {issue.title}
        </a>
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
          <button className="develop-btn" onClick={openModal}>
            Develop this
          </button>
        )}
      </div>
      <div className="recap-row">
        <Link href={`/issues/${issue.id}`} className="recap-link">
          {developing ? 'Recap (live)' : 'Recap'}
        </Link>
      </div>
      {developing && <div className="result developing">developing… (live via opencode)</div>}

      {open && (
        <div className="modal-overlay" onClick={() => setOpen(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>
              Develop {issue.owner}/{issue.repo} #{issue.number}
            </h3>
            <p className="modal-sub">{issue.title}</p>
            <label className="modal-label" htmlFor="devhub-cmd">
              Extra instructions (optional)
            </label>
            <textarea
              id="devhub-cmd"
              className="modal-input"
              placeholder="e.g. focus on the auth flow and keep the diff minimal"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              autoFocus
            />
            <label className="modal-label" htmlFor="devhub-model">
              Model (optional — default = pinned tiers)
            </label>
            <ModelPicker models={models} value={selectedModel} onChange={setSelectedModel} />
            <div className="modal-actions">
              <button className="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button className="develop-btn" onClick={develop} disabled={busy}>
                {busy ? 'Starting…' : 'Start developing'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface ModelChoice {
  key: string;
  label: string;
  hint?: string;
  model: ModelOption | null;
}

// Searchable dropdown for picking a develop model. Any model the server
// exposes is selectable; typing filters the list by id/provider.
function ModelPicker({
  models,
  value,
  onChange,
}: {
  models: ModelOption[];
  value: ModelOption | null;
  onChange: (model: ModelOption | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => `${m.providerID} ${m.id}`.toLowerCase().includes(q));
  }, [models, query]);

  const choices = useMemo<ModelChoice[]>(() => {
    return [
      { key: '', label: 'Default (no override)', model: null },
      ...filtered.map((m) => ({
        key: `${m.providerID}:${m.id}`,
        label: `${m.id} (${m.providerID})`,
        model: m,
      })),
    ];
  }, [filtered]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setHighlight(0);
      const t = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(t);
    }
  }, [open]);

  const select = (choice: ModelChoice) => {
    onChange(choice.model);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, choices.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const choice = choices[highlight];
      if (choice) select(choice);
    }
  };

  const valueKey = value ? `${value.providerID}:${value.id}` : '';

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        id="devhub-model"
        type="button"
        className="model-picker-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="model-picker-label">
          {value ? `${value.id} (${value.providerID})` : 'Default (no override)'}
        </span>
        <span className="model-picker-caret">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="model-picker-menu" role="listbox" onKeyDown={onKeyDown}>
          <input
            ref={inputRef}
            className="model-picker-search"
            placeholder="Search models…  e.g. deepseek, gpt, mimo"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
          />
          <div className="model-picker-list">
            {choices.length === 0 && <div className="model-picker-empty">no models found</div>}
            {choices.map((choice, i) => (
              <button
                key={choice.key || '__default__'}
                type="button"
                role="option"
                aria-selected={choice.key === valueKey}
                className={`model-picker-item${i === highlight ? ' highlighted' : ''}${
                  choice.key === valueKey ? ' selected' : ''
                }`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => select(choice)}
              >
                <span className="model-picker-name">{choice.label}</span>
                {choice.hint && <span className="model-picker-hint">{choice.hint}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
