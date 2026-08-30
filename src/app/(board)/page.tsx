'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Issue, IssueState } from '@/lib/types';
import { useAuth } from '@/components/use-auth';
import { Avatar, WelcomeScreen } from '@/components/auth-ui';
import { Logo } from '@/components/logo';

const COLUMNS: IssueState[] = ['backlog', 'developing', 'pr', 'blocked'];

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
          const items = issues.filter((i) => i.state === col && matchesIssue(i, query));
          return (
            <section className="column" key={col}>
              <div className="column-head">
                <span className={`dot ${col}`} />
                {col}
                <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({items.length})</span>
              </div>
              {items.length === 0 ? (
                <div className="empty">nothing here</div>
              ) : (
                items.map((issue) => <Card key={issue.id} issue={issue} />)
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
  const color = repoColor(`${issue.owner}/${issue.repo}`);
  const developing = issue.state === 'developing';

  const develop = useCallback(async () => {
    setBusy(true);
    try {
      await fetch(`/api/issues/${issue.id}/develop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }, [issue.id, command]);

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
        <span className="age">{relTime(issue.createdAt)}</span>
      </div>
      <div className="title">
        <a href={issue.htmlUrl} target="_blank" rel="noreferrer">
          {issue.title}
        </a>
      </div>
      {issue.body && <div className="excerpt">{excerpt(issue.body)}</div>}

      {issue.state === 'pr' && issue.resultPrUrl && (
        <div className="result">
          PR: <a href={issue.resultPrUrl}>{issue.resultPrUrl}</a>
        </div>
      )}
      {issue.state === 'blocked' && issue.resultText && (
        <div className="result">{issue.resultText}</div>
      )}

      {!developing && (
        <div className="card-actions">
          <Link href={`/issues/${issue.id}`} className="recap-link">
            Recap
          </Link>
          <button className="develop-btn" onClick={() => setOpen(true)}>
            Develop this
          </button>
        </div>
      )}
      {developing && (
        <div className="card-actions">
          <Link href={`/issues/${issue.id}`} className="recap-link">
            Recap (live)
          </Link>
        </div>
      )}
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
