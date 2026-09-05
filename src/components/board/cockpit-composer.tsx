'use client';

import { useEffect, useRef } from 'react';
import type { ModelOption } from '@/lib/types';
import { ModelPicker } from '@/components/board/model-picker';

// Shared cockpit composer: the prompt entry UI rendered by both shells — the
// mobile FAB bottom sheet (page.tsx) and the desktop expanded form. Multiline
// textarea (Enter submits, Shift+Enter breaks) + model override + submit.
//
// Submitting does not close the shells and does not clear the input on
// failure — the page owns that behavior so a failed POST leaves the prompt
// editable without retyping.

interface CockpitComposerProps {
  input: string;
  onInputChange: (value: string) => void;
  models: ModelOption[];
  selectedModel: ModelOption | null;
  onSelectedModelChange: (model: ModelOption | null) => void;
  onSubmit: () => void;
  busy?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  // Escape closes the shell (backdrop tap is handled by the shell itself).
  onCancel?: () => void;
  // Desktop: render an explicit close button in the controls row.
  closable?: boolean;
}

export function CockpitComposer({
  input,
  onInputChange,
  models,
  selectedModel,
  onSelectedModelChange,
  onSubmit,
  busy = false,
  autoFocus = false,
  placeholder = 'Tell me what you want… (e.g. "Launch a new API", "Fix issue #42")',
  onCancel,
  closable = false,
}: CockpitComposerProps) {
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const t = requestAnimationFrame(() => {
      areaRef.current?.focus();
      // Put the caret at the end so a prefilled (rerun) prompt reads naturally.
      const len = areaRef.current?.value.length ?? 0;
      areaRef.current?.setSelectionRange(len, len);
    });
    return () => cancelAnimationFrame(t);
  }, [autoFocus]);

  useEffect(() => {
    if (!onCancel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const canSubmit = Boolean(input.trim()) && !busy;

  return (
    <form
      className="cockpit-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onSubmit();
      }}
    >
      <textarea
        ref={areaRef}
        className="cockpit-textarea"
        rows={2}
        value={input}
        onChange={(e) => onInputChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter submits; Shift+Enter inserts a newline (standard chat composer).
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canSubmit) onSubmit();
          }
        }}
        placeholder={placeholder}
      />
      <div className="cockpit-controls">
        <ModelPicker models={models} value={selectedModel} onChange={onSelectedModelChange} />
        <button type="submit" className="cockpit-go" disabled={!canSubmit}>
          Go
        </button>
        {closable && onCancel && (
          <button
            type="button"
            className="cockpit-expanded-close"
            onClick={onCancel}
            aria-label="Collapse command input"
          >
            ×
          </button>
        )}
      </div>
      <div className="cockpit-hint">Enter to run · Shift+Enter for a new line</div>
    </form>
  );
}
