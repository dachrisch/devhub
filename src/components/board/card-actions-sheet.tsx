'use client';

import Link from 'next/link';
import type { Issue } from '@/lib/types';
import { cardActions, type CardActionId } from '@/lib/board-ui';

interface CardActionsSheetProps {
  issue: Issue;
  // Run started from this client (or confirmed developing): drop Work and
  // stage moves from the sheet, label the recap row as live.
  live?: boolean;
  onClose: () => void;
  onSelect: (id: CardActionId) => void;
}

export function CardActionsSheet({ issue, live = false, onClose, onSelect }: CardActionsSheetProps) {
  const actions = cardActions(issue, live);

  return (
    <div className="card-sheet-backdrop" onClick={onClose}>
      <div className="card-sheet" role="menu" aria-label="Issue actions" onClick={(e) => e.stopPropagation()}>
        <div className="card-sheet-handle" />
        <div className="card-sheet-header">
          <div className="card-sheet-ref">
            {issue.owner}/{issue.repo} #{issue.number}
          </div>
          <div className="card-sheet-title">{issue.title}</div>
        </div>
        {actions.map((action, i) =>
          action.id === 'recap' ? (
            <Link
              key={action.id}
              href={`/issues/${issue.id}`}
              className={`card-sheet-row${i === 0 ? ' card-sheet-row-first' : ''}`}
              role="menuitem"
              onClick={onClose}
            >
              {action.label}
            </Link>
          ) : (
            <button
              key={action.id}
              className={`card-sheet-row${i === 0 ? ' card-sheet-row-first' : ''}`}
              role="menuitem"
              onClick={() => onSelect(action.id)}
            >
              {action.label}
            </button>
          )
        )}
      </div>
    </div>
  );
}
