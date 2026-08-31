'use client';

import type { IssueState } from '@/lib/types';

interface MobileStatusStripProps {
  columns: IssueState[];
  counts: Record<IssueState, number>;
  active: IssueState;
  onSelect: (column: IssueState) => void;
}

export function MobileStatusStrip({ columns, counts, active, onSelect }: MobileStatusStripProps) {
  return (
    <nav className="status-strip" role="tablist" aria-label="Board columns">
      {columns.map((col) => (
        <button
          key={col}
          className={`status-strip-tab${active === col ? ' active' : ''}`}
          onClick={() => onSelect(col)}
          role="tab"
          aria-selected={active === col}
          aria-label={`${col} column, ${counts[col] ?? 0} items`}
        >
          <span className={`dot ${col}`} />
          <span>{col}</span>
          <span className="status-strip-badge">{counts[col] ?? 0}</span>
        </button>
      ))}
    </nav>
  );
}