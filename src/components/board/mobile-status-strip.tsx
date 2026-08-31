'use client';

import { useState } from 'react';
import type { IssueState } from '@/lib/types';

interface MobileStatusStripProps {
  columns: IssueState[];
  counts: Record<IssueState, number>;
  active: IssueState;
  onSelect: (column: IssueState) => void;
}

// Cap on tabs surfaced directly in the strip before the rest fall into the
// "More" overflow menu, so the strip never crowds a narrow screen.
const MAX_MAIN_TABS = 4;

export function MobileStatusStrip({ columns, counts, active, onSelect }: MobileStatusStripProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const countOf = (col: IssueState) => counts[col] ?? 0;

  // Populated columns are surfaced as tabs; the active column is always
  // surfaced too (even at zero count) so the tab stays in sync with what's
  // on screen. Anything left over — empty inactive columns plus any tabs that
  // overflowed the cap — lives behind the "More" tab.
  const populated = columns.filter((col) => countOf(col) > 0);
  const main = Array.from(new Set<IssueState>([...populated, active])).slice(0, MAX_MAIN_TABS);
  const more: IssueState[] = columns.filter((col) => !main.includes(col));
  const hasMore = more.length > 0;
  const activeIsMore = hasMore && !main.includes(active);

  const select = (col: IssueState) => {
    onSelect(col);
    setMoreOpen(false);
  };

  return (
    <nav className="status-strip" role="tablist" aria-label="Board columns">
      {main.map((col) => (
        <button
          key={col}
          className={`status-strip-tab${active === col ? ' active' : ''}`}
          onClick={() => select(col)}
          role="tab"
          aria-selected={active === col}
          aria-label={`${col} column, ${countOf(col)} items`}
        >
          <span className={`dot ${col}`} />
          <span>{col}</span>
          <span className="status-strip-badge">{countOf(col)}</span>
        </button>
      ))}

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
                  className={`status-strip-more-item${active === col ? ' active' : ''}`}
                  onClick={() => select(col)}
                  role="menuitem"
                  aria-label={`${col} column, ${countOf(col)} items`}
                >
                  <span className={`dot ${col}`} />
                  <span>{col}</span>
                  <span className="status-strip-badge">{countOf(col)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </nav>
  );
}