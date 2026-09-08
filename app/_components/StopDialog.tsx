'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button, DatePicker, Dialog, FormField } from '@sovereignfs/ui';
import { createStopAction, updateStopAction } from '../actions';
import { compareDateKeys } from '../_lib/dates';
import type { PlaceCandidate } from '../_lib/place-provider';
import type { WorkspaceStop } from '../_lib/queries';
import {
  candidateLocation,
  PlaceSearchField,
  resolvePlaceId,
  SelectedPlaceSummary,
} from './PlaceSearchField';
import styles from './StopDialog.module.css';

/**
 * A `YYYY-MM-DD` dateKey read back from `DatePicker`'s `Date`, and vice
 * versa — deliberately using the `Date` object's own LOCAL calendar
 * components (`getFullYear`/`getMonth`/`getDate`), never UTC ones. This is
 * a different (and simpler) concern than `_lib/dates.ts`'s UTC-noon-anchored
 * arithmetic: that file exists to do DST-safe *math* on stored dateKeys
 * (add N days, compare two keys); this is just reading whatever calendar
 * day the picker's own `Calendar` grid puts under the user's click, which
 * is inherently a local-time concept — round-tripping through UTC here
 * would risk shifting the picked day by one depending on the browser's
 * offset, exactly the class of bug `_lib/dates.ts` exists to avoid
 * elsewhere.
 */
function dateKeyToLocalDate(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}
function localDateToDateKey(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export type StopDialogMode =
  | {
      kind: 'add';
      /** Pre-fills Arrive with the previous stop's departure — the usual "next stop starts where the last one ended". */ defaultArriveKey?:
        string | null;
    }
  | { kind: 'edit'; stop: WorkspaceStop };

/**
 * `docs/adhoc/web-planner.md` screen 4, in both directions: "Add a stop"
 * and — new — editing an existing stop's place or dates (`updateStopAction`
 * existed with no UI, which made a mistyped date unfixable). Place search
 * is the shared `PlaceSearchField`, the same flow as check-in's and the
 * activity dialog's, not a separate implementation.
 *
 * **Both dates are required here, unlike the wireframe's "leave dates
 * blank for now" copy.** `travellog_stops.arrive_date`/`depart_date` are
 * `NOT NULL` at the schema level (`T.10`), and the trip's own denormalized
 * `startDate`/`endDate` — and by extension `resolveTripStatus`'s
 * `hasStops`-implies-dated-range invariant (`T.11`) and the whole
 * date-window auto-link engine (`T.12`) — are built on "a stop with dates
 * always has a real, complete range." The server re-validates everything
 * (format, order, span, overlap with sibling stops); this dialog mirrors
 * the order check inline so that one surfaces before a round trip.
 *
 * A real `<form>`: Enter submits, like `CreateTripDialog`.
 */
export function StopDialog({
  tripId,
  mode,
  open,
  onClose,
  onSaved,
}: {
  tripId: string;
  mode: StopDialogMode;
  open: boolean;
  onClose: () => void;
  /** Called with the stop's id after a successful add/edit, so the caller can select it and refresh. */
  onSaved: (stopId: string) => void;
}) {
  const editing = mode.kind === 'edit' ? mode.stop : null;
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<PlaceCandidate | null>(null);
  const [arriveKey, setArriveKey] = useState<string | null>(null);
  const [departKey, setDepartKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Seed from the mode each time the dialog opens: the edit target's own
  // values, or the add-mode default arrival.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setSelected({
        name: editing.placeName,
        lat: null,
        lng: null,
        existingPlaceId: editing.placeId,
      });
      setArriveKey(editing.arriveDate);
      setDepartKey(editing.departDate);
    } else {
      setSelected(null);
      setArriveKey(mode.kind === 'add' ? (mode.defaultArriveKey ?? null) : null);
      setDepartKey(null);
    }
    setQuery('');
    setError(null);
  }, [open, editing, mode]);

  function handleClose(): void {
    if (submitting) return;
    onClose();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selected || !arriveKey || !departKey || submitting) return;
    if (compareDateKeys(arriveKey, departKey) > 0) {
      setError('A stop can’t depart before it arrives.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const placeId = await resolvePlaceId(selected);
      if (!placeId) {
        setError('That place couldn’t be saved. Try again.');
        return;
      }
      if (editing) {
        const result = await updateStopAction(tripId, editing.id, {
          ...(placeId !== editing.placeId ? { placeId } : {}),
          arriveDate: arriveKey,
          departDate: departKey,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        onSaved(editing.id);
      } else {
        const result = await createStopAction(tripId, {
          placeId,
          arriveDate: arriveKey,
          departDate: departKey,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        onSaved(result.stop.id);
      }
      handleClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      size="md"
      title={editing ? 'Edit stop' : 'Add a stop'}
    >
      <form onSubmit={(e) => void handleSubmit(e)} className={styles.form}>
        {error && (
          <p className={styles.feedbackError} role="status" aria-live="polite">
            {error}
          </p>
        )}

        <FormField label="Place" required>
          {(field) =>
            selected ? (
              <SelectedPlaceSummary
                name={selected.name}
                meta={candidateLocation(selected)}
                onChange={() => setSelected(null)}
              />
            ) : (
              <PlaceSearchField
                id={field.id}
                value={query}
                onChange={setQuery}
                onSelect={setSelected}
                createLabel={(value) => `Create "${value}" as a new place`}
                onCreate={(value) => setSelected({ name: value, lat: null, lng: null })}
              />
            )
          }
        </FormField>

        <div className={styles.dateRow}>
          {/* No `{...field}` spread here, unlike the `Place`/`Input` fields
              above — `DatePicker`'s own props don't accept `id`/
              `aria-describedby`, so `FormField`'s render-prop wiring
              wouldn't connect to anything; `aria-label` below is this
              field's real accessible name instead. */}
          <FormField label="Arrive" required>
            {() => (
              <DatePicker
                aria-label="Arrive"
                value={arriveKey ? dateKeyToLocalDate(arriveKey) : null}
                onChange={(date) => {
                  const key = localDateToDateKey(date);
                  setArriveKey(key);
                  if (departKey && compareDateKeys(key, departKey) > 0) setDepartKey(key);
                }}
                disabled={submitting}
              />
            )}
          </FormField>
          <FormField label="Depart" required>
            {() => (
              <DatePicker
                aria-label="Depart"
                value={departKey ? dateKeyToLocalDate(departKey) : null}
                minDate={arriveKey ? dateKeyToLocalDate(arriveKey) : undefined}
                onChange={(date) => setDepartKey(localDateToDateKey(date))}
                disabled={submitting}
              />
            )}
          </FormField>
        </div>

        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={handleClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            loading={submitting}
            disabled={!selected || !arriveKey || !departKey}
          >
            {submitting ? 'Saving…' : editing ? 'Save stop' : 'Add stop'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
