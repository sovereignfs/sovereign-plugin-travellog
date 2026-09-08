'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  ConfirmDialog,
  FormField,
  Icon,
  Input,
  OverlayHeader,
  TagInput,
  useCommitOnEnterOrBlur,
  useToast,
} from '@sovereignfs/ui';
import { deleteTripAction, updateTripAction } from '../actions';
import { daysBetweenDateKeys, formatDateRange } from '../_lib/dates';
import { plural } from '../_lib/format';
import type { TripCard as TripCardData } from '../_lib/queries';
import { TripAttachments } from './TripAttachments';
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
 * screen 3's *other* branch: no "Shared with" member list — a plain,
 * editable `trips.companions` field instead.
 *
 * Also the trip's only home for rename and delete (both actions existed
 * server-side with no UI), and the "N check-ins on this trip" link into
 * the filtered timeline — the cheap end of the deferred planned-vs-actual
 * view, just surfacing the join the auto-link engine already makes.
 * Attachments include day-level ones, each labelled with its date.
 */
export function TripDetailPanel({
  trip,
  onClose,
  onTripChange,
  onDeleted,
}: {
  trip: TripCardData;
  onClose: () => void;
  /** Bubbles field edits up so the caller's own `cards` state stays in sync (re-opening the panel later must not show a stale value). */
  onTripChange: (tripId: string, patch: Partial<Pick<TripCardData, 'companions' | 'name'>>) => void;
  onDeleted: (tripId: string) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [saving, startSaving] = useTransition();
  const [name, setName] = useState(trip.name);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, startDeleting] = useTransition();
  const dayCount =
    trip.startDate && trip.endDate ? daysBetweenDateKeys(trip.startDate, trip.endDate) + 1 : null;

  function commitName(): void {
    const next = name.trim();
    if (!next) {
      setName(trip.name);
      return;
    }
    if (next === trip.name) return;
    const previous = trip.name;
    onTripChange(trip.id, { name: next });
    startSaving(async () => {
      const result = await updateTripAction(trip.id, { name: next });
      if (!result.ok) {
        onTripChange(trip.id, { name: previous });
        setName(previous);
        toast.show({ title: 'Couldn’t rename', message: result.error, category: 'error' });
        return;
      }
      router.refresh();
    });
  }
  const nameHandlers = useCommitOnEnterOrBlur(commitName);

  function handleCompanionsChange(next: string[]): void {
    const previous = trip.companions;
    onTripChange(trip.id, { companions: next });
    startSaving(async () => {
      const result = await updateTripAction(trip.id, { companions: next });
      if (!result.ok) {
        toast.show({ title: 'Couldn’t save', message: result.error, category: 'error' });
        onTripChange(trip.id, { companions: previous });
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

        <FormField label="Name" required>
          {(field) => (
            <Input
              {...field}
              value={name}
              disabled={saving}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={nameHandlers.onKeyDown}
              onBlur={nameHandlers.onBlur}
            />
          )}
        </FormField>

        <div className={styles.metaRow}>
          <Icon name="calendar" size="sm" aria-hidden={true} />
          <span>
            {trip.startDate && trip.endDate
              ? formatDateRange(trip.startDate, trip.endDate)
              : 'Dates not set yet'}
          </span>
        </div>

        <div className={styles.metaRow}>
          <Icon name="map-pin" size="sm" aria-hidden={true} />
          <span>
            {trip.destinationSummary ? `${trip.destinationSummary} · ` : ''}
            {plural(trip.stopCount, 'stop')}
          </span>
        </div>

        {dayCount !== null && (
          <div className={styles.metaRow}>
            <Icon name="layers" size="sm" aria-hidden={true} />
            <span>{plural(dayCount, 'day')}</span>
          </div>
        )}

        <div className={styles.metaRow}>
          <Icon name="history" size="sm" aria-hidden={true} />
          {trip.checkinCount > 0 ? (
            <Link
              href={`/travellog/checkins?tripId=${encodeURIComponent(trip.id)}`}
              className={styles.inlineLink}
            >
              {plural(trip.checkinCount, 'check-in')} on this trip →
            </Link>
          ) : (
            <span>No check-ins on this trip yet</span>
          )}
        </div>

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

        <TripAttachments key={trip.id} tripId={trip.id} />

        <div className={styles.actions}>
          <Link href={`/travellog/planner/${trip.id}`} className={styles.primaryLink}>
            Open in Planner →
          </Link>
          {trip.status === 'ongoing' && (
            <Link href={`/travellog/planner/${trip.id}/mode`} className={styles.secondaryLink}>
              Open Trip Mode →
            </Link>
          )}
          <Button
            variant="secondary"
            size="sm"
            className={styles.deleteButton}
            onClick={() => setDeleteOpen(true)}
          >
            <Icon name="trash-2" size="sm" aria-hidden={true} />
            Delete trip
          </Button>
        </div>
      </div>

      {deleteOpen && (
        <ConfirmDialog
          open
          onClose={() => setDeleteOpen(false)}
          title={`Delete "${trip.name}"?`}
          message="Every stop, day, activity, and attachment in it goes too. Check-ins stay — they just won't be linked to this trip anymore. This can't be undone."
          destructive
          confirmLabel={deleting ? 'Deleting…' : 'Delete trip'}
          pending={deleting}
          onConfirm={() => {
            startDeleting(async () => {
              const result = await deleteTripAction(trip.id);
              setDeleteOpen(false);
              if (result.ok) {
                toast.show({ title: 'Trip deleted', category: 'success' });
                onDeleted(trip.id);
              } else {
                toast.show({ title: 'Couldn’t delete', message: result.error, category: 'error' });
              }
            });
          }}
        />
      )}
    </div>
  );
}
