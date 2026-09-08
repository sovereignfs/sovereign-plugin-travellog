'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@sovereignfs/ui';
import styles from './TravellogSidebar.module.css';

export const TRAVELLOG_NAV = [
  { href: '/travellog/trips', label: 'Trips', icon: 'luggage' as const },
  { href: '/travellog/checkins', label: 'Check-ins', icon: 'map-pin' as const },
  { href: '/travellog/planner', label: 'Planner', icon: 'route' as const },
];

/**
 * Persistent secondary nav — direct structural and active-link-logic copy
 * of `sovereign-plugin-docs`'s `DocsSidebar` (`T.5`'s deliverable): a link
 * list, with a bottom section pinned via `margin-top: auto` reserved for
 * Settings. That Settings link is deliberately not rendered yet: the route
 * (`/travellog/settings`) exists but has no content beyond an empty state,
 * and a permanent nav entry to "nothing to configure yet" is a dead end.
 * Restore it (and `CONCEPT.md`'s bottom-section placement) the moment a
 * real setting ships.
 *
 * No Launcher link here, unlike this file's originally-planned shape in
 * `SPEC.md`'s Architecture section — the root layout's `TravellogHeader`
 * owns that now instead, matching Kanban's and Docs' own real, current
 * pattern (both moved the Launcher link out of their sidebar into a
 * root-level header for exactly this reason: a route with no sidebar,
 * like Trip Mode, `T.19`, still needs a way back). See `SPEC.md`'s `T.5`
 * status entry for the full correction.
 */
export function TravellogSidebar() {
  const pathname = usePathname();

  return (
    <nav className={styles.nav} aria-label="Travellog sections">
      {TRAVELLOG_NAV.map((item) => {
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
    </nav>
  );
}
