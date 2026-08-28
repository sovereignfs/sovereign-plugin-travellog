'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, EmptyState, useIsMobile } from '@sovereignfs/ui';
import { formatDateRange } from '../_lib/dates';
import type { WorkspaceDay, WorkspaceItineraryItem, WorkspaceStop } from '../_lib/queries';
import { AddStopDialog } from './AddStopDialog';
import { MainDetailSplit } from './MainDetailSplit';
import { PlannerDayList } from './PlannerDayList';
import { PlannerItemDetailPanel } from './PlannerItemDetailPanel';
import { PlannerStopStrip } from './PlannerStopStrip';
import styles from './PlannerWorkspace.module.css';

interface WorkspaceTrip {
  id: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
}

/**
 * `docs/adhoc/web-planner.md` screens 2 (`T.15` built the shell; `T.16`
 * fills in the day-by-day list) and 3 (no stops yet). Owns `activeStopId`
 * (local state, no navigation — "selecting a stop determines which stop's
 * days render below," `T.15`'s own deliverable), `days` (`T.16`: every day
 * across the *whole* trip, fetched once — switching stops is a client-side
 * filter, never a second round trip, so there's no stale-data flash to
 * worry about), and `selectedItemId` (`T.16`: which item's detail column is
 * open). The one `AddStopDialog` instance both the empty-state prompt and
 * the strip's trailing chip open, so there's exactly one add-a-stop flow
 * regardless of entry point.
 */
export function PlannerWorkspace({
  trip,
  initialStops: stops,
  initialDays,
}: {
  trip: WorkspaceTrip;
  initialStops: WorkspaceStop[];
  initialDays: WorkspaceDay[];
}) {
  const router = useRouter();
  const isMobile = useIsMobile();
  // Not copied into local state — `stops` is the server-fetched prop
  // directly, and `router.refresh()` (after an add or a reorder) is what
  // keeps it current. `PlannerStopStrip` holds its own local, optimistic
  // copy for the brief window a drag is in flight; this component never
  // mutates the list itself.
  const [activeStopId, setActiveStopId] = useState<string | null>(stops[0]?.id ?? null);
  const [addOpen, setAddOpen] = useState(false);
  // `days`, unlike `stops`, *is* copied into local state — item add/reorder/
  // edit/remove all update it directly (no `router.refresh()`), since
  // `_lib/itinerary-items.ts`'s own header comment says mutating an item
  // never touches anything else on this page (no denormalized trip dates to
  // resync, unlike a stop mutation).
  const [days, setDays] = useState(initialDays);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  function handleStopAdded(stopId: string): void {
    setActiveStopId(stopId);
    router.refresh();
  }

  function selectStop(stopId: string): void {
    setActiveStopId(stopId);
    // A different stop's days were never shown together with this
    // selection — clearing it here (rather than leaving a stale item's
    // detail column open over the new stop's day list) is what `T.16`'s
    // review checklist means by "no stale data flash" on switch.
    setSelectedItemId(null);
  }

  function replaceDayItems(tripDayId: string, items: WorkspaceItineraryItem[]): void {
    setDays((prev) => prev.map((d) => (d.id === tripDayId ? { ...d, items } : d)));
  }

  function handleItemChange(itemId: string, patch: Partial<WorkspaceItineraryItem>): void {
    setDays((prev) =>
      prev.map((d) => ({
        ...d,
        items: d.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
      })),
    );
  }

  function handleItemRemoved(itemId: string): void {
    setDays((prev) => prev.map((d) => ({ ...d, items: d.items.filter((item) => item.id !== itemId) })));
    setSelectedItemId(null);
  }

  const daysForActiveStop = days.filter((d) => d.stopId === activeStopId);
  const selectedItem = selectedItemId
    ? (days.flatMap((d) => d.items).find((item) => item.id === selectedItemId) ?? null)
    : null;

  const metaLine =
    stops.length === 0
      ? 'No stops yet · dates not set'
      : `${stops.length} stop${stops.length === 1 ? '' : 's'}${
          trip.startDate && trip.endDate ? ` · ${formatDateRange(trip.startDate, trip.endDate)}` : ''
        }`;

  return (
    <>
      <MainDetailSplit
        list={
          <div className={styles.workspace}>
            <div className={styles.header}>
              <Link href="/travellog/planner" className={styles.backLink}>
                ← Planner
              </Link>
              <h1 className={styles.title}>{trip.name}</h1>
              <p className={styles.meta}>{metaLine}</p>
              {/* `T.19`'s entry point — `CONCEPT.md`'s Planner section: "Trip
                  Mode's entry point lives here, mobile-only." Gated on
                  `useIsMobile()` rather than always showing it: the screen
                  it leads to is explicitly mobile-first (no desktop layout
                  pass has happened for it), so surfacing it on desktop would
                  point at a screen that was never meant to be used there. */}
              {isMobile && stops.length > 0 && (
                <Link href={`/travellog/planner/${trip.id}/mode`} className={styles.startTripMode}>
                  Start Trip Mode →
                </Link>
              )}
            </div>

            {stops.length === 0 ? (
              <EmptyState
                icon="route"
                heading="Add your first stop"
                description="A place, plus when you'll arrive and leave. This trip's overall dates are set from your stops, not the other way around."
                action={<Button onClick={() => setAddOpen(true)}>+ Add a stop</Button>}
              />
            ) : (
              <>
                <PlannerStopStrip
                  tripId={trip.id}
                  stops={stops}
                  activeStopId={activeStopId}
                  onSelectStop={selectStop}
                  onAddStop={() => setAddOpen(true)}
                  onReordered={() => router.refresh()}
                />
                <PlannerDayList
                  days={daysForActiveStop}
                  selectedItemId={selectedItemId}
                  onSelectItem={setSelectedItemId}
                  onDayItemsChange={replaceDayItems}
                />
              </>
            )}
          </div>
        }
        detail={
          selectedItem ? (
            <PlannerItemDetailPanel
              item={selectedItem}
              onClose={() => setSelectedItemId(null)}
              onChange={handleItemChange}
              onRemoved={handleItemRemoved}
            />
          ) : null
        }
      />
      <AddStopDialog tripId={trip.id} open={addOpen} onClose={() => setAddOpen(false)} onAdded={handleStopAdded} />
    </>
  );
}
