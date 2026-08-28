import type { ReactNode } from 'react';
import { ThreeColumnLayout } from '@sovereignfs/ui';
import { TravellogSidebar } from '../_components/TravellogSidebar';
import styles from './layout.module.css';

/**
 * Route-group layout for every view that keeps the persistent sidebar:
 * Trips, Check-ins, Planner, and Settings. A shared ancestor layout isn't
 * re-fetched by the Next.js App Router on client-side navigation between
 * sibling routes under it, so the sidebar stays mounted with no flash
 * moving between any of these four views (`T.5`'s review checklist) —
 * same rationale as `sovereign-plugin-docs`'s identically-shaped
 * `(home)/layout.tsx`, which this is a direct structural copy of.
 *
 * Unlike Docs' version, this isn't `async` and fetches nothing —
 * `TravellogSidebar` has no per-item quick-access data (no folders/
 * projects-equivalent), just static nav links.
 */
export default function TravellogHomeLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.homeFrame}>
      {/* No wrapper div around `children` — ThreeColumnLayout's own `.main`
          slot already provides `flex: 1; overflow-y: auto`. */}
      <ThreeColumnLayout sidebarWidth={280}>
        <TravellogSidebar />
        {children}
      </ThreeColumnLayout>
    </div>
  );
}
