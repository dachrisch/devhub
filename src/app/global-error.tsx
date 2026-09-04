'use client';

import { useEffect } from 'react';

// Same as error.tsx, but for errors thrown by the root layout itself, which
// error.tsx cannot catch. Next.js requires this boundary to render its own
// <html>/<body> since it replaces the root layout when active.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[app global error boundary]', error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div className="error-boundary">
          <div className="error-boundary-panel">
            <h1>Something went wrong</h1>
            <p className="muted">{error.message || 'An unexpected error occurred.'}</p>
            <div className="error-boundary-actions">
              <button className="btn-primary" onClick={() => reset()}>
                Try again
              </button>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- global-error replaces the root layout, so next/link's router context isn't available here (per Next.js docs) */}
              <a className="ghost-link" href="/">
                Back to board
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
