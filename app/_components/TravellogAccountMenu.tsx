'use client';

import { type FormEvent, useState } from 'react';
import { Avatar, Icon, Popover } from '@sovereignfs/ui';
import styles from '../travellog.module.css';

export interface TravellogAccountMenuUser {
  name: string | null;
  email: string;
  image: string | null;
}

/**
 * The account avatar + dropdown, rendered by `TravellogHeader`. Rebuilt from
 * DS primitives (`Popover`, `Avatar`, `Icon`) because the real platform
 * `AccountMenu` lives outside this plugin's reach under `shell: minimal`:
 * user header (avatar + name + email), Account/Preferences links, then a
 * destructive Sign out posting to the platform's own `/api/account/logout`
 * route. Mirrors Kanban's own `KanbanAccountMenu` (`plugins/sovereign-plugin-
 * kanban.local`) verbatim.
 *
 * Account/Preferences are plain `<a>` tags, not `next/link`'s `Link` — those
 * routes live under the platform's own `(platform)` root layout, a different
 * one than this plugin's `(minimal)` root, and `/account` in particular is an
 * intercepting route with no parallel slot reachable across that boundary.
 */
export function TravellogAccountMenu({
  user,
  avatarSize = 'md',
}: {
  user: TravellogAccountMenuUser;
  avatarSize?: 'sm' | 'md' | 'lg';
}) {
  const [open, setOpen] = useState(false);
  const displayName = user.name ?? user.email;

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
            src={user.image ?? undefined}
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
            src={user.image ?? undefined}
            size="lg"
            className={styles.accentAvatar}
          />
          <div className={styles.accountMenuUserInfo}>
            {user.name && <p className={styles.accountMenuName}>{user.name}</p>}
            <p className={styles.accountMenuEmail}>{user.email}</p>
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
