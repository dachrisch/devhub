'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelOption } from '@/lib/types';

// Shared searchable model picker, used by the develop modal and the cockpit
// composer. `value === null` means "no override" (default tier chain).

interface ModelChoice {
  key: string;
  label: string;
  hint?: string;
  model: ModelOption | null;
}

export function ModelPicker({
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
