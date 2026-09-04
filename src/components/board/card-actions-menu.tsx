'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Issue } from '@/lib/types';
import { cardActions, type CardActionId } from '@/lib/board-ui';

interface CardActionsMenuProps {
  issue: Issue;
  // Run started from this client (or confirmed developing): drop Work and
  // stage moves from the menu, label the recap item as live.
  live?: boolean;
  onSelect: (id: CardActionId) => void;
}

// Desktop counterpart to CardActionsSheet: same cardActions() data driving
// the mobile bottom sheet, rendered as a small anchored dropdown instead —
// desktop has room to keep the primary action visible alongside it, so it
// doesn't need a full-screen sheet. 'work' is filtered out because it's
// already the card's primary footer button; 'select-batch' is filtered out
// because desktop cards keep a persistent checkbox instead.
export function CardActionsMenu({ issue, live = false, onSelect }: CardActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const actions = cardActions(issue, live).filter((a) => a.id !== 'work' && a.id !== 'select-batch');

  return (
    <div className="card-menu" ref={ref}>
      <button
        type="button"
        className="card-menu-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span />
        <span />
        <span />
      </button>
      {open && (
        <div className="card-menu-list" role="menu" aria-label="Issue actions">
          {actions.map((action) =>
            action.id === 'recap' ? (
              <Link
                key={action.id}
                href={`/issues/${issue.id}`}
                className="card-menu-item"
                role="menuitem"
                onClick={() => setOpen(false)}
              >
                {action.label}
              </Link>
            ) : (
              <button
                key={action.id}
                type="button"
                className="card-menu-item"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onSelect(action.id);
                }}
              >
                {action.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
