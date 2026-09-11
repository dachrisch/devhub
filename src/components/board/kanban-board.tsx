'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import type { Issue, Topic } from '@/lib/types';
import type { FunnelColumn } from '@/lib/funnel';
import { FUNNEL_COLUMNS, funnelColumnForIssue, funnelColumnForTopic } from '@/lib/funnel';
import { countRepos, matchesIssue, matchesTopic } from '@/lib/board-ui';
import { MobileStatusStrip, statusPanelId, statusTabId } from '@/components/board/mobile-status-strip';
import { RefreshButton } from '@/components/board/board-toolbar';
import { IssueCard, IssueCardSheet, MobileIssueCard } from '@/components/board/issue-card';
import { MobileTopicCard, TopicCard } from '@/components/board/topic-card';

export interface KanbanBoardProps {
  // Live pools (delivered history renders separately below the board).
  issues: Issue[];
  topics: Topic[];
  query: string;
  repoFilter: string | null;
  // Shared viewport decision (MOBILE_QUERY) from the page — one subscription
  // per document keeps both shells in sync.
  isMobile: boolean;
  // Manual refresh, surfaced inline in the mobile column-meta row (desktop
  // relies on SSE live updates instead).
  refreshing: boolean;
  onRefresh: () => void;
  // Runs started from this client whose confirmation hasn't arrived via SSE.
  justStartedIds: Set<number>;
  markJustStarted: (id: number) => void;
  clearJustStarted: (id: number) => void;
  selectedIds: Set<number>;
  toggleSelection: (issueId: number) => void;
  // Funnel mapping. Defaults read status/state alone; the project board
  // passes a topic resolver that also consults linked issues.
  columnOfIssue?: (issue: Issue) => FunnelColumn;
  columnOfTopic?: (topic: Topic) => FunnelColumn;
  // Topic card renderer (the page injects promote affordances for unlinked
  // ideas). Defaults to the plain Discuss card.
  renderTopicCard?: (topic: Topic, mobile: boolean) => React.ReactNode;
  // Extra chrome pinned to the top of a column (e.g. Suggest-next + Add-idea
  // in the idea column).
  columnExtras?: Partial<Record<FunnelColumn, React.ReactNode>>;
  // Delivered history lives below the board; the mobile strip surfaces it as
  // a badge button that scrolls down to it.
  doneCount?: number;
  onShowDone?: () => void;
  // Repo filter chips pinned under the status tabs on mobile, where the full
  // toolbar (inside the scroll container) is too easy to miss.
  filterChips?: React.ReactNode;
}

interface Cell {
  key: string;
  updatedAt: string;
  blocked: boolean;
  node: React.ReactNode;
}

