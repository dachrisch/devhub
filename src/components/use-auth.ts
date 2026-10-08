'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export interface MeUser {
  login: string;
  avatarUrl: string | null;
}

// Loads the current GitHub session once. `denied` reflects a `?auth=denied`
// query (callback rejected a non-member) so the UI can show the right screen.
export function useAuth() {
  const [user, setUser] = useState<MeUser | null | undefined>(undefined);
  const [denied] = useState(
    () =>
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('auth') === 'denied'
  );

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me');
      const data = (await res.json()) as { user: MeUser | null };
      setUser(data.user);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    // Fetching the session on mount is the canonical data-loading pattern;
    // setState happens asynchronously after the fetch resolves. The rule
    // react-hooks/set-state-in-effect false-positives on this.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const router = useRouter();

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
    // Full client-side nav resets app state; useAuth re-fetches fresh on mount.
    router.push('/');
  }, [router]);

  return { user, loading: user === undefined, denied, logout, reload };
}