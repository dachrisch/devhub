'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Issue, IssueState } from '@/lib/types';
import { useAuth } from '@/components/use-auth';
import { Avatar, WelcomeScreen } from '@/components/auth-ui';
import { Logo } from '@/components/logo';

const COLUMNS: IssueState[] = ['backlog', 'refinement', 'developing', 'pr', 'rollout', 'blocked'];

// Rolled-out cards accumulate forever; collapse everything but the newest few.
const ROLLOUT_CAP = 5;

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

export default function BoardPage() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [connected, setConnected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [rolloutExpanded, setRolloutExpanded] = useState(false);
  const { user, loading, denied, logout } = useAuth();

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
        if (active) setIssues(data.issues);
      })
      .catch(() => {});

    const es = new EventSource('/api/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'issue') {
          upsert(msg.issue as Issue);
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

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetch('/api/issues', { method: 'POST' });
    } finally {
      setRefreshing(false);
    }
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
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <input
            className="search"
            placeholder="Search…  e.g. repo:web title:auth or free text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {connected ? 'live' : 'connecting…'}
          </span>
          {user && (
            <>
              <Avatar login={user.login} avatarUrl={user.avatarUrl} />
              <span className="auth-login">{user.login}</span>
              <button onClick={logout}>Sign out</button>
            </>
          )}
          <button onClick={refresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh issues'}
          </button>
        </div>
      </header>

      <div className="board">
        {COLUMNS.map((col) => {
          let items = issues.filter((i) => i.state === col && matchesIssue(i, query));
          if (col === 'rollout') {
            items = [...items].sort((a, b) => (b.releasedAt ?? '').localeCompare(a.releasedAt ?? ''));
          }
          const collapsed = col === 'rollout' && !rolloutExpanded && items.length > ROLLOUT_CAP;
          const visible = collapsed ? items.slice(0, ROLLOUT_CAP) : items;
          return (
            <section className="column" key={col}>
              <div className="column-head">
                <span className={`dot ${col}`} />
                {col}
                <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({items.length})</span>
              </div>
              {visible.length === 0 ? (
                <div className="empty">nothing here</div>
              ) : (
                visible.map((issue) => <Card key={issue.id} issue={issue} />)
              )}
              {collapsed && (
                <button className="column-more" onClick={() => setRolloutExpanded(true)}>
                  +{items.length - ROLLOUT_CAP} more
                </button>
              )}
              {col === 'rollout' && rolloutExpanded && items.length > ROLLOUT_CAP && (
                <button className="column-more" onClick={() => setRolloutExpanded(false)}>
                  Collapse
                </button>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Card({ issue }: { issue: Issue }) {
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selected, setSelected] = useState<ModelOption | null>(null);
  const color = repoColor(`${issue.owner}/${issue.repo}`);
  const developing = issue.state === 'developing';

  const loadModels = useCallback(async () => {
    try {
      const res = await fetch('/api/models');
      if (!res.ok) return;
      const data = (await res.json()) as { models: ModelOption[]; default: ModelOption | null };
      setModels(data.models ?? []);
      setSelected(data.default ?? null);
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
      if (selected) {
        body.modelId = selected.id;
        body.providerID = selected.providerID;
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
  }, [issue.id, command, selected]);

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
      {issue.state === 'rollout' && issue.releaseTag && (
        <div className="result">
          Rolled out in <span className="release-tag">{issue.releaseTag}</span>
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
            <ModelPicker models={models} value={selected} onChange={setSelected} />
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