export function KanbanBoard({
  issues,
  topics,
  query,
  repoFilter,
  isMobile,
  refreshing,
  onRefresh,
  justStartedIds,
  markJustStarted,
  clearJustStarted,
  selectedIds,
  toggleSelection,
  columnOfIssue = (issue) => funnelColumnForIssue(issue.state),
  columnOfTopic = (topic) => funnelColumnForTopic(topic.status),
  renderTopicCard,
  columnExtras,
  doneCount,
  onShowDone,
  filterChips,
}: KanbanBoardProps) {
  const [sorts, setSorts] = useState<Partial<Record<FunnelColumn, 'newest' | 'oldest'>>>({});
  const [activeColumn, setActiveColumn] = useState<FunnelColumn>('idea');
  const [openActionsFor, setOpenActionsFor] = useState<Issue | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const columnRefs = useRef<Map<FunnelColumn, HTMLElement>>(new Map());

  useEffect(() => {
    // Tab state on mobile is driven directly by the status strip (only one
    // column is ever rendered), so the scroll-position sync below is only
    // needed on desktop where all four columns share the screen.
    if (typeof window === 'undefined' || isMobile) return;

    const observer = new IntersectionObserver(
      (entries) => {
        let best: { col: FunnelColumn; ratio: number } | null = null;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          let col: FunnelColumn | null = null;
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
  }, [isMobile]);

  const counts = Object.fromEntries(
    FUNNEL_COLUMNS.map((c) => [
      c,
      issues.filter((i) => columnOfIssue(i) === c).length + topics.filter((t) => columnOfTopic(t) === c).length,
    ])
  ) as Record<FunnelColumn, number>;

  const cellsFor = (col: FunnelColumn): Cell[] => {
    const dir = sorts[col] === 'oldest' ? 1 : -1;
    const colIssues = issues.filter(
      (i) => columnOfIssue(i) === col && matchesIssue(i, query) && (!repoFilter || `${i.owner}/${i.repo}` === repoFilter)
    );
    const colTopics = topics.filter((t) => columnOfTopic(t) === col && matchesTopic(t, query));
    const cells: Cell[] = [
      ...colTopics.map((topic) => ({
        key: `topic-${topic.id}`,
        updatedAt: topic.updatedAt,
        blocked: false,
        node:
          renderTopicCard?.(topic, isMobile) ??
          (isMobile ? <MobileTopicCard topic={topic} /> : <TopicCard topic={topic} />),
      })),
      ...colIssues.map((issue) => {
        const justStarted = justStartedIds.has(issue.id);
        const onStarted = () => markJustStarted(issue.id);
        const onStartFailed = () => clearJustStarted(issue.id);
        return {
          key: `issue-${issue.id}`,
          updatedAt: issue.updatedAt,
          // Cards needing input float to the top of their column.
          blocked: Boolean(issue.blockedReason) && !justStarted,
          node: isMobile ? (
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
          ),
        };
      }),
    ];
    cells.sort((a, b) => {
      if (a.blocked !== b.blocked) return a.blocked ? -1 : 1;
      return a.updatedAt.localeCompare(b.updatedAt) * dir;
    });
    return cells;
  };

  const toggleSort = (col: FunnelColumn) =>
    setSorts((s) => ({ ...s, [col]: s[col] === 'oldest' ? 'newest' : 'oldest' }));

  // Delivered history is not a column — it renders below the board — but on
  // mobile the strip's Done badge scrolls straight to it.
  const visibleColumns = isMobile ? [activeColumn] : FUNNEL_COLUMNS;

  return (
    <>
      {isMobile && (
        <MobileStatusStrip
          columns={FUNNEL_COLUMNS}
          counts={counts}
          active={activeColumn}
          onSelect={setActiveColumn}
          doneCount={doneCount}
          onShowDone={onShowDone}
        />
      )}
      {isMobile && filterChips && <div className="mobile-filter-row">{filterChips}</div>}

      <div className="board" ref={boardRef}>
        {/* Mobile renders a single column (the active tab); desktop shows all
            four live columns side by side with scroll-sync to the status strip. */}
        {visibleColumns.map((col) => {
          const cells = cellsFor(col);
          const colIssues = issues.filter((i) => columnOfIssue(i) === col);
          const extras = columnExtras?.[col];
          const sortLabel = sorts[col] === 'oldest' ? '↑ oldest' : '↓ newest';
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
                    {cells.length} items · {countRepos(colIssues)} repos
                  </span>
                  <span className="column-meta-actions">
                    <button
                      className="sort-toggle"
                      onClick={() => toggleSort(col)}
                      title={`Sort ${sorts[col] === 'oldest' ? 'oldest' : 'newest'} first`}
                      aria-label={`Sort ${col} ${sorts[col] === 'oldest' ? 'oldest' : 'newest'} first`}
                    >
                      {sortLabel}
                    </button>
                    <RefreshButton refreshing={refreshing} onRefresh={onRefresh} />
                  </span>
                </div>
              ) : (
                <div className="column-head">
                  <span className={`dot ${col}`} />
                  {col}
                  <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({cells.length})</span>
                  <button
                    className="sort-toggle"
                    onClick={() => toggleSort(col)}
                    title={`Sort ${sorts[col] === 'oldest' ? 'oldest' : 'newest'} first`}
                    aria-label={`Sort ${col} ${sorts[col] === 'oldest' ? 'oldest' : 'newest'} first`}
                  >
                    {sortLabel}
                  </button>
                </div>
              )}
              {extras}
              {cells.length === 0 ? (
                <div className="empty">nothing here</div>
              ) : (
                cells.map((cell) => <Fragment key={cell.key}>{cell.node}</Fragment>)
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
    </>
  );
}
