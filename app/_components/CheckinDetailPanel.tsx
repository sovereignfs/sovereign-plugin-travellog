'use client';

import { useEffect, useState, useTransition } from 'react';
import {
  Badge,
  Button,
  ConfirmDialog,
  FormField,
  Icon,
  Input,
  OverlayHeader,
  Select,
  Spinner,
  TagInput,
  Textarea,
  useToast,
} from '@sovereignfs/ui';
import {
  deleteVisitAction,
  listTripsForLinkAction,
  setVisitTripLinkAction,
  updateVisitAction,
  type VisitDetailView,
} from '../actions';
import { formatDateRange, formatLongDate } from '../_lib/dates';
import { plural } from '../_lib/format';
import type { TripLinkOption } from '../_lib/queries';
import {
  formatLocalTime,
  localDateKey,
  localTimeOfDay,
  zoneAbbreviation,
  zonedTimeToUtcMs,
} from '../_lib/timezone';
import styles from './CheckinDetailPanel.module.css';

/**
 * `MainDetailSplit`'s detail column content for the Check-ins screen. Viewing
 * plus the editing the concept always implied but the web UI never had: the
 * note, companions, and the moment (edited in the check-in's *own* zone,
 * never the viewer's — `zonedTimeToUtcMs` turns the wall-clock value back
 * into an instant), deletion behind a `ConfirmDialog`, and both halves of
 * the "auto-link is a suggestion, always overridable" promise — Unlink and
 * a Link-to-trip picker (only Unlink existed before). Each field commits
 * inline (`TripDetailPanel`'s companions pattern) — no separate Save step.
 */
