'use client';

import { useEffect, useState } from 'react';
import type { Issue, ModelOption } from '@/lib/types';
import { ModelPicker } from '@/components/board/model-picker';

interface DevelopModalProps {
  issue: Issue;
  command: string;
  onCommandChange: (value: string) => void;
  models: ModelOption[];
  selectedModel: ModelOption | null;
  onSelectedModelChange: (model: ModelOption | null) => void;
  busy: boolean;
  error?: string | null;
  onCancel: () => void;
  onStart: () => void;
}

// Start-work modal. For issues carrying a shaped idea (issue.topicId) it
// surfaces the attached idea thread — the shaped context that stage-driven
// runs consume automatically — so the operator knows what will ride along.
export function DevelopModal({
  issue,
  command,
  onCommandChange,
  models,
  selectedModel,
  onSelectedModelChange,
  busy,
  error,
  onCancel,
  onStart,
}: DevelopModalProps) {
  const [ideaMsgCount, setIdeaMsgCount] = useState<number | null>(null);

  useEffect(() => {
    if (issue.topicId == null) return;
    let active = true;
    fetch(`/api/topics/${issue.topicId}/messages`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { messages?: unknown[] } | null) => {
        if (active && d?.messages) setIdeaMsgCount(d.messages.length);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [issue.topicId]);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>
          Develop {issue.owner}/{issue.repo} #{issue.number}
        </h3>
        <p className="modal-sub">{issue.title}</p>
        {ideaMsgCount != null && issue.topicId != null && ideaMsgCount > 0 && (
          <div className="modal-idea-context" aria-label="Idea context attached">
            <span className="dot idea" />
            <span className="modal-idea-label">⊕ idea thread</span>
            <a href={`/topics/${issue.topicId}`} className="modal-idea-link">
              {ideaMsgCount} message{ideaMsgCount === 1 ? '' : 's'} in the studio ↗
            </a>
          </div>
        )}
        <label className="modal-label" htmlFor="devhub-cmd">
          Extra instructions (optional)
        </label>
        <textarea
          id="devhub-cmd"
          className="modal-input"
          placeholder="e.g. focus on the auth flow and keep the diff minimal"
          value={command}
          onChange={(e) => onCommandChange(e.target.value)}
          autoFocus
        />
        <div className="modal-label">Model (optional — default = pinned tiers)</div>
        <ModelPicker models={models} value={selectedModel} onChange={onSelectedModelChange} />
        {error && (
          <div className="card-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button className="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="develop-btn" onClick={onStart} disabled={busy}>
            {busy ? 'Starting…' : 'Start work'}
          </button>
        </div>
      </div>
    </div>
  );
}
