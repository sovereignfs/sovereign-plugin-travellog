'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { Avatar, Icon, Popover } from '@sovereignfs/ui';
import styles from '../travellog.module.css';

export interface TravellogAccountMenuUser {
  name: string | null;
  email: string;
  image: string | null;
}

// Module-scoped and shared by every instance mounted this page load (there's
// only ever one, but this matches the platform's own `AccountMenu.tsx`
// `hydrateSessionOnce` dedup exactly) so a re-render never re-fires the fetch.
let sessionHydrationPromise: Promise<TravellogAccountMenuUser | null> | null = null;

function hydrateSessionOnce(): Promise<TravellogAccountMenuUser | null> {
  sessionHydrationPromise ??= fetch('/api/auth/get-session')
    .then((res) => (res.ok ? res.json() : null))
    .then((data) =>
      data?.user
        ? {
            name: (data.user.name as string | null) ?? null,
            email: (data.user.email as string | undefined) ?? '',
            image: (data.user.image as string | null) ?? null,
          }
        : null,
    )
    .catch(() => null);
  return sessionHydrationPromise;
}

/**
 * The account avatar + dropdown, rendered by `TravellogHeader`. Rebuilt from
 * DS primitives (`Popover`, `Avatar`, `Icon`) because the real platform
 * `AccountMenu` lives outside this plugin's reach under `shell: minimal`:
 * user header (avatar + name + email), Account/Preferences links, then a
 * destructive Sign out posting to the platform's own `/api/account/logout`
 * route. Mirrors Kanban's own `KanbanAccountMenu` (`plugins/sovereign-plugin-
 * kanban.local`) structurally, but diverges on identity: Kanban isn't
 * offline-capable, so it can take `user` straight from its own SSR layout.
 * This plugin is `offline: 'offline-first'`, so `app/layout.tsx` renders no
 * per-user identity at all (its own doc comment explains why) — this
 * component instead fetches `/api/auth/get-session` client-side on mount,
 * exactly like `runtime/app/(platform)/_components/AccountMenu.tsx`'s
 * `hydrateUser`/`hydrateSessionOnce`: a real, live, never-cached network
 * round trip, restoring the real signed-in user's name/email/avatar for
 * whoever is actually looking at the screen right now, without ever baking
 * one user's identity into a document a service worker might precache and
 * later replay to someone else on a shared device.
 */
export function TravellogAccountMenu({ avatarSize = 'md' }: { avatarSize?: 'sm' | 'md' | 'lg' }) {
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState<TravellogAccountMenuUser | null>(null);

  useEffect(() => {
    let cancelled = false;
    hydrateSessionOnce().then((result) => {
      if (!cancelled && result) setUser(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const displayName = user?.name ?? user?.email ?? '';

  function handleSignOut(event: FormEvent<HTMLFormElement>) {
    // Native, non-React submit (matches the platform's own AccountMenu) so it
    // isn't tied to any React state that's about to unmount anyway.
    event.currentTarget.submit();
  }

  return (
    <Popover
      align="right"
      width={240}
      open={open}
      onClose={() => setOpen(false)}
      aria-label="Account menu"
      trigger={
        <button
          type="button"
          className={styles.headerAvatarLink}
          aria-label="Account"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <Avatar
            name={displayName}
            src={user?.image ?? undefined}
            size={avatarSize}
            className={styles.accentAvatar}
          />
        </button>
      }
    >
      <div role="menu" aria-label="Account">
        <div className={styles.accountMenuHeader}>
          <Avatar
            name={displayName}
            src={user?.image ?? undefined}
            size="lg"
            className={styles.accentAvatar}
          />
          <div className={styles.accountMenuUserInfo}>
            {user?.name && <p className={styles.accountMenuName}>{user.name}</p>}
            {user?.email && <p className={styles.accountMenuEmail}>{user.email}</p>}
          </div>
        </div>
        <hr className={styles.accountMenuDivider} />
        <a href="/account" role="menuitem" className={styles.accountMenuItem}>
          <Icon name="user" size="sm" aria-hidden />
          Account
        </a>
        <a href="/account/preferences" role="menuitem" className={styles.accountMenuItem}>
          <Icon name="sliders-horizontal" size="sm" aria-hidden />
          Preferences
        </a>
        <hr className={styles.accountMenuDivider} />
        <form action="/api/account/logout" method="post" onSubmit={handleSignOut}>
          <button
            type="submit"
            role="menuitem"
            className={`${styles.accountMenuItem} ${styles.accountMenuItemDestructive}`}
          >
            <Icon name="log-out" size="sm" aria-hidden />
            Sign out
          </button>
        </form>
      </div>
    </Popover>
  );
}
