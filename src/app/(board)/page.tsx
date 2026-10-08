'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Issue, Thread } from '@/lib/types';
import { useAuth } from '@/components/use-auth';
import { WelcomeScreen } from '@/components/auth-ui';
import { AppHeader } from '@/components/app-header';
import { CommandDock } from '@/components/threads/command-dock';
import { ThreadDetail } from '@/components/threads/thread-detail';
import { IssueDetail } from '@/components/threads/issue-detail';
import { WorkCard, cardForIssue, cardForThread, cardRank, type CardItem } from '@/components/threads/work-card';
import type { ResolveChip } from '@/lib/resolve';

// v2 command-first home: one screen, one input. No columns, no board, no
// separate intake modes. Work-item cards top of page (single column, active
// first), bottom dock with command bar + mic. Github-closed items drain into
// a collapsed "recently closed" strip instead of lingering on the list.

interface ChipAnswer {
  intent: string;
  chips: ResolveChip[];
}

interface SyncResult {
  repos?: number;
  issues?: number;
  rolledOut?: number;
  closed?: number;
  error?: string;
}

export default function HomePage() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [connected, setConnected] = useState(false);
  const [command, setCommand] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [chipAnswer, setChipAnswer] = useState<ChipAnswer | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [detailThreadId, setDetailThreadId] = useState<number | null>(null);
  const [detailIssueId, setDetailIssueId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const dockInputRef = useRef<HTMLInputElement | null>(null);
  const { user, loading, denied, logout } = useAuth();
  const signedIn = Boolean(user);

  const fetchAll = useCallback(async () => {
    try {
      const [t, i] = await Promise.all([fetch('/api/threads'), fetch('/api/issues')]);
      if (t.ok) {
        const data = (await t.json()) as { threads?: Thread[] };
        if (data.threads) setThreads(data.threads);
      }
      if (i.ok) {
        const data = (await i.json()) as { issues?: Issue[] };
        if (data.issues) setIssues(data.issues);
      }
    } catch {
      // ignore — SSE keeps it live
    }
  }, []);

  // GitHub-side sync is the real ingest (ingest open issues, sweep rollouts,
  // reconcile closed). The button used to only re-read the local snapshot,
  // which is why refresh appeared to do nothing.
  const handleRefresh = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setNotice(null);
    try {
      const res = await fetch('/api/issues', { method: 'POST' });
      const data = (await res.json().catch(() => null)) as SyncResult | null;
      if (!res.ok) throw new Error(data?.error ?? `sync failed (${res.status})`);
      setNotice({
        kind: 'ok',
        text: `synced — ${data?.repos ?? 0} repos, ${data?.issues ?? 0} issues, ${data?.rolledOut ?? 0} rolled out, ${data?.closed ?? 0} closed`,
      });
      void fetchAll();
    } catch (err) {
      setNotice({ kind: 'err', text: `refresh failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSyncing(false);
    }
  }, [syncing, fetchAll]);

  // Self-clearing sync notice.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    if (!signedIn) return;
    // Initial hydration — async fan-out, not a sync setState cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchAll();
    const es = new EventSource('/api/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as { type?: string };
        if (msg.type === 'thread' || msg.type === 'thread-event' || msg.type === 'issue') void fetchAll();
      } catch {
        // ignore
      }
    };
    return () => es.close();
  }, [signedIn, fetchAll]);

  // Threads own their issues; unlinked issues still get cards (closed ones
  // land in the "recently closed" strip via the partition below).
  const { activeCards, closedCards } = useMemo(() => {
    const linkedIds = new Set<number>();
    const threadCards = threads.map((t) => {
      for (const id of t.issueIds) linkedIds.add(id);
      return cardForThread(t, issues.filter((i) => t.issueIds.includes(i.id)));
    });
    const all = [...threadCards, ...issues.filter((i) => !linkedIds.has(i.id)).map(cardForIssue)].sort(
      (a, b) => cardRank(a) - cardRank(b)
    );
    const isDone = (c: CardItem) => c.statusKey === 'closed' || c.statusKey === 'done';
    return {
      activeCards: all.filter((c) => !isDone(c)),
      closedCards: all.filter(isDone).slice(0, 8),
    };
  }, [threads, issues]);

  const detailIssue = detailIssueId !== null ? issues.find((i) => i.id === detailIssueId) ?? null : null;

  // Prefill + focus the dock: the card button stages the command, the user
  // reviews and sends it. Card click = read, dock = act.
  const stageCommand = useCallback((mention: string) => {
    setCommand(mention);
    dockInputRef.current?.focus();
  }, []);

  const submitCommand = useCallback(
    async (extra?: { repoChoice?: string; issueId?: number }) => {
      const input = command.trim();
      if (!input || submitting) return;
      setSubmitting(true);
      setCommandError(null);
      try {
        const res = await fetch('/api/threads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input, ...extra }),
        });
        const data = (await res.json().catch(() => null)) as
          | { ok?: boolean; threadId?: number; needsChoice?: boolean; intent?: string; chips?: ResolveChip[]; error?: string }
          | null;
        if (!res.ok) throw new Error(data?.error ?? `command failed (${res.status})`);
        if (data?.needsChoice) {
          setChipAnswer({ intent: data.intent ?? 'implement', chips: data.chips ?? [] });
          return;
        }
        setChipAnswer(null);
        setCommand('');
        if (typeof data?.threadId === 'number') setDetailThreadId(data.threadId);
        void fetchAll();
      } catch (err) {
        setCommandError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    },
    [command, submitting, fetchAll]
  );

  const toggleSelect = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const combineSelected = useCallback(() => {
    const mentions = activeCards
      .filter((c) => selected.has(c.key) && c.issueId != null)
      .map((c) => c.commandMention);
    if (mentions.length === 0) return;
    setCommand(`Come up with a combined strategy for ${mentions.join(', ')}`);
    setSelected(new Set());
    dockInputRef.current?.focus();
  }, [activeCards, selected]);

  const openCard = useCallback((card: CardItem) => {
    if (card.threadId != null) setDetailThreadId(card.threadId);
    else if (card.issueId != null) setDetailIssueId(card.issueId);
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
    <div className="page-wrap v2-page">
      <AppHeader
        title="DevHub"
        connection={{ connected }}
        user={user ? { login: user.login, avatarUrl: user.avatarUrl, onLogout: logout } : undefined}
        controls={
          <button className="ghost" onClick={() => void handleRefresh()} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Refresh'}
          </button>
        }
      />

      <main id="board-main" className="board-main v2-main">
        {commandError && (
          <div className="banner" role="alert">
            <span>{commandError}</span>
            <button className="ghost" onClick={() => setCommandError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {notice && (
          <div className={`banner${notice.kind === 'ok' ? ' banner-success' : ''}`} role="status">
            <span>{notice.text}</span>
            <button className="ghost" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </div>
        )}

        {selected.size > 1 && (
          <div className="v2-combine-bar">
            <span>{selected.size} selected</span>
            <button className="card-primary" onClick={combineSelected}>
              Combine
            </button>
            <button className="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        )}

        <section className="v2-cards" aria-label="Work items">
          {activeCards.length === 0 && <div className="empty">nothing here — tell DevHub what to do below</div>}
          {activeCards.map((card) => (
            <WorkCard
              key={card.key}
              card={card}
              selected={selected.has(card.key)}
              onToggleSelect={() => toggleSelect(card.key)}
              onOpen={() => openCard(card)}
              onCommandOn={() => stageCommand(card.commandMention)}
            />
          ))}
        </section>

        {closedCards.length > 0 && (
          <details className="v2-closed">
            <summary>{closedCards.length} recently closed</summary>
            {closedCards.map((card) => (
              <button key={card.key} type="button" className="v2-closed-item" onClick={() => openCard(card)}>
                <span className="v2-closed-title">{card.title}</span>
                <span className="v2-closed-repo">{card.repo}</span>
                {card.note && <span className="v2-closed-reason">{card.note.replace(/_/g, ' ')}</span>}
              </button>
            ))}
          </details>
        )}

        {chipAnswer && (
          <div className="v2-chips" role="group" aria-label="Clarify command">
            {chipAnswer.chips.map((chip, ci) => (
              <div key={ci} className="v2-chip-row">
                <span className="v2-chip-label">{chip.label}</span>
                {chip.kind === 'repo-choice' &&
                  chip.options.map((opt) => (
                    <button key={opt} className="ghost" onClick={() => void submitCommand({ repoChoice: opt })}>
                      {opt}
                    </button>
                  ))}
                {chip.kind === 'issue-search' && <IssueSearch issues={issues} onPick={(id) => void submitCommand({ issueId: id })} />}
              </div>
            ))}
            <button className="ghost" onClick={() => setChipAnswer(null)}>
              Dismiss
            </button>
          </div>
        )}

        <CommandDock value={command} onChange={setCommand} onSubmit={() => void submitCommand()} busy={submitting} inputRef={dockInputRef} />
      </main>

      {detailIssue && (
        <IssueDetail
          issue={detailIssue}
          onClose={() => setDetailIssueId(null)}
          onWorked={(threadId) => {
            setDetailIssueId(null);
            setDetailThreadId(threadId);
            void fetchAll();
          }}
        />
      )}

      {detailThreadId !== null && <ThreadDetail threadId={detailThreadId} onClose={() => setDetailThreadId(null)} onChanged={() => void fetchAll()} />}
    </div>
  );
}

function IssueSearch({ issues, onPick }: { issues: Issue[]; onPick: (id: number) => void }) {
  const [q, setQ] = useState('');
  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return issues
      .filter(
        (i) =>
          i.state !== 'closed' &&
          (!needle || `${i.title} ${i.owner}/${i.repo} #${i.number}`.toLowerCase().includes(needle))
      )
      .slice(0, 8);
  }, [issues, q]);
  return (
    <div className="v2-issue-search">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="fuzzy title search…" aria-label="Search work items" />
      {hits.map((i) => (
        <button key={i.id} className="ghost" onClick={() => onPick(i.id)}>
          {i.owner}/{i.repo}#{i.number} {i.title}
        </button>
      ))}
    </div>
  );
}
