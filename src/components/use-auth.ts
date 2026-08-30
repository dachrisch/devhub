'use client';

import { useCallback, useEffect, useState } from 'react';

export interface MeUser {
  login: string;
  avatarUrl: string | null;
}

// Loads the current GitHub session once. `denied` reflects a `?auth=denied`
// query (callback rejected a non-member) so the UI can show the right screen.
export function useAuth() {
  const [user, setUser] = useState<MeUser | null | undefined>(undefined);
  const [denied, setDenied] = useState(false);

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
    void reload();
    setDenied(new URLSearchParams(window.location.search).has('auth') && new URLSearchParams(window.location.search).get('auth') === 'denied');
  }, [reload]);

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
    window.location.href = '/';
  }, []);

  return { user, loading: user === undefined, denied, logout, reload };
}