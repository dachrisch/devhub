'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { Issue } from '@/lib/types';
import {
  excerpt,
  primaryCardAction,
  relTime,
  repoColor,
  urgencyTier,
  type CardActionId,
} from '@/lib/board-ui';
import { useCardActions } from '@/components/board/use-card-actions';
import { DevelopModal } from '@/components/board/develop-modal';
import { CardActionsSheet } from '@/components/board/card-actions-sheet';
import { CardActionsMenu } from '@/components/board/card-actions-menu';
import { RunChips, ScopeBadge, useRuns } from '@/components/board/run-chips';

export type CardVariant = 'desktop' | 'mobile';

export interface IssueCardProps {
  issue: Issue;
  // One component, two shells: desktop keeps a persistent checkbox + anchored
  // overflow menu; mobile drops the checkbox and opens the actions bottom
  // sheet from the ⋯ button. The body/footer logic is shared.
  variant: CardVariant;
  justStarted: boolean;
  onStarted: () => void;
  onStartFailed: () => void;
  selected?: boolean;
  onToggleSelection: (issueId: number) => void;
  // Shaping idea this work came from (suppressed topic cards stay hidden —
  // the badge keeps the studio one hop away without twin cards).
  topicTitle?: string | null;
}

// The desktop menu and the mobile sheet both drive the same `cardActions()`
// list; this is the single dispatcher behind both (previously two near-identical
// switches in IssueCard vs IssueCardSheet).
function createCardActionDispatch(
  issue: Issue,
  live: boolean,
  busy: boolean,
  actions: ReturnType<typeof useCardActions>,
  closeSheet: () => void,
  onToggleSelection: (issueId: number) => void
) {
  return (id: CardActionId) => {
    switch (id) {
      case 'work':
        actions.openModal();
        break;
      case 'to-refinement':
        if (!busy && !live) void actions.transition('refinement');
        break;
      case 'to-backlog':
        if (!busy && !live) void actions.transition('backlog');
        break;
      case 'merge':
        if (
          !busy &&
          !live &&
          window.confirm(
            `Merge the PR for ${issue.owner}/${issue.repo} #${issue.number}? This merges into the base branch.`
          )
        )
          void actions.merge();
        break;
      case 'select-batch':
        onToggleSelection(issue.id);
        break;
      case 'open-github':
        window.open(issue.htmlUrl, '_blank', 'noopener,noreferrer');
        break;
      case 'recap':
        // Recap navigates via its own Link — nothing to dispatch.
        break;
    }
    closeSheet();
  };
}

