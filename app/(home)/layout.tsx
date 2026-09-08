import type { ReactNode } from 'react';
import { HomeShell } from '../_components/HomeShell';

/**
 * Route-group layout for every view that keeps the persistent sidebar:
 * Trips, Check-ins, Planner, and Settings. A shared ancestor layout isn't
 * re-fetched by the Next.js App Router on client-side navigation between
 * sibling routes under it, so the sidebar stays mounted with no flash
 * moving between any of these four views (`T.5`'s review checklist) —
 * same rationale as `sovereign-plugin-docs`'s identically-shaped
 * `(home)/layout.tsx`.
 *
 * Fetches nothing — `HomeShell` (client) owns the desktop/mobile fork and
 * `TravellogSidebar` has no per-item quick-access data, just static links.
 */
export default function TravellogHomeLayout({ children }: { children: ReactNode }) {
  return <HomeShell>{children}</HomeShell>;
}
