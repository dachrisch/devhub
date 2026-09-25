'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import type { Issue } from '@/lib/types';
import { matchesIssue, repoColor } from '@/lib/board-ui';

interface MobileSearchSheetProps {
  query: string;
  onQueryChange: (value: string) => void;
  repos: string[];
  repoFilter: string | null;
  onRepoFilterChange: (repo: string | null) => void;
  issues: Issue[];
  onClose: () => void;
}

// Tappable insertions: tapping a filter appends it to the query instead of
// demanding recall. repo:/owner:/number: match issues only; on the project
// board title:/status: match ideas too.
const FILTER_TAGS = ['repo:', 'title:', 'status:', 'state:', 'owner:', 'body:', 'number:'];

export function MobileSearchSheet({
  query,
  onQueryChange,
  repos,
  repoFilter,
  onRepoFilterChange,
  issues,
  onClose,
}: MobileSearchSheetProps) {
  const matches = useMemo(() => {
    if (!query.trim() && !repoFilter) return [];
    // Same cap as desktop results (20) — one result set, both shells.
    return issues
      .filter((i) => matchesIssue(i, query) && (!repoFilter || `${i.owner}/${i.repo}` === repoFilter))
      .slice(0, 20);
  }, [issues, query, repoFilter]);

  const insertTag = (tag: string) => {
    if (query.includes(tag)) return;
    onQueryChange(query.trim() ? `${query.trim()} ${tag}` : tag);
  };

  return (
    <div className="search-sheet">
      <div className="search-sheet-header">
        <input
          className="search-sheet-input"
          placeholder="Search…  e.g. repo:web title:auth or free text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          autoFocus
          aria-label="Search issues"
        />
        <button className="search-sheet-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>

      <div className="search-sheet-body">
        <div className="search-sheet-section">
          <div className="search-sheet-label">Repos</div>
          <div className="search-sheet-chips">
            <button
              className={`search-sheet-chip${repoFilter === null ? ' active' : ''}`}
              onClick={() => onRepoFilterChange(null)}
            >
              All
            </button>
            {repos.map((r) => (
              <button
                key={r}
                className={`search-sheet-chip${repoFilter === r ? ' active' : ''}`}
                onClick={() => onRepoFilterChange(repoFilter === r ? null : r)}
              >
                <span className="search-sheet-chip-dot" style={{ background: repoColor(r) }} />
                {r}
              </button>
            ))}
          </div>
        </div>

        <div className="search-sheet-section">
          <div className="search-sheet-label">Filters</div>
          <div className="search-sheet-tags">
            {FILTER_TAGS.map((tag) => (
              <button key={tag} type="button" className="search-sheet-tag" onClick={() => insertTag(tag)}>
                {tag}
              </button>
            ))}
          </div>
          <div className="search-sheet-hint">Tap a filter to add it. Combine with plain text, e.g. repo:web auth</div>
        </div>

        <div className="search-sheet-section">
          <div className="search-sheet-label">{matches.length} matches</div>
          <div className="search-sheet-matches">
            {matches.map((issue) => (
              <Link
                key={issue.id}
                href={issue.topicId != null ? `/topics/${issue.topicId}` : issue.htmlUrl}
                className="search-sheet-match"
                onClick={onClose}
              >
                <span className={`dot ${issue.state}`} />
                <span className="search-sheet-match-title">
                  #{issue.number} {issue.title}
                </span>
                <span className="search-sheet-match-state">{issue.state}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}