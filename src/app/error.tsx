'use client';

import { useEffect } from 'react';
import Link from 'next/link';

// Catches render/navigation errors for every route under the root layout
// (the board and issue-detail pages). Without this, a transient backend
// failure (e.g. a 503 on the RSC payload for a client-side navigation) left
// the page permanently blank with no way to recover short of a manual reload.
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[app error boundary]', error);
  }, [error]);

  return (
    <div className="error-boundary">
      <div className="error-boundary-panel">
        <h1>Something went wrong</h1>
        <p className="muted">{error.message || 'An unexpected error occurred.'}</p>
        <div className="error-boundary-actions">
          <button className="btn-primary" onClick={() => reset()}>
            Try again
          </button>
          <Link className="ghost-link" href="/">
            Back to board
          </Link>
        </div>
      </div>
    </div>
  );
}
