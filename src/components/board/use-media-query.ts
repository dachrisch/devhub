'use client';

import { useCallback, useSyncExternalStore } from 'react';

// Mirrors the repo's one mobile breakpoint (`@media (max-width: 768px)` in
// globals.css). Keep this string in sync with that value — see Global
// Constraints in the mobile-board-redesign plan.
export const MOBILE_QUERY = '(max-width: 768px)';

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query]
  );

  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}