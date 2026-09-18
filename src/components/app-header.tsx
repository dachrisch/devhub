'use client';

import Link from 'next/link';
import { Logo } from '@/components/logo';
import { Avatar } from '@/components/auth-ui';

export interface AppHeaderProps {
  /** Back link — omitted on cockpit. `onBack` (history-aware back with
   * fallback, e.g. #221) wins over `href` when provided. */
  back?: { href: string; label?: string; onBack?: () => void };
  /** Header title: "DevHub" | project name | <IssueRef chip/> */
  title: React.ReactNode;
  /** Optional status pill / badge next to the title. */
  status?: React.ReactNode;
  /** Connection dot state. */
  connection?: { connected: boolean };
  /** Right-side controls: search, refresh, batch actions. */
  controls?: React.ReactNode;
  /** User info + sign-out. */
  user?: { login: string; avatarUrl: string | null; onLogout: () => void };
}

export function AppHeader({ back, title, status, connection, controls, user }: AppHeaderProps) {
  return (
    <header className="app-head">
      <div className="brand">
        {back && (
          back.onBack ? (
            <button onClick={back.onBack} className="recap-link" aria-label={back.label ?? 'Back'}>
              ←
            </button>
          ) : (
            <Link href={back.href} className="recap-link" aria-label={back.label ?? 'Back'}>
              ←
            </Link>
          )
        )}
        <Logo size={28} />
        <span className="brand-name">{title}</span>
        {status}
      </div>
      <div className="head-controls">
        {controls}
        {connection && (
          <span
            className={`conn-status ${connection.connected ? 'ok' : 'off'}`}
            title={connection.connected ? 'live' : 'connecting…'}
            aria-label={connection.connected ? 'live' : 'connecting…'}
            role="status"
          >
            <span className="conn-dot" />
            {connection.connected ? 'live' : 'connecting…'}
          </span>
        )}
        {user && (
          <>
            <Avatar login={user.login} avatarUrl={user.avatarUrl} />
            <span className="auth-login">{user.login}</span>
            <button className="header-icon-btn" onClick={user.onLogout} aria-label="Sign out">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M2 2.75C2 1.784 2.784 1 3.75 1h2.5a.75.75 0 010 1.5h-2.5a.25.25 0 00-.25.25v10.5c0 .138.112.25.25.25h2.5a.75.75 0 010 1.5h-2.5A1.75 1.75 0 012 13.25V2.75zm10.44 4.5H6.75a.75.75 0 000 1.5h5.69l-1.97 1.97a.75.75 0 101.06 1.06l3.25-3.25a.75.75 0 000-1.06l-3.25-3.25a.75.75 0 10-1.06 1.06l1.97 1.97z" />
              </svg>
            </button>
          </>
        )}
      </div>
    </header>
  );
}
