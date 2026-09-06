'use client';

import Link from 'next/link';
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
import { MobileCard } from '@/components/board/mobile-card';
import { CardActionsSheet } from '@/components/board/card-actions-sheet';
import { CardActionsMenu } from '@/components/board/card-actions-menu';

export interface IssueCardProps {
  issue: Issue;
  justStarted: boolean;
  onStarted: () => void;
  onStartFailed: () => void;
  selected: boolean;
  onToggleSelection: (issueId: number) => void;
}

export function IssueCard({ issue, justStarted, onStarted, onStartFailed, selected, onToggleSelection }: IssueCardProps) {
  const color = repoColor(`${issue.owner}/${issue.repo}`);
  const live = justStarted || (issue.state === 'developing' && !issue.blockedReason);
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
    transition,
  } = useCardActions(issue.id, { onStarted, onStartFailed });

  const isAuthError = error && (/401/.test(error) || /403/.test(error) || /auth/i.test(error));
  const primary = primaryCardAction(issue, live);

  const handleMenuSelect = (id: CardActionId) => {
    switch (id) {
      case 'to-refinement':
        if (!busy && !live) void transition('refinement');
        break;
      case 'to-backlog':
        if (!busy && !live) void transition('backlog');
        break;
      case 'open-github':
        window.open(issue.htmlUrl, '_blank', 'noopener,noreferrer');
        break;
    }
  };

  return (
    <div className="card">
      <div className="card-strip" style={{ background: `${color}22` }}>
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelection(issue.id)}
          className="card-checkbox"
          aria-label={`Select issue ${issue.owner}/${issue.repo} #${issue.number} for batch actions`}
        />
        <span className="card-strip-dot" style={{ background: color }} />
        <span className="card-strip-repo" style={{ color }}>
          {issue.owner}/{issue.repo}
        </span>
        <span className="card-strip-number">#{issue.number}</span>
        <span className={`card-strip-age age ${urgencyTier(issue.updatedAt)}`}>{relTime(issue.updatedAt)}</span>
      </div>

      <div className="card-body">
        <Link href={`/issues/${issue.id}`} className="title-link">
          <div className="title">{issue.title}</div>
          {issue.body && <div className="excerpt">{excerpt(issue.body)}</div>}
        </Link>

        {issue.linkedPrUrl && issue.state !== 'pr' && (
          <div className="result">
            PR: <a href={issue.linkedPrUrl}>{issue.linkedPrUrl}</a>
          </div>
        )}
        {issue.state === 'pr' && issue.resultPrUrl && (
          <div className="result">
            PR: <a href={issue.resultPrUrl}>{issue.resultPrUrl}</a>
          </div>
        )}
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
            {isAuthError && <a href="/api/auth/login" className="card-error-login">log in again</a>}
          </div>
        )}
        {live && (
          <div className="result developing">
            {issue.state === 'developing'
              ? `developing${issue.modelId ? `… ${issue.modelId}` : '…'} (live via opencode)`
              : 'working… (live via opencode)'}
          </div>
        )}
      </div>

      <div className="card-footer">
        {primary.kind === 'work' ? (
          <button className="card-primary" onClick={openModal} disabled={busy}>
            {primary.label}
          </button>
        ) : (
          <Link href={`/issues/${issue.id}`} className="card-primary card-primary-link">
            {primary.label}
          </Link>
        )}
        <CardActionsMenu issue={issue} live={live} onSelect={handleMenuSelect} />
      </div>

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

export function MobileIssueCard({
  issue,
  justStarted,
  onStarted,
  onStartFailed,
  onOpenActions,
}: {
  issue: Issue;
  justStarted: boolean;
  onStarted: () => void;
  onStartFailed: () => void;
  onOpenActions: () => void;
}) {
  const color = repoColor(`${issue.owner}/${issue.repo}`);
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
  } = useCardActions(issue.id, { onStarted, onStartFailed });

  return (
    <>
      <MobileCard
        issue={issue}
        color={color}
        busy={busy}
        justStarted={justStarted}
        onPrimaryAction={openModal}
        onOpenActions={onOpenActions}
      />
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
    </>
  );
}

export function IssueCardSheet({
  issue,
  justStarted,
  onStarted,
  onStartFailed,
  onClose,
  onToggleSelection,
}: {
  issue: Issue;
  justStarted: boolean;
  onStarted: () => void;
  onStartFailed: () => void;
  onClose: () => void;
  onToggleSelection: (issueId: number) => void;
}) {
  const live = justStarted || (issue.state === 'developing' && !issue.blockedReason);
  const {
    busy,
    error,
    modalOpen,
    openModal,
    command,
    setCommand,
    models,
    selectedModel,
    setSelectedModel,
    start,
    transition,
  } = useCardActions(issue.id, { onStarted, onStartFailed });

  const handleSelect = (id: CardActionId) => {
    switch (id) {
      case 'work':
        openModal();
        return;
      case 'to-refinement':
        void transition('refinement');
        break;
      case 'to-backlog':
        void transition('backlog');
        break;
      case 'select-batch':
        onToggleSelection(issue.id);
        break;
      case 'open-github':
        window.open(issue.htmlUrl, '_blank', 'noopener,noreferrer');
        break;
      case 'recap':
        // Recap navigates via its own Link in the sheet row — the sheet's
        // row onClick already closed it. Nothing to do here.
        return;
    }
    onClose();
  };

  if (modalOpen) {
    return (
      <DevelopModal
        issue={issue}
        command={command}
        onCommandChange={setCommand}
        models={models}
        selectedModel={selectedModel}
        onSelectedModelChange={setSelectedModel}
        busy={busy}
        error={error}
        onCancel={onClose}
        onStart={() => {
          void start();
          onClose();
        }}
      />
    );
  }

  return <CardActionsSheet issue={issue} live={live} onClose={onClose} onSelect={handleSelect} />;
}
