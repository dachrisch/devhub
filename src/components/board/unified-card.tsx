'use client';

import Link from 'next/link';
import type { Topic } from '@/lib/types';
import { TOPIC_STATUS_LABELS } from '@/lib/types';
import { excerpt, primaryTopicAction, relTime, topicPromotable } from '@/lib/board-ui';

// One card type for the unified funnel: ideas and issues render through the
// same card shells (desktop `card` / mobile `mobile-card`) and speak the
// stage-driven vocabulary — Shape (idea) · Work (issue) · Realize (idea gate)
// — with the studio (/topics/[id]) always one hop from an idea's card. Issue
// rendering stays in issue-card.tsx for now (run chips, recap, develop-modal
// wiring live there); the shells here are the seam those internals fold into.

export interface UnifiedTopicCardProps {
  topic: Topic;
  promoting: boolean;
  onPromote?: (topicId: number) => void;
}

export function UnifiedTopicCard({ topic, promoting, onPromote }: UnifiedTopicCardProps) {
  const summary = topic.shapedSummary ?? topic.notes;
  const primary = primaryTopicAction(topic.status);
  const promotable = topicPromotable(topic.status, 0);
  return (
    <div className="card">
      <div className="card-strip">
        <span className={`card-strip-dot dot ${topic.status === 'ready' ? 'ready' : 'idea'}`} />
        <span className="card-strip-repo">{TOPIC_STATUS_LABELS[topic.status] ?? topic.status}</span>
        <span className="card-strip-age age">{relTime(topic.updatedAt)}</span>
      </div>

      <div className="card-body">
        <Link href={`/topics/${topic.id}`} className="title-link">
          <div className="title">{topic.title}</div>
          {summary && <div className="excerpt">{excerpt(summary)}</div>}
        </Link>
      </div>

      <div className="card-footer">
        <Link href={`/topics/${topic.id}`} className="card-primary card-primary-link">
          {primary.label}
        </Link>
        {promotable && onPromote && (
          <button
            type="button"
            className="ghost topic-promote"
            disabled={promoting}
            onClick={() => onPromote(topic.id)}
            title="Promote to a GitHub issue"
          >
            {promoting ? '…' : '→ issue'}
          </button>
        )}
      </div>
    </div>
  );
}

export function MobileUnifiedTopicCard({ topic, promoting, onPromote }: UnifiedTopicCardProps) {
  const summary = topic.shapedSummary ?? topic.notes;
  const primary = primaryTopicAction(topic.status);
  const promotable = topicPromotable(topic.status, 0);
  return (
    <div className="mobile-card">
      <div className="mobile-card-strip">
        <span className={`mobile-card-dot dot ${topic.status === 'ready' ? 'ready' : 'idea'}`} />
        <span className="mobile-card-repo">{TOPIC_STATUS_LABELS[topic.status] ?? topic.status}</span>
        <span className="mobile-card-age">{relTime(topic.updatedAt)}</span>
      </div>
      <div className="mobile-card-body">
        <Link href={`/topics/${topic.id}`} className="mobile-card-body-link">
          <span className="mobile-card-title">{topic.title}</span>
          {summary && <div className="mobile-card-excerpt">{excerpt(summary)}</div>}
        </Link>
      </div>
      <div className="mobile-card-footer">
        <Link href={`/topics/${topic.id}`} className="mobile-card-primary mobile-card-primary-link">
          {primary.label}
        </Link>
        {promotable && onPromote && (
          <button
            type="button"
            className="ghost topic-promote"
            disabled={promoting}
            onClick={() => onPromote(topic.id)}
            title="Promote to a GitHub issue"
          >
            {promoting ? '…' : '→ issue'}
          </button>
        )}
      </div>
    </div>
  );
}
