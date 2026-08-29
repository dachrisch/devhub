'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Issue, IssueState } from '@/lib/types';

const COLUMNS: IssueState[] = ['backlog', 'developing', 'pr', 'blocked'];

export default function BoardPage() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [connected, setConnected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

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
  }, [upsert]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetch('/api/issues', { method: 'POST' });
    } finally {
      setRefreshing(false);
    }
  }, []);

  return (
    <>
      <header>
        <h1>DevHub</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {connected ? 'live' : 'connecting…'}
          </span>
          <button onClick={refresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh issues'}
          </button>
        </div>
      </header>

      <div className="board">
        {COLUMNS.map((col) => {
          const items = issues.filter((i) => i.state === col);
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
    </>
  );
}

function Card({ issue }: { issue: Issue }) {
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);

  const develop = useCallback(async () => {
    setBusy(true);
    try {
      await fetch(`/api/issues/${issue.id}/develop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
    } finally {
      setBusy(false);
    }
  }, [issue.id, command]);

  const developing = issue.state === 'developing';

  return (
    <div className="card">
      <div className="repo">
        <a href={`https://github.com/${issue.owner}/${issue.repo}`} target="_blank" rel="noreferrer">
          {issue.owner}/{issue.repo}
        </a>{' '}
        #{issue.number}
      </div>
      <div className="title">
        <a href={issue.htmlUrl} target="_blank" rel="noreferrer">
          {issue.title}
        </a>
      </div>

      {issue.state === 'pr' && issue.resultPrUrl && (
        <div className="result">
          PR: <a href={issue.resultPrUrl}>{issue.resultPrUrl}</a>
        </div>
      )}
      {issue.state === 'blocked' && issue.resultText && (
        <div className="result">{issue.resultText}</div>
      )}

      {!developing && (
        <div className="develop-row">
          <input
            placeholder="extra instructions (optional)"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
          <button onClick={develop} disabled={busy}>
            {busy ? 'Starting…' : 'Develop this'}
          </button>
        </div>
      )}
      {developing && <div className="result">developing… (live via opencode)</div>}
    </div>
  );
}
