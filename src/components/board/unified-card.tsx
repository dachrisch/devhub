'use client';

import Link from 'next/link';
import type { Issue, Topic } from '@/lib/types';
import { FUNNEL_STAGE_LABELS, type FunnelColumn } from '@/lib/funnel';
import { excerpt, primaryTopicAction, relTime } from '@/lib/board-ui';

// One card type for the unified funnel: ideas render through the same card
// shells (desktop `card` / mobile `mobile-card`) and speak two verbs —
// "Talk it through" (shape) · "Build it" (file + hands-off build) — with the
// studio (/topics/[id]) always one hop away. Filing the GitHub issue happens
// inside the studio with a named consequence, never from the card: a public
// side effect must not hide behind a tooltip. Once an idea has linked work,
// the card carries the lineage (→ owner/repo #N) so the operator never
// drill-ins just to learn what the idea became.

export interface LinkedWork {
  id: number;
  owner: string;
  repo: string;
  number: number;
  state: Issue['state'];
  htmlUrl: string;
}

export interface UnifiedTopicCardProps {
  topic: Topic;
  // Board column the card sits in (work-aware). The strip label follows it —
  // never the raw status — so pill and column can't contradict each other.
  column: FunnelColumn;
  linked?: LinkedWork[];
}

// The strip always names the column the card sits in — never the raw
// status — so pill and column can't contradict each other. The one
// exception is a fresh idea: "New idea" in the Idea column keeps the
// never-opened vs shaping distinction the funnel otherwise erases.
function stripLabel(topic: Topic, column: FunnelColumn): string {
  if (column === 'delivered') return topic.status === 'dropped' ? 'Archived' : 'Delivered';
  if (column === 'idea') return topic.status === 'new' ? 'New idea' : 'Shaping…';
  return FUNNEL_STAGE_LABELS[column];
}

export function UnifiedTopicCard({ topic, column, linked = [] }: UnifiedTopicCardProps) {
  const summary = topic.shapedSummary ?? topic.notes;
  const primary = primaryTopicAction(topic.status);
  const label = stripLabel(topic, column);
  return (
    <div className="card">
      <div className="card-strip">
        <span className={`card-strip-dot dot ${column}`} aria-hidden="true" />
        <span className="card-strip-repo">{label}</span>
        <span className="card-strip-age age">{relTime(topic.updatedAt)}</span>
      </div>

      <div className="card-body">
        <Link
          href={`/topics/${topic.id}`}
          className="title-link"
          aria-label={`Open studio: ${topic.title}`}
        >
          <div className="title">{topic.title}</div>
          {summary && <div className="excerpt">{excerpt(summary)}</div>}
        </Link>
        {linked.length > 0 && <Lineage linked={linked} />}
      </div>

      <div className="card-footer">
        <Link
          href={`/topics/${topic.id}`}
          className="card-primary card-primary-link"
          aria-label={`${primary.label}: ${topic.title}`}
        >
          {primary.label}
        </Link>
      </div>
    </div>
  );
}

export function MobileUnifiedTopicCard({ topic, column, linked = [] }: UnifiedTopicCardProps) {
  const summary = topic.shapedSummary ?? topic.notes;
  const primary = primaryTopicAction(topic.status);
  const label = stripLabel(topic, column);
  return (
    <div className="mobile-card">
      <div className="mobile-card-strip">
        <span className={`mobile-card-dot dot ${column}`} aria-hidden="true" />
        <span className="mobile-card-repo">{label}</span>
        <span className="mobile-card-age">{relTime(topic.updatedAt)}</span>
      </div>
      <div className="mobile-card-body">
        <Link
          href={`/topics/${topic.id}`}
          className="mobile-card-body-link"
          aria-label={`Open studio: ${topic.title}`}
        >
          <span className="mobile-card-title">{topic.title}</span>
          {summary && <div className="mobile-card-excerpt">{excerpt(summary)}</div>}
        </Link>
        {linked.length > 0 && <Lineage linked={linked} />}
      </div>
      <div className="mobile-card-footer">
        <Link
          href={`/topics/${topic.id}`}
          className="mobile-card-primary mobile-card-primary-link"
          aria-label={`${primary.label}: ${topic.title}`}
        >
          {primary.label}
        </Link>
      </div>
    </div>
  );
}

// Visible idea → issue lineage: the one line that answers "what did this
// idea become" without a drill-in. First linked issue only — the studio
// work panel owns the full list.
function Lineage({ linked }: { linked: LinkedWork[] }) {
  const first = linked[0];
  const rest = linked.length - 1;
  return (
    <div className="card-lineage">
      <span className={`card-lineage-dot dot ${first.state}`} aria-hidden="true" />
      <a href={first.htmlUrl} target="_blank" rel="noreferrer" className="card-lineage-link">
        → {first.owner}/{first.repo} #{first.number}
      </a>
      {rest > 0 && <span className="card-lineage-more">+{rest} more</span>}
    </div>
  );
}
