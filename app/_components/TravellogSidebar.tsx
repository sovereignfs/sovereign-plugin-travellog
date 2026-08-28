'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@sovereignfs/ui';
import styles from './TravellogSidebar.module.css';

const NAV = [
  { href: '/travellog/trips', label: 'Trips', icon: 'luggage' as const },
  { href: '/travellog/checkins', label: 'Check-ins', icon: 'map-pin' as const },
  { href: '/travellog/planner', label: 'Planner', icon: 'route' as const },
];

const SETTINGS_HREF = '/travellog/settings';

/**
 * Persistent secondary nav — direct structural and active-link-logic copy
 * of `sovereign-plugin-docs`'s `DocsSidebar` (`T.5`'s deliverable): a link
 * list, then a bottom section pinned via `margin-top: auto` for Settings.
 * No quick-access groups (Docs has folders, Kanban has projects) —
 * Travellog has nothing analogous at the sidebar level; Trips itself is
 * where trips get browsed.
 *
 * No Launcher link here, unlike this file's originally-planned shape in
 * `SPEC.md`'s Architecture section — the root layout's `TravellogHeader`
 * owns that now instead, matching Kanban's and Docs' own real, current
 * pattern (both moved the Launcher link out of their sidebar into a
 * root-level header for exactly this reason: a route with no sidebar,
 * like the future Trip Mode screen, `T.19`, still needs a way back). See
 * `SPEC.md`'s `T.5` status entry for the full correction.
 */
export function TravellogSidebar() {
  const pathname = usePathname();

  return (
    <nav className={styles.nav} aria-label="Travellog sections">
      {NAV.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={[styles.link, active ? styles.linkActive : ''].filter(Boolean).join(' ')}
            aria-current={active ? 'page' : undefined}
          >
            <Icon name={item.icon} size="sm" aria-hidden={true} />
            {item.label}
          </Link>
        );
      })}

      <div className={styles.bottomSection}>
        <div className={styles.divider} />
        <Link
          href={SETTINGS_HREF}
          className={[styles.link, pathname === SETTINGS_HREF ? styles.linkActive : '']
            .filter(Boolean)
            .join(' ')}
          aria-current={pathname === SETTINGS_HREF ? 'page' : undefined}
        >
          <Icon name="settings" size="sm" aria-hidden={true} />
          Settings
        </Link>
      </div>
    </nav>
  );
}
