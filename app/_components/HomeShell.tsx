'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NavTabs, ThreeColumnLayout, useIsMobile } from '@sovereignfs/ui';
import { TRAVELLOG_NAV } from './TravellogSidebar';
import { TravellogSidebar } from './TravellogSidebar';
import styles from './HomeShell.module.css';

/**
 * The `(home)` route group's shell. Desktop: `ThreeColumnLayout` with the
 * persistent sidebar (`T.5`). Mobile: the same `ThreeColumnLayout` with
 * its sidebar hidden and a `NavTabs` row above the content instead —
 * `ThreeColumnLayout` has no responsive behaviour of its own and a 280px
 * sidebar on a phone left the content column unusable (the plugin's own
 * comments called it "confirmed broken below 768px"; the mobile check-in
 * and Trip Mode screens funnelled straight into it). One tree in both
 * modes — `sidebarHidden` keeps `main` mounted rather than swapping
 * wrappers, so page state survives a rotation across the breakpoint.
 */
export function HomeShell({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  const pathname = usePathname();

  return (
    <div className={styles.homeFrame}>
      <ThreeColumnLayout sidebarWidth={280} sidebarHidden={isMobile}>
        <TravellogSidebar />
        <div className={styles.main}>
          {isMobile && (
            <NavTabs
              aria-label="Travellog sections"
              className={styles.tabs}
              items={TRAVELLOG_NAV.map((item) => ({
                label: item.label,
                href: item.href,
                active: pathname.startsWith(item.href),
              }))}
              renderLink={(item, linkProps) => (
                <Link key={item.href} {...linkProps}>
                  {linkProps.children}
                </Link>
              )}
            />
          )}
          <div className={styles.content}>{children}</div>
        </div>
      </ThreeColumnLayout>
    </div>
  );
}