export function CheckinDetailPanel({
  detail,
  loading,
  viewerZone,
  onClose,
  onLinkChanged,
  onEdited,
  onDeleted,
  onFilterByPlace,
  onFilterByTrip,
}: {
  detail: VisitDetailView | null;
  loading: boolean;
  /** The viewer's IANA zone once hydrated — shows a zone label when it differs from the check-in's. */
  viewerZone: string | null;
  onClose: () => void;
  /** Called after a link/unlink so the caller updates its row and re-fetches this same visit. */
  onLinkChanged: (tripId: string | null, tripName: string | null) => void;
  onEdited: () => void;
  onDeleted: () => void;
  onFilterByPlace: (placeId: string) => void;
  onFilterByTrip: (tripId: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [when, setWhen] = useState('');
  const [linking, setLinking] = useState(false);
  const [tripOptions, setTripOptions] = useState<TripLinkOption[] | null>(null);
  const [linkTarget, setLinkTarget] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, startDeleting] = useTransition();

  useEffect(() => {
    if (!detail) return;
    setNote(detail.note ?? '');
    setWhen(
      `${localDateKey(detail.happenedAt, detail.tzIana)}T${localTimeOfDay(detail.happenedAt, detail.tzIana)}`,
    );
  }, [detail]);

  async function save(
    patch: Parameters<typeof updateVisitAction>[1],
    revert: () => void,
  ): Promise<void> {
    if (!detail) return;
    setBusy(true);
    try {
      const result = await updateVisitAction(detail.id, patch);
      if (!result.ok) {
        revert();
        toast.show({ title: 'Couldn’t save', message: result.error, category: 'error' });
        return;
      }
      onEdited();
    } finally {
      setBusy(false);
    }
  }

  function commitNote(): void {
    if (!detail) return;
    const next = note.trim() ? note : null;
    if (next === (detail.note ?? null)) return;
    void save({ note: next }, () => setNote(detail.note ?? ''));
  }

  function commitWhen(): void {
    if (!detail) return;
    const [dateKey, time] = when.split('T');
    if (!dateKey || !time) return;
    const happenedAt = zonedTimeToUtcMs(dateKey, time.slice(0, 5), detail.tzIana);
    if (happenedAt === detail.happenedAt) return;
    void save({ happenedAt }, () =>
      setWhen(
        `${localDateKey(detail.happenedAt, detail.tzIana)}T${localTimeOfDay(detail.happenedAt, detail.tzIana)}`,
      ),
    );
  }

  function commitCompanions(next: string[]): void {
    if (!detail) return;
    void save({ companions: next }, () => undefined);
  }

  async function setLink(tripId: string | null): Promise<void> {
    if (!detail) return;
    setBusy(true);
    try {
      const result = await setVisitTripLinkAction(detail.id, tripId);
      if (!result.ok) {
        toast.show({
          title: tripId ? 'Couldn’t link' : 'Couldn’t unlink',
          message: result.error,
          category: 'error',
        });
        return;
      }
      const tripName = tripId ? (tripOptions?.find((t) => t.id === tripId)?.name ?? null) : null;
      setLinking(false);
      onLinkChanged(tripId, tripName);
    } finally {
      setBusy(false);
    }
  }

  async function openLinkPicker(): Promise<void> {
    setLinking(true);
    if (tripOptions === null) {
      try {
        const options = await listTripsForLinkAction();
        setTripOptions(options);
        setLinkTarget(options[0]?.id ?? '');
      } catch {
        setTripOptions([]);
      }
    }
  }

  const showZone = detail !== null && viewerZone !== null && viewerZone !== detail.tzIana;

  return (
    <div className={styles.panel}>
      <OverlayHeader title={detail?.place.name ?? 'Check-in'} onClose={onClose} />
      <div className={styles.body}>
        {loading && (
          <div className={styles.loading}>
            <Spinner label="Loading check-in…" />
          </div>
        )}
        {!loading && !detail && (
          <p className={styles.missing}>
            This check-in couldn’t be found — it may have been deleted.
          </p>
        )}
        {!loading && detail && (
          <>
            {detail.photos.length > 0 && (
              <div className={styles.photoStrip}>
                {detail.photos.map((photo, index) => (
                  <img
                    key={photo.id}
                    src={photo.url}
                    alt={`${detail.place.name}, ${String(index + 1)} of ${String(detail.photos.length)}`}
                    className={styles.photo}
                  />
                ))}
              </div>
            )}

            <div className={styles.metaRow}>
              <Icon name="calendar" size="sm" aria-hidden={true} />
              <span>
                {formatLongDate(localDateKey(detail.happenedAt, detail.tzIana))} ·{' '}
                {formatLocalTime(detail.happenedAt, detail.tzIana)}
                {showZone && (
                  <span className={styles.zoneHint}>
                    {' '}
                    {zoneAbbreviation(detail.happenedAt, detail.tzIana)}
                  </span>
                )}
              </span>
            </div>

            {detail.place.category && (
              <div className={styles.metaRow}>
                <Icon name="map-pin" size="sm" aria-hidden={true} />
                <span>{detail.place.category}</span>
              </div>
            )}

            <div className={styles.metaRow}>
              <Icon name="history" size="sm" aria-hidden={true} />
              {detail.placeVisitCount > 1 ? (
                <button
                  type="button"
                  className={styles.inlineLink}
                  onClick={() => onFilterByPlace(detail.place.id)}
                >
                  Visited {plural(detail.placeVisitCount, 'time')} — show them all
                </button>
              ) : (
                <span>First time here</span>
              )}
            </div>

            <div className={styles.tripRow}>
              {detail.tripId ? (
                <>
                  <button
                    type="button"
                    className={styles.inlineLink}
                    onClick={() => onFilterByTrip(detail.tripId ?? '')}
                    title="Show every check-in on this trip"
                  >
                    <Badge variant="mono" uppercase={false}>
                      {detail.tripName ?? 'Trip'}
                    </Badge>
                  </button>
                  <button
                    type="button"
                    className={styles.textButton}
                    disabled={busy}
                    onClick={() => void setLink(null)}
                  >
                    Unlink
                  </button>
                </>
              ) : linking ? (
                <div className={styles.linkPicker}>
                  {tripOptions === null ? (
                    <Spinner size="sm" />
                  ) : tripOptions.length === 0 ? (
                    <span className={styles.missing}>No trips to link to yet.</span>
                  ) : (
                    <>
                      <Select
                        aria-label="Trip to link"
                        size="sm"
                        value={linkTarget}
                        onChange={(e) => setLinkTarget(e.target.value)}
                        disabled={busy}
                      >
                        {tripOptions.map((trip) => (
                          <option key={trip.id} value={trip.id}>
                            {trip.name}
                            {trip.startDate && trip.endDate
                              ? ` (${formatDateRange(trip.startDate, trip.endDate)})`
                              : ''}
                          </option>
                        ))}
                      </Select>
                      <Button
                        size="sm"
                        onClick={() => void setLink(linkTarget)}
                        disabled={!linkTarget || busy}
                      >
                        Link
                      </Button>
                    </>
                  )}
                  <button
                    type="button"
                    className={styles.textButton}
                    onClick={() => setLinking(false)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={() => void openLinkPicker()}
                >
                  <Icon name="link" size="sm" aria-hidden={true} />
                  Link to a trip
                </button>
              )}
            </div>

            <FormField label="When" hint={`In the check-in’s own zone (${detail.tzIana})`}>
              {(field) => (
                <Input
                  {...field}
                  type="datetime-local"
                  value={when}
                  disabled={busy}
                  onChange={(e) => setWhen(e.target.value)}
                  onBlur={commitWhen}
                />
              )}
            </FormField>

            <FormField label="Note">
              {(field) => (
                <Textarea
                  {...field}
                  value={note}
                  placeholder="Add a note"
                  disabled={busy}
                  onChange={(e) => setNote(e.target.value)}
                  // A multi-line field — Enter inserts a newline, blur commits.
                  onBlur={commitNote}
                />
              )}
            </FormField>

            <FormField label="With" hint="For your own reference — not shared with anyone.">
              {(field) => (
                <TagInput
                  {...field}
                  value={detail.companions}
                  onChange={commitCompanions}
                  placeholder="Add a name"
                  disabled={busy}
                />
              )}
            </FormField>

            <Button
              variant="secondary"
              className={styles.deleteButton}
              onClick={() => setDeleteOpen(true)}
            >
              <Icon name="trash-2" size="sm" aria-hidden={true} />
              Delete check-in
            </Button>
          </>
        )}
      </div>

      {deleteOpen && detail && (
        <ConfirmDialog
          open
          onClose={() => setDeleteOpen(false)}
          title={`Delete this check-in at ${detail.place.name}?`}
          message="Its note and photos go with it. This can't be undone."
          destructive
          confirmLabel={deleting ? 'Deleting…' : 'Delete'}
          pending={deleting}
          onConfirm={() => {
            startDeleting(async () => {
              const result = await deleteVisitAction(detail.id);
              setDeleteOpen(false);
              if (result.ok) {
                toast.show({ title: 'Check-in deleted', category: 'success' });
                onDeleted();
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
