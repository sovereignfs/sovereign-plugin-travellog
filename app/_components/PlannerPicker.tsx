'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Badge, Button, EmptyState, PageHeader } from '@sovereignfs/ui';
import type { TripPickerEntry } from '../_lib/queries';
import { formatDateRange } from '../_lib/dates';
import { CreateTripDialog } from './CreateTripDialog';
import styles from './PlannerPicker.module.css';

const STATUS_LABEL: Record<TripPickerEntry['status'], string> = {
  planning: 'Planning',
  upcoming: 'Upcoming',
  ongoing: 'Ongoing',
  completed: 'Completed',
};

function metaLine(trip: TripPickerEntry): string {
  const stopsText = `${String(trip.stopCount)} stop${trip.stopCount === 1 ? '' : 's'}`;
  if (trip.status === 'planning' || !trip.startDate || !trip.endDate) {
    return `${stopsText} planned · dates not set yet`;
  }
  return `${stopsText} · ${formatDateRange(trip.startDate, trip.endDate)}`;
}

/**
 * `docs/adhoc/web-planner.md` screen 1 — the Planner entry point. Only
 * `planning`/`upcoming` trips list here (`_lib/queries.ts`'s
 * `listTripsForPicker`); an already-completed trip's itinerary is edited
 * from Trips instead. "New trip" reuses the exact same `CreateTripDialog`
 * as the Trips screen — one create-trip action, two entry points — which
 * already navigates straight into the new trip's workspace on success.
 */
export function PlannerPicker({ trips }: { trips: TripPickerEntry[] }) {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <PageHeader title="Planner" action={<Button onClick={() => setCreateOpen(true)}>New trip</Button>} />

      {trips.length === 0 ? (
        <EmptyState
          icon="route"
          heading="No trip to plan yet"
          description="Start a new trip and add stops as you go."
          action={<Button onClick={() => setCreateOpen(true)}>Start a trip</Button>}
        />
      ) : (
        <div className={styles.list}>
          {trips.map((trip) => (
            <div key={trip.id} className={styles.row}>
              <Badge variant="mono" uppercase={false}>
                {STATUS_LABEL[trip.status]}
              </Badge>
              <div className={styles.rowMain}>
                <div className={styles.rowName}>{trip.name}</div>
                <div className={styles.rowMeta}>{metaLine(trip)}</div>
              </div>
              <Link href={`/travellog/planner/${trip.id}`} className={styles.openLink}>
                Open →
              </Link>
            </div>
          ))}
        </div>
      )}

      <CreateTripDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}
