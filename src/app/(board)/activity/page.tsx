'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { ActivitySession, UsageHistory } from '@/lib/activity/types';
import { useAuth } from '@/components/use-auth';
import { WelcomeScreen } from '@/components/auth-ui';
import { AppHeader } from '@/components/app-header';
import { Timeline } from '@/components/activity/timeline';
import { HistoryView } from '@/components/activity/history-view';

interface ActivityResponse {
  fleet?: ActivitySession[];
  history?: UsageHistory;
  generatedAt?: string;
  error?: string;
}

// Agent Activity (devhub#270/#274): Live fleet of what is running now, plus a
// History tab of durable daily rollups that survive opencode's 7-day prune.
export default function ActivityPage() {
  const [fleet, setFleet] = useState<ActivitySession[]>([]);
  const [history, setHistory] = useState<UsageHistory | null>(null);
  const [tab, setTab] = useState<'live' | 'history'>('live');
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { user, loading, denied, logout } = useAuth();
  const signedIn = Boolean(user);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/activity');
      const data = (await res.json().catch(() => null)) as ActivityResponse | null;
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      setFleet(data?.fleet ?? []);
      setHistory(data?.history ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const es = new EventSource('/api/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as { type?: string };
        if (msg.type === 'activity' || msg.type === 'activity-heartbeat') void load();
      } catch {
        // ignore
      }
    };
    return () => es.close();
  }, [signedIn, load]);

  // Re-render relative times/elapsed without a refetch.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!signedIn) {
    return (
      <div className="page-wrap">
        <AppHeader title="DevHub" />
        <main id="board-main" className="board-main">
          {!loading && <WelcomeScreen denied={denied} />}
        </main>
      </div>
    );
  }

  return (
    <div className="page-wrap v2-page activity-page">
      <AppHeader
        title="Activity"
        connection={{ connected }}
        user={user ? { login: user.login, avatarUrl: user.avatarUrl, onLogout: logout } : undefined}
        nav={
          <Link href="/" className="app-nav-link">
            ← Board
          </Link>
        }
      />

      <main id="board-main" className="board-main v2-main activity-main">
        {error && (
          <div className="banner" role="alert">
            <span>{error}</span>
            <button className="ghost" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        <div className="activity-tabs" role="tablist" aria-label="Activity views">
          <button
            role="tab"
            aria-selected={tab === 'live'}
            className={`activity-tab${tab === 'live' ? ' is-active' : ''}`}
            onClick={() => setTab('live')}
          >
            Live
          </button>
          <button
            role="tab"
            aria-selected={tab === 'history'}
            className={`activity-tab${tab === 'history' ? ' is-active' : ''}`}
            onClick={() => setTab('history')}
          >
            History
          </button>
        </div>

        {tab === 'live' ? (
          <Timeline fleet={fleet} now={now} />
        ) : history ? (
          <HistoryView history={history} />
        ) : (
          <div className="empty">loading history…</div>
        )}
      </main>
    </div>
  );
}
