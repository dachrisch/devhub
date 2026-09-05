'use client';

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
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>
          Develop {issue.owner}/{issue.repo} #{issue.number}
        </h3>
        <p className="modal-sub">{issue.title}</p>
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