export function IssueCard({
  issue,
  variant,
  justStarted,
  onStarted,
  onStartFailed,
  selected = false,
  onToggleSelection,
  topicTitle = null,
}: IssueCardProps) {
  const mobile = variant === 'mobile';
  const color = repoColor(`${issue.owner}/${issue.repo}`);
  const live = justStarted || (issue.state === 'developing' && !issue.blockedReason);
  const [sheetOpen, setSheetOpen] = useState(false);
  const actions = useCardActions(issue.id, { onStarted, onStartFailed });
  const {
    busy,
    error,
    modalOpen,
    openModal,
    closeModal,
    command,
    setCommand,
    models,
    selectedModel,
    setSelectedModel,
    start,
  } = actions;

  const isAuthError = error && (/401/.test(error) || /403/.test(error) || /auth/i.test(error));
  const primary = primaryCardAction(issue, live);
  const runs = useRuns(issue.id);
  const dispatch = createCardActionDispatch(issue, live, busy, actions, () => setSheetOpen(false), onToggleSelection);

  // Class-name prefixes keep the two shells' CSS contracts (`.card*` vs
  // `.mobile-card*`) intact while the markup/logic lives in one place.
  const p = mobile ? 'mobile-card' : 'card';
  const ageClass = mobile ? 'mobile-card-age' : `card-strip-age age ${urgencyTier(issue.updatedAt)}`;

  return (
    <div className={p}>
      <div className={`${p}-strip`} style={{ background: `${color}22` }}>
        {!mobile && (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelection(issue.id)}
            className="card-checkbox"
            aria-label={`Select issue ${issue.owner}/${issue.repo} #${issue.number} for batch actions`}
          />
        )}
        <span className={mobile ? 'mobile-card-dot' : 'card-strip-dot'} style={{ background: color }} />
        <span className={mobile ? 'mobile-card-repo' : 'card-strip-repo'} style={{ color }}>
          {issue.owner}/{issue.repo}
        </span>
        <span className={mobile ? 'mobile-card-number' : 'card-strip-number'}>#{issue.number}</span>
        <ScopeBadge issue={issue} />
        <span className={ageClass}>{relTime(issue.updatedAt)}</span>
      </div>

      <div className={`${p}-body`}>
        <Link href={`/topics/${issue.topicId}`} className={mobile ? 'mobile-card-body-link' : 'title-link'}>
          <div className={mobile ? 'mobile-card-title' : 'title'}>{issue.title}</div>
          {issue.body && <div className={mobile ? 'mobile-card-excerpt' : 'excerpt'}>{excerpt(issue.body)}</div>}
        </Link>

        {topicTitle && issue.topicId != null && (
          <div className="card-idea-link">
            <span className="card-idea-dot dot idea" aria-hidden="true" />
            <Link href={`/topics/${issue.topicId}`} className="card-idea-title">
              {topicTitle}
            </Link>
          </div>
        )}
        {issue.linkedPrUrl && issue.state !== 'pr' && (
          <div className="result">
            PR: <a href={issue.linkedPrUrl}>{issue.linkedPrUrl}</a>
          </div>
        )}
        {issue.state === 'pr' && issue.resultPrUrl && (
          <div className="result pr-open" role="status">
            <strong>Pull request opened ✓</strong>{' '}
            <a href={issue.resultPrUrl} target="_blank" rel="noreferrer" title={issue.resultPrUrl}>
              Review it on GitHub ↗
            </a>
          </div>
        )}
        <RunChips issue={issue} runs={runs} />
        {issue.blockedReason && !justStarted && (
          <div className="card-blocked" role="alert">
            <strong>Needs input:</strong> {excerpt(issue.blockedReason)}
          </div>
        )}
        {issue.state === 'refinement' && !issue.blockedReason && issue.resultText && (
          <div className="result">
            <strong>Validation:</strong> {excerpt(issue.resultText)}
          </div>
        )}
        {error && (
          <div className="card-error" role="alert">
            <span>{isAuthError ? 'Session expired — ' : `${error}`}</span>
            {isAuthError && (
              <a href="/api/auth/login" className="card-error-login">
                log in again
              </a>
            )}
          </div>
        )}
        {live &&
          (mobile ? (
            <div className="mobile-card-status">
              <span className="mobile-card-status-dot" />
              {issue.state === 'developing'
                ? `developing${issue.modelId ? `… ${issue.modelId}` : '…'} (live via opencode)`
                : 'working… (live via opencode)'}
            </div>
          ) : (
            <div className="result developing">
              {issue.state === 'developing'
                ? `developing${issue.modelId ? `… ${issue.modelId}` : '…'} (live via opencode)`
                : 'working… (live via opencode)'}
            </div>
          ))}
      </div>

      <div className={`${p}-footer`}>
        {primary.kind === 'work' ? (
          <button className={`${p}-primary`} onClick={openModal} disabled={busy}>
            {primary.label}
          </button>
        ) : (
          <Link
            href={`/topics/${issue.topicId}`}
            className={`${p}-primary ${p}-primary-link`}
          >
            {primary.label}
          </Link>
        )}
        {mobile ? (
          <div className="card-menu">
            <button
              type="button"
              className="card-menu-trigger"
              onClick={() => setSheetOpen(true)}
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={sheetOpen}
            >
              <span />
              <span />
              <span />
            </button>
          </div>
        ) : (
          <CardActionsMenu issue={issue} live={live} onSelect={dispatch} />
        )}
      </div>

      {mobile && sheetOpen && (
        <CardActionsSheet
          issue={issue}
          live={live}
          onClose={() => setSheetOpen(false)}
          onSelect={dispatch}
        />
      )}

      {modalOpen && (
        <DevelopModal
          issue={issue}
          command={command}
          onCommandChange={setCommand}
          models={models}
          selectedModel={selectedModel}
          onSelectedModelChange={setSelectedModel}
          busy={busy}
          error={error}
          onCancel={closeModal}
          onStart={start}
        />
      )}
    </div>
  );
}
