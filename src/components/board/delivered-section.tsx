'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Issue, Topic } from '@/lib/types';
import { relTime } from '@/lib/board-ui';

// Delivered history for the unified funnel: closed issues + shipped/dropped
// topics, muted and collapsed below the four live columns. Never a kanban
// column — history must not compete with cards for the first screen.
//
// Unified funnel Phase 5: settled issues get one ribbon per idea instead of
// landing as unrelated entries — the shipped idea and the work that delivered
// it stay visually connected, and each ribbon links back to the studio.
const DELIVERED_CAP = 5;

export interface DeliveredSectionProps {
  issues: Issue[];
  topics: Topic[];
  // The project board scrolls here when the mobile strip's Done badge is tapped.
  sectionRef?: React.Ref<HTMLElement>;
}

export function DeliveredSection({ issues, topics, sectionRef }: DeliveredSectionProps) {
  const [expanded, setExpanded] = useState(false);
  // Group delivered issues under their topic: issue.id → topicId.
  const byTopic = new Map<number, Issue[]>();
  for (const i of issues) {
    if (i.topicId != null) {
      const list = byTopic.get(i.topicId) ?? [];
      list.push(i);
      byTopic.set(i.topicId, list);
    }
  }
  const linkedIds = new Set<number>();
  for (const list of byTopic.values()) for (const i of list) linkedIds.add(i.id);

  const rows = [
    // One ribbon per delivered idea, with its work nested as muted lines.
    ...topics.map((t) => {
      const work = byTopic.get(t.id) ?? [];
      return {
        key: `topic-${t.id}`,
        at: t.updatedAt,
        href: `/topics/${t.id}`,
        label: t.title,
        tag: t.status,
        kind: 'topic' as const,
        work: work.map((i) => ({
          href: `/issues/${i.id}`,
          label: `${i.owner}/${i.repo} #${i.number}: ${i.title}`,
          tag: i.releaseTag ?? i.state,
          at: i.updatedAt,
        })),
      };
    }),
    // Orphan issues (no topic) keep the flat ribbon.
    ...issues
      .filter((i) => !linkedIds.has(i.id))
      .map((i) => ({
        key: `issue-${i.id}`,
        at: i.updatedAt,
        href: `/issues/${i.id}`,
        label: `${i.owner}/${i.repo} #${i.number}: ${i.title}`,
        tag: i.releaseTag ?? i.state,
        kind: 'issue' as const,
        work: [],
      })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  if (rows.length === 0) return null;
  const visible = expanded ? rows : rows.slice(0, DELIVERED_CAP);
  return (
    <section className="delivered-section" aria-label="Delivered history" ref={sectionRef}>
      <span className="released-label">Delivered ({rows.length})</span>
      <div className="released-list">
        {visible.map((row) => (
          <div key={row.key} className="delivered-ribbon">
            <Link href={row.href} className="released-item delivered-item">
              <span className="released-tag delivered-tag">{row.tag}</span>
              <span className="released-title">{row.label}</span>
              {row.work.length > 0 && <span className="delivered-work-count">{row.work.length}</span>}
              <span className="released-time">{relTime(row.at)}</span>
            </Link>
            {row.work.length > 0 && (
              <div className="delivered-ribbon-work">
                {row.work.map((w) => (
                  <Link key={w.href} href={w.href} className="released-item delivered-item delivered-work-line">
                    <span className="released-tag delivered-tag">{w.tag}</span>
                    <span className="released-title">{w.label}</span>
                    <span className="released-time">{relTime(w.at)}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
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
