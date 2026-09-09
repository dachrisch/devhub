'use client';

import Link from 'next/link';
import type { Topic } from '@/lib/types';
import { TOPIC_STATUS_LABELS } from '@/lib/types';
import { excerpt, relTime } from '@/lib/board-ui';

export interface TopicCardProps {
  topic: Topic;
  // Rendered in the footer next to "Discuss →" (e.g. a "→ issue" promote
  // button for unlinked ideas). Absent on the topic's own detail page.
  footerExtra?: React.ReactNode;
}

// Idea-column card for the unified funnel: status chip, shaped summary, and
// a "Discuss →" footer — never Work, never batch selection. Topics have no
// repo, so there is no repo strip or age-urgency tier, just a muted stamp.
export function TopicCard({ topic, footerExtra }: TopicCardProps) {
  const summary = topic.shapedSummary ?? topic.notes;
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
          Discuss →
        </Link>
        {footerExtra}
      </div>
    </div>
  );
}

export function MobileTopicCard({ topic, footerExtra }: TopicCardProps) {
  const summary = topic.shapedSummary ?? topic.notes;
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
          Discuss →
        </Link>
        {footerExtra}
      </div>
    </div>
  );
}
