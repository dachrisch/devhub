'use client';

import { useState, type KeyboardEvent } from 'react';
import type { FunnelColumn } from '@/lib/funnel';

// Shared id scheme between the tabs (rendered here) and the tabpanel they
// control (the single visible column, rendered by the board page). Kept in
// one place so `aria-controls`/`aria-labelledby` can never drift apart.
export const statusTabId = (col: FunnelColumn) => `status-tab-${col}`;
export const statusPanelId = (col: FunnelColumn) => `status-panel-${col}`;

interface MobileStatusStripProps {
  columns: readonly FunnelColumn[];
  counts: Record<FunnelColumn, number>;
  active: FunnelColumn;
  onSelect: (column: FunnelColumn) => void;
  // Delivered history lives below the board, not in a tab: a muted badge
  // button that scrolls to it. Deliberately role="button", not a tab, so the
  // tabs pattern keeps controlling exactly the visible column.
  doneCount?: number;
  onShowDone?: () => void;
}

// Cap on tabs surfaced directly in the strip before the rest fall into the
// "More" overflow menu, so the strip never crowds a narrow screen.
const MAX_MAIN_TABS = 4;

export function MobileStatusStrip({ columns, counts, active, onSelect, doneCount, onShowDone }: MobileStatusStripProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const countOf = (col: FunnelColumn) => counts[col] ?? 0;

  // Populated columns are surfaced as tabs; the active column is always
  // surfaced too (even at zero count) so the tab stays in sync with what's
  // on screen. Anything left over — empty inactive columns plus any tabs that
  // overflowed the cap — lives behind the "More" tab.
  const populated = columns.filter((col) => countOf(col) > 0);
  const main = Array.from(new Set<FunnelColumn>([...populated, active])).slice(0, MAX_MAIN_TABS);
  const more: FunnelColumn[] = columns.filter((col) => !main.includes(col));
  const hasMore = more.length > 0;
  const activeIsMore = hasMore && !main.includes(active);

  const select = (col: FunnelColumn) => {
    onSelect(col);
    setMoreOpen(false);
  };

  // WAI-ARIA tabs pattern: Left/Right/Home/End rove focus across the tabs in
  // the tablist and activate the focused tab (automatic activation). The
  // "More" tab is part of the roving group too, but only opens its menu on
  // Enter/Space — it carries no `data-column` so roving never selects it.
  const onTablistKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const idx = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (idx === -1) return;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    const target = tabs[next];
    target.focus();
    const col = target.dataset.column as FunnelColumn | undefined;
    if (col) select(col);
  };

  return (
    <nav
      className="status-strip"
      role="tablist"
      aria-label="Board columns"
      aria-orientation="horizontal"
      onKeyDown={onTablistKeyDown}
    >
      {main.map((col) => {
        const isActive = active === col;
        return (
          <button
            key={col}
            id={statusTabId(col)}
            className={`status-strip-tab${isActive ? ' active' : ''}`}
            onClick={() => select(col)}
            role="tab"
            aria-selected={isActive}
            aria-controls={statusPanelId(col)}
            // Keep the accessible name aligned with the visible "Ready 21"
            // label (WCAG 2.5.3 Label in Name).
            aria-label={`${col}, ${countOf(col)} items`}
            tabIndex={isActive ? 0 : -1}
            data-column={col}
          >
            <span className={`dot ${col}`} aria-hidden="true" />
            <span>{col}</span>
            <span className="status-strip-badge">{countOf(col)}</span>
          </button>
        );
      })}

      {hasMore && (
        <div className="status-strip-more">
          <button
            className={`status-strip-tab${activeIsMore ? ' active' : ''}`}
            onClick={() => setMoreOpen((o) => !o)}
            role="tab"
            aria-selected={activeIsMore}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            aria-label="More columns"
            tabIndex={activeIsMore ? 0 : -1}
          >
            <span>More</span>
            {activeIsMore && <span className="status-strip-badge">{countOf(active)}</span>}
            <span className="status-strip-caret" aria-hidden="true">
              ▾
            </span>
          </button>
          {moreOpen && (
            <div className="status-strip-more-menu" role="menu" aria-label="Other columns">
              {more.map((col) => (
                <button
                  key={col}
                  id={statusTabId(col)}
                  className={`status-strip-more-item${active === col ? ' active' : ''}`}
                  onClick={() => select(col)}
                  role="menuitem"
                  aria-label={`${col}, ${countOf(col)} items`}
                >
                  <span className={`dot ${col}`} aria-hidden="true" />
                  <span>{col}</span>
                  <span className="status-strip-badge">{countOf(col)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {doneCount != null && doneCount > 0 && onShowDone && (
        <button
          type="button"
          className="status-strip-done"
          onClick={onShowDone}
          aria-label={`Delivered history, ${doneCount} items, below the board`}
        >
          <span className="dot delivered" aria-hidden="true" />
          <span>Done</span>
          <span className="status-strip-badge">{doneCount}</span>
        </button>
      )}
    </nav>
  );
}
