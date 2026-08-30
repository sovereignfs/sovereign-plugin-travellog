'use client';

import Link from 'next/link';
import styles from '../travellog.module.css';
import { AppsMenu } from './AppsMenu';
import { TravellogAccountMenu } from './TravellogAccountMenu';

/**
 * Web-only top bar, rendered on every plugin page via the root layout.
 * `shell: minimal` gives the plugin zero platform chrome, so this replaces
 * what the platform's own header would have provided: a way back to
 * Launcher (left) and the current user's identity (right). Mirrors
 * `sovereign-plugin-docs`'s `DocsHeader` / `sovereign-plugin-kanban`'s
 * `KanbanHeader` (identical to each other 1:1) — same compact 48px bar,
 * same brand-badge-links-to-Launcher pattern, same right-side apps
 * switcher + account menu.
 *
 * `'use client'` because it renders `AppsMenu`/`TravellogAccountMenu`
 * (`T.5a`) — both hold their own open/closed popover state. No mobile
 * equivalent exists yet (unlike Kanban's/Docs' own `*MobileHeader`): mobile
 * UI is a whole separate, not-yet-started concept-review pass per
 * `CONCEPT.md`'s "Deferred, not yet planned", so this header is not hidden
 * below any breakpoint — it stays the only chrome on every viewport width
 * until a mobile-specific header exists to take over below it.
 *
 * Takes no `user`/`isAdmin` props (unlike Kanban's/Docs' identical headers):
 * this plugin is `offline: 'offline-first'` and the root layout that renders
 * this component wraps the offline-cached bare route too, so it must never
 * compute per-user identity server-side (`app/layout.tsx`'s own doc comment
 * explains why). `AppsMenu`/`TravellogAccountMenu` each hydrate their own
 * real identity/admin-status client-side instead.
 */
export function TravellogHeader({ instanceName }: { instanceName: string }) {
  const brandInitial = instanceName.charAt(0).toUpperCase() || 'S';

  return (
    <header className={styles.header}>
      <div className={styles.headerLeft}>
        <Link
          href="/launcher"
          className={styles.headerBrandBadge}
          aria-label={`${instanceName} Launcher`}
        >
          {brandInitial}
        </Link>
        <Link href="/travellog" className={styles.headerBrand}>
          <img
            src="/plugin-icons/fs.sovereign.travellog.svg"
            alt=""
            className={styles.headerBrandIcon}
          />
          <span className={styles.headerBrandName}>Travellog</span>
        </Link>
      </div>

      <div className={styles.headerRight}>
        <AppsMenu />
        <TravellogAccountMenu avatarSize="md" />
      </div>
    </header>
  );
}
