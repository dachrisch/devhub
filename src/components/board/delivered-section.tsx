'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Issue, Topic } from '@/lib/types';
import { relTime } from '@/lib/board-ui';

// Delivered history for the unified funnel: closed issues + shipped/dropped
// topics, muted and collapsed below the four live columns. Never a kanban
// column — history must not compete with cards for the first screen.
const DELIVERED_CAP = 5;

export interface DeliveredSectionProps {
  issues: Issue[];
  topics: Topic[];
  // The project board scrolls here when the mobile strip's Done badge is tapped.
  sectionRef?: React.Ref<HTMLElement>;
}

export function DeliveredSection({ issues, topics, sectionRef }: DeliveredSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const rows = [
    ...issues.map((i) => ({
      key: `issue-${i.id}`,
      at: i.updatedAt,
      href: `/issues/${i.id}`,
      label: `${i.owner}/${i.repo} #${i.number}: ${i.title}`,
      tag: i.releaseTag ?? i.state,
    })),
    ...topics.map((t) => ({
      key: `topic-${t.id}`,
      at: t.updatedAt,
      href: `/topics/${t.id}`,
      label: t.title,
      tag: t.status,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  if (rows.length === 0) return null;
  const visible = expanded ? rows : rows.slice(0, DELIVERED_CAP);
  return (
    <section className="delivered-section" aria-label="Delivered history" ref={sectionRef}>
      <span className="released-label">Delivered ({rows.length})</span>
      <div className="released-list">
        {visible.map((row) => (
          <Link key={row.key} href={row.href} className="released-item delivered-item">
            <span className="released-tag delivered-tag">{row.tag}</span>
            <span className="released-title">{row.label}</span>
            <span className="released-time">{relTime(row.at)}</span>
          </Link>
        ))}
      </div>
      {rows.length > DELIVERED_CAP && (
        <button className="released-toggle" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Collapse' : `+${rows.length - DELIVERED_CAP} more`}
        </button>
      )}
    </section>
  );
}
