'use client';

import { useEffect, useRef, useState } from 'react';
import type { Issue, IssueState } from '@/lib/types';
import { countRepos, KANBAN_COLUMNS, matchesIssue } from '@/lib/board-ui';
import { MobileStatusStrip, statusPanelId, statusTabId } from '@/components/board/mobile-status-strip';
import { IssueCard, IssueCardSheet, MobileIssueCard } from '@/components/board/issue-card';

export interface KanbanBoardProps {
  // The issue pool to render (already scoped to the page's context).
  issues: Issue[];
  query: string;
  repoFilter: string | null;
  // Shared viewport decision (MOBILE_QUERY) from the page — one subscription
  // per document keeps both shells in sync.
  isMobile: boolean;
  // ReactNode rendered above the board on desktop and inside the scroll
  // container on mobile (e.g. BoardToolbar).
  toolbar: React.ReactNode;
  // Runs started from this client whose confirmation hasn't arrived via SSE.
  justStartedIds: Set<number>;
  markJustStarted: (id: number) => void;
  clearJustStarted: (id: number) => void;
  selectedIds: Set<number>;
  toggleSelection: (issueId: number) => void;
}

export function KanbanBoard({
  issues,
  query,
  repoFilter,
  isMobile,
  toolbar,
  justStartedIds,
  markJustStarted,
  clearJustStarted,
  selectedIds,
  toggleSelection,
}: KanbanBoardProps) {
  const [sorts, setSorts] = useState<Partial<Record<IssueState, 'newest' | 'oldest'>>>({});
  const [activeColumn, setActiveColumn] = useState<IssueState>('backlog');
  const [openActionsFor, setOpenActionsFor] = useState<Issue | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const columnRefs = useRef<Map<IssueState, HTMLElement>>(new Map());

  useEffect(() => {
    // Tab state on mobile is driven directly by the status strip (only one
    // column is ever rendered), so the scroll-position sync below is only
    // needed on desktop where all four columns share the screen.
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
  }, [isMobile]);

  return (
    <>
      {isMobile && (
        <MobileStatusStrip
          columns={KANBAN_COLUMNS}
          counts={Object.fromEntries(
            KANBAN_COLUMNS.map((c) => [c, issues.filter((i) => i.state === c).length])
          ) as Record<IssueState, number>}
          active={activeColumn}
          onSelect={setActiveColumn}
        />
      )}

      <div className="board" ref={boardRef}>
        {/* On mobile the toolbar lives inside the scroll container so it scrolls
            away with the board instead of eating into the fixed chrome. */}
        {isMobile && toolbar}
        {/* Mobile renders a single column (the active tab); desktop shows all
            four columns side by side with scroll-sync to the status strip. */}
        {(isMobile ? [activeColumn] : KANBAN_COLUMNS).map((col) => {
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
    </>
  );
}
