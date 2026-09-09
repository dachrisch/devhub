'use client';

import type { CSSProperties } from 'react';
import { repoColor } from '@/lib/board-ui';

export interface RepoChipsProps {
  repos: string[];
  repoFilter: string | null;
  onRepoFilterChange: (repo: string | null) => void;
}

// Standalone repo filter chips (also rendered in the sticky mobile filter row
// under the status tabs, where the full toolbar would cost too much chrome).
export function RepoChips({ repos, repoFilter, onRepoFilterChange }: RepoChipsProps) {
  if (repos.length <= 1) return null;
  return (
    <div className="repo-chips" role="group" aria-label="Filter by repo">
      <button
        className={`repo-chip${repoFilter === null ? ' active' : ''}`}
        onClick={() => onRepoFilterChange(null)}
      >
        All
      </button>
      {repos.map((r) => {
        const color = repoColor(r);
        return (
          <button
            key={r}
            className={`repo-chip${repoFilter === r ? ' active' : ''}`}
            onClick={() => onRepoFilterChange(repoFilter === r ? null : r)}
            style={{ '--chip-color': color } as CSSProperties}
          >
            <span className="repo-chip-dot" />
            {r}
          </button>
        );
      })}
    </div>
  );
}

export interface BoardToolbarProps extends RepoChipsProps {
  lastRefreshed: Date | null;
  refreshing: boolean;
  onRefresh: () => void;
  showLastRefreshed: boolean;
  // Hide the chips (the mobile filter row renders its own copy).
  hideChips?: boolean;
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Repo filter chips + manual refresh. On desktop it sits above the board;
// on mobile it renders inside the scroll container (see the board page) and
// the "Last refreshed" stamp is dropped — SSE live updates make it redundant.
export function BoardToolbar({
  repos,
  repoFilter,
  onRepoFilterChange,
  lastRefreshed,
  refreshing,
  onRefresh,
  showLastRefreshed,
  hideChips = false,
}: BoardToolbarProps) {
  return (
    <div className="board-toolbar">
      {!hideChips && (
        <RepoChips repos={repos} repoFilter={repoFilter} onRepoFilterChange={onRepoFilterChange} />
      )}
      <div className="toolbar-actions">
        {showLastRefreshed && lastRefreshed && (
          <span className="last-refreshed">Last refreshed {fmtTime(lastRefreshed)}</span>
        )}
        <button className="refresh-btn" onClick={onRefresh} disabled={refreshing} aria-label="Refresh issues">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className={refreshing ? 'spin' : ''}>
            <path d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.001 7.001 0 0114.95 7.16a.75.75 0 01-1.49.178A5.501 5.501 0 008 2.5zM1.705 8.005a.75.75 0 01.834.656 5.501 5.501 0 009.592 2.97l-1.204-1.204a.25.25 0 01.177-.427h3.646a.25.25 0 01.25.25v3.646a.25.25 0 01-.427.177l-1.38-1.38A7.001 7.001 0 011.05 8.84a.75.75 0 01.656-.834z"/>
          </svg>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </div>
  );
}
