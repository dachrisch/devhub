'use client';

// Batch action bar for selected issues. One component for both shells: inline
// in the desktop header controls, and (via the mobile media query on
// `.batch-actions`) a fixed bottom bar on phones. Keeping the markup singular
// is what let the two shells drift apart (devhub#248 Phase 2).
export interface BatchActionsProps {
  selectedCount: number;
  // Names the real direction (backlog → refinement vs the reverse), never the
  // ambiguous "Advance".
  advanceLabel: string;
  refreshing: boolean;
  onWorkSelected: () => void;
  onAdvanceSelected: () => void;
}

export function BatchActions({
  selectedCount,
  advanceLabel,
  refreshing,
  onWorkSelected,
  onAdvanceSelected,
}: BatchActionsProps) {
  return (
    <div className="batch-actions">
      <button className="develop-batch-btn" onClick={onWorkSelected} disabled={refreshing}>
        Work on selected ({selectedCount})
      </button>
      <button className="advance-btn" onClick={onAdvanceSelected} disabled={refreshing}>
        {advanceLabel}
      </button>
      <div className="keyboard-hints">
        <span>Ctrl+Enter to move</span>
        <span>Esc to clear</span>
      </div>
    </div>
  );
}
