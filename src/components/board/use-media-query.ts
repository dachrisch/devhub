'use client';

import { useEffect, useState } from 'react';

// Mirrors the repo's one mobile breakpoint (`@media (max-width: 768px)` in
// globals.css). Keep this string in sync with that value — see Global
// Constraints in the mobile-board-redesign plan.
export const MOBILE_QUERY = '(max-width: 768px)';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
