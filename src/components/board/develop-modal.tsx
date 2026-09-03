'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Issue, ModelOption } from '@/lib/types';

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
        <label className="modal-label" htmlFor="devhub-model">
          Model (optional — default = pinned tiers)
        </label>
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

interface ModelChoice {
  key: string;
  label: string;
  hint?: string;
  model: ModelOption | null;
}

function ModelPicker({
  models,
  value,
  onChange,
}: {
  models: ModelOption[];
  value: ModelOption | null;
  onChange: (model: ModelOption | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => `${m.providerID} ${m.id}`.toLowerCase().includes(q));
  }, [models, query]);

  const choices = useMemo<ModelChoice[]>(() => {
    return [
      { key: '', label: 'Default (no override)', model: null },
      ...filtered.map((m) => ({
        key: `${m.providerID}:${m.id}`,
        label: `${m.id} (${m.providerID})`,
        model: m,
      })),
    ];
  }, [filtered]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(t);
  }, [open]);

  const toggle = () => {
    if (!open) {
      setQuery('');
      setHighlight(0);
    }
    setOpen(!open);
  };

  const select = (choice: ModelChoice) => {
    onChange(choice.model);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, choices.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const choice = choices[highlight];
      if (choice) select(choice);
    }
  };

  const valueKey = value ? `${value.providerID}:${value.id}` : '';

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        id="devhub-model"
        type="button"
        className="model-picker-toggle"
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="model-picker-label">
          {value ? `${value.id} (${value.providerID})` : 'Default (no override)'}
        </span>
        <span className="model-picker-caret">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="model-picker-menu" role="listbox" onKeyDown={onKeyDown}>
          <input
            ref={inputRef}
            className="model-picker-search"
            placeholder="Search models…  e.g. deepseek, gpt, mimo"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
          />
          <div className="model-picker-list">
            {choices.length === 0 && <div className="model-picker-empty">no models found</div>}
            {choices.map((choice, i) => (
              <button
                key={choice.key || '__default__'}
                type="button"
                role="option"
                aria-selected={choice.key === valueKey}
                className={`model-picker-item${i === highlight ? ' highlighted' : ''}${
                  choice.key === valueKey ? ' selected' : ''
                }`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => select(choice)}
              >
                <span className="model-picker-name">{choice.label}</span>
                {choice.hint && <span className="model-picker-hint">{choice.hint}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
