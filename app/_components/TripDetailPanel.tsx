'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, FormField, Icon, OverlayHeader, TagInput, useToast } from '@sovereignfs/ui';
import { updateTripAction } from '../actions';
import { daysBetweenDateKeys, formatDateRange } from '../_lib/dates';
import type { TripCard as TripCardData } from '../_lib/queries';
import styles from './TripDetailPanel.module.css';

const STATUS_LABEL: Record<TripCardData['status'], string> = {
  planning: 'Planning',
  upcoming: 'Upcoming',
  ongoing: 'Ongoing',
  completed: 'Completed',
};

/**
 * `docs/adhoc/web-trips.md` screen 3 — the detail column on card click
 * (`T.14`'s "payload 3"). `travellog_trip_members` was never built
 * (`schema.ts`'s header comment: `CONCEPT.md`'s open question 2 resolved
 * toward lightweight companion tags, not real shared access), so this is
 * screen 3's *other* branch: no "Shared with" member list, no
 * `TripShareButton` (screen 5 was cut entirely, per the wireframe's own
 * "Open questions" note) — a plain, editable `trips.companions` field
 * instead, matching `actions.ts`'s own comment that it's "edited through
 * `updateTripAction` like any other."
 *
 * All meta shown here (status, dates, stop/day counts) is already present
 * on the `TripCard` the caller selected — no second fetch for a detail
 * column this thin, same "don't add a round trip for data already in
 * hand" call `T.13` made for its own card grid.
 */
export function TripDetailPanel({
  trip,
  onClose,
  onCompanionsChange,
}: {
  trip: TripCardData;
  onClose: () => void;
  /** Bubbles the new value up so the caller's own `cards` state stays in sync (re-opening the panel later must not show a stale list). */
  onCompanionsChange: (tripId: string, companions: string[]) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [saving, startSaving] = useTransition();
  const dayCount =
    trip.startDate && trip.endDate ? daysBetweenDateKeys(trip.startDate, trip.endDate) + 1 : null;

  function handleCompanionsChange(next: string[]): void {
    const previous = trip.companions;
    onCompanionsChange(trip.id, next);
    startSaving(async () => {
      const result = await updateTripAction(trip.id, { companions: next });
      if (!result.ok) {
        toast.show({ title: 'Couldn’t save', message: result.error, category: 'error' });
        onCompanionsChange(trip.id, previous);
      }
    });
  }

  return (
    <div className={styles.panel}>
      <OverlayHeader title={trip.name} onClose={onClose} />
      <div className={styles.body}>
        <Badge variant="mono" uppercase={false}>
          {STATUS_LABEL[trip.status]}
        </Badge>

        <div className={styles.metaRow}>
          <Icon name="calendar" size="sm" aria-hidden={true} />
          <span>
            {trip.startDate && trip.endDate ? formatDateRange(trip.startDate, trip.endDate) : 'Dates not set yet'}
          </span>
        </div>

        <div className={styles.metaRow}>
          <Icon name="map-pin" size="sm" aria-hidden={true} />
          <span>
            {trip.stopCount} stop{trip.stopCount === 1 ? '' : 's'}
          </span>
        </div>

        {dayCount !== null && (
          <div className={styles.metaRow}>
            <Icon name="layers" size="sm" aria-hidden={true} />
            <span>
              {dayCount} day{dayCount === 1 ? '' : 's'}
            </span>
          </div>
        )}

        <FormField
          label="With"
          hint="For your own reference — not shared with anyone."
          className={styles.companionsField}
        >
          {(field) => (
            <TagInput
              {...field}
              value={trip.companions}
              onChange={handleCompanionsChange}
              placeholder="Add a name"
              disabled={saving}
            />
          )}
        </FormField>

        <Button className={styles.openInPlanner} onClick={() => router.push(`/travellog/planner/${trip.id}`)}>
          Open in Planner →
        </Button>
      </div>
    </div>
  );
}
