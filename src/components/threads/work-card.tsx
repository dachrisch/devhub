'use client';

import type { CardItem } from '@/lib/cards';

// Work-item card renderer (single column, needs-input first, then live runs).
// The card shape/ranking lives in @/lib/cards; this file is just the view.
// A Needs-input banner is first-class card UI when blocked_reason is set —
// answering it from the phone is the primary loop.

export type { CardItem };

interface WorkCardProps {
  card: CardItem;
  onOpen: () => void;
  onCommandOn: () => void;
}

export function WorkCard({ card, onOpen, onCommandOn }: WorkCardProps) {
  return (
    <article className="card v2-card" data-card={card.key}>
      <div className="v2-card-top">
        <button type="button" className="v2-card-main" onClick={onOpen} aria-label={`Open ${card.title}`}>
          <span className="v2-card-title">{card.title}</span>
          <span className="v2-card-repo">{card.repo}</span>
          <span className="v2-card-counts">
            work ({card.issueCount}) - ({card.prCount})
          </span>
        </button>
        <div className="v2-card-badges">
          {card.working && card.queuePosition !== 'live' && (
            <span className="v2-working" role="status">
              <span className="v2-working-dot" aria-hidden="true" />
              working
            </span>
          )}
          <span className={`v2-chip v2-chip-${card.statusKey}`}>{card.statusLabel}</span>
        </div>
      </div>
      {card.queuePosition != null && (
        <div className="v2-queue" role="status">
          {card.queuePosition === 'live' ? '● working now' : `queued #${card.queuePosition}`}
        </div>
      )}
      {card.blockedReason && (
        <div className="card-blocked v2-needs-input" role="alert">
          <strong>Needs input</strong>
          <span>{card.blockedReason.slice(0, 300)}</span>
        </div>
      )}
      <div className="v2-card-actions">
        <button type="button" className="ghost" onClick={onCommandOn} aria-label={`Prepare command for ${card.title}`}>
          Work on this
        </button>
      </div>
    </article>
  );
}
