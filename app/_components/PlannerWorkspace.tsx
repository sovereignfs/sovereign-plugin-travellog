'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, EmptyState } from '@sovereignfs/ui';
import { formatDateRange } from '../_lib/dates';
import type { WorkspaceStop } from '../_lib/queries';
import { AddStopDialog } from './AddStopDialog';
import { PlannerStopStrip } from './PlannerStopStrip';
import styles from './PlannerWorkspace.module.css';

interface WorkspaceTrip {
  id: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
}

/**
 * `docs/adhoc/web-planner.md` screens 2 (shell only — the day-by-day list
 * itself is `T.16`'s job) and 3 (no stops yet). Owns `activeStopId` (local
 * state, no navigation — "selecting a stop determines which stop's days
 * render below," `T.15`'s own deliverable) and the one `AddStopDialog`
 * instance both the empty-state prompt and the strip's trailing chip open,
 * so there's exactly one add-a-stop flow regardless of entry point.
 */
export function PlannerWorkspace({
  trip,
  initialStops: stops,
}: {
  trip: WorkspaceTrip;
  initialStops: WorkspaceStop[];
}) {
  const router = useRouter();
  // Not copied into local state — `stops` is the server-fetched prop
  // directly, and `router.refresh()` (after an add or a reorder) is what
  // keeps it current. `PlannerStopStrip` holds its own local, optimistic
  // copy for the brief window a drag is in flight; this component never
  // mutates the list itself.
  const [activeStopId, setActiveStopId] = useState<string | null>(stops[0]?.id ?? null);
  const [addOpen, setAddOpen] = useState(false);

  function handleStopAdded(stopId: string): void {
    setActiveStopId(stopId);
    router.refresh();
  }

  const metaLine =
    stops.length === 0
      ? 'No stops yet · dates not set'
      : `${stops.length} stop${stops.length === 1 ? '' : 's'}${
          trip.startDate && trip.endDate ? ` · ${formatDateRange(trip.startDate, trip.endDate)}` : ''
        }`;

  const activeStop = stops.find((s) => s.id === activeStopId) ?? null;

  return (
    <div className={styles.workspace}>
      <div className={styles.header}>
        <Link href="/travellog/planner" className={styles.backLink}>
          ← Planner
        </Link>
        <h1 className={styles.title}>{trip.name}</h1>
        <p className={styles.meta}>{metaLine}</p>
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
            onSelectStop={setActiveStopId}
            onAddStop={() => setAddOpen(true)}
            onReordered={() => router.refresh()}
          />
          {/* `T.16`'s day-by-day itinerary editor renders here, for
              whichever stop is selected in the strip above — not built
              yet, so this is a placeholder, same "build the hook point
              now" precedent as `T.13`'s Planner page stub. */}
          <EmptyState
            icon="list-ordered"
            heading="Day-by-day planning is coming soon"
            description={
              activeStop
                ? `${activeStop.placeName}'s itinerary will appear here once T.16 ships.`
                : 'Select a stop above to plan its days, once T.16 ships.'
            }
          />
        </>
      )}

      <AddStopDialog tripId={trip.id} open={addOpen} onClose={() => setAddOpen(false)} onAdded={handleStopAdded} />
    </div>
  );
}
