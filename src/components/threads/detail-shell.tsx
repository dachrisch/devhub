'use client';

import { useEffect } from 'react';

// Shared v3 detail shell: NOT a full-screen take-over — a dimmed backdrop
// over the page with a centered detail column, so the appbar (Refresh, user,
// connection) stays mounted and visible. Closes on the back button, Escape,
// or a backdrop click.

interface DetailShellProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

export function DetailShell({ title, onClose, children }: DetailShellProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="v2-detail"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="v2-detail-panel">
        <div className="v2-detail-head">
          <button type="button" className="ghost" onClick={onClose} aria-label="Back to list">
            ← Back
          </button>
        </div>
        <div className="v2-detail-body">{children}</div>
      </div>
    </div>
  );
}
