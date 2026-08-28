'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Dialog,
  DatePicker,
  FormField,
  Icon,
  SuggestionInput,
  type SuggestionOption,
} from '@sovereignfs/ui';
import { createPlaceAction, createStopAction, searchPlacesAction } from '../actions';
import { compareDateKeys } from '../_lib/dates';
import type { PlaceCandidate } from '../_lib/place-provider';
import styles from './AddStopDialog.module.css';

const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;

function candidateLocation(candidate: PlaceCandidate): string | null {
  return [candidate.category, candidate.city, candidate.country].filter(Boolean).join(' · ') || null;
}

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

/**
 * `docs/adhoc/web-planner.md` screen 4. Place search is the exact same
 * flow as check-in's (`app/checkin/page.tsx`, `T.3`/`T.7`) — search-first
 * against `searchPlacesAction`, with a manual-create fallback — not a
 * separate implementation, just scoped down (no GPS "check in here" path;
 * planning a stop isn't tied to where the user physically is right now).
 *
 * **Both dates are required here, unlike the wireframe's "leave dates
 * blank for now" copy.** `travellog_stops.arrive_date`/`depart_date` are
 * `NOT NULL` at the schema level (`T.10`), and the trip's own denormalized
 * `startDate`/`endDate` — and by extension `resolveTripStatus`'s
 * `hasStops`-implies-dated-range invariant (`T.11`) and the whole
 * date-window auto-link engine (`T.12`) — are built on "a stop with dates
 * always has a real, complete range." Retrofitting nullable stop dates
 * would mean revisiting three already-shipped tasks' data model and logic
 * for a UI nicety; out of proportion for what this task needs. `createStop`
 * (`_lib/stops.ts`) already validates depart ≥ arrive server-side — this
 * dialog mirrors that check inline so the error surfaces before a round
 * trip, per the wireframe's own stated "Error (expected)" case.
 */
export function AddStopDialog({
  tripId,
  open,
  onClose,
  onAdded,
}: {
  tripId: string;
  open: boolean;
  onClose: () => void;
  /** Called with the new stop's id after a successful add, so the caller can select it in the strip. */
  onAdded: (stopId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<PlaceCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<PlaceCandidate | null>(null);
  const [arriveKey, setArriveKey] = useState<string | null>(null);
  const [departKey, setDepartKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (query.trim().length < MIN_QUERY_LENGTH) {
      setOptions([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      searchPlacesAction(query.trim())
        .then((results) => {
          if (!cancelled) setOptions(results);
        })
        .catch(() => {
          if (!cancelled) setOptions([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const suggestionOptions = useMemo<SuggestionOption[]>(
    () =>
      options.map((candidate, index) => ({
        id: String(index),
        label: candidate.name,
        meta: candidateLocation(candidate) ?? undefined,
        icon: <Icon name="map-pin" size="sm" aria-hidden={true} />,
      })),
    [options],
  );

  function handleClose(): void {
    if (submitting) return;
    setQuery('');
    setOptions([]);
    setSelected(null);
    setArriveKey(null);
    setDepartKey(null);
    setError(null);
    onClose();
  }

  async function handleSubmit(): Promise<void> {
    if (!selected || !arriveKey || !departKey || submitting) return;
    if (compareDateKeys(arriveKey, departKey) > 0) {
      setError('A stop can’t depart before it arrives.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const placeId = selected.existingPlaceId ?? (await resolvePlaceId(selected));
      if (!placeId) {
        setError('That place couldn’t be saved. Try again.');
        return;
      }
      const result = await createStopAction(tripId, { placeId, arriveDate: arriveKey, departDate: departKey });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onAdded(result.stop.id);
      handleClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={handleClose} size="md" title="Add a stop">
      <div className={styles.form}>
        {error && (
          <p className={styles.feedbackError} role="status" aria-live="polite">
            {error}
          </p>
        )}

        <FormField label="Place" required>
          {(field) =>
            selected ? (
              <div className={styles.selectedSummary}>
                <span className={styles.selectedSummaryMain}>
                  <div className={styles.selectedSummaryName}>{selected.name}</div>
                  {candidateLocation(selected) && (
                    <div className={styles.selectedSummaryMeta}>{candidateLocation(selected)}</div>
                  )}
                </span>
                <button type="button" className={styles.changeButton} onClick={() => setSelected(null)}>
                  Change
                </button>
              </div>
            ) : (
              <SuggestionInput
                id={field.id}
                value={query}
                onChange={setQuery}
                options={suggestionOptions}
                loading={searching}
                placeholder="Search for a place"
                aria-label="Search for a place"
                onSelect={(option) => {
                  const candidate = options[Number(option.id)];
                  if (candidate) setSelected(candidate);
                }}
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
            type="button"
            onClick={() => void handleSubmit()}
            loading={submitting}
            disabled={!selected || !arriveKey || !departKey}
          >
            {submitting ? 'Adding…' : 'Add stop'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

async function resolvePlaceId(candidate: PlaceCandidate): Promise<string | null> {
  const result = await createPlaceAction({
    name: candidate.name,
    category: candidate.category,
    lat: candidate.lat,
    lng: candidate.lng,
    address: candidate.address,
    city: candidate.city,
    state: candidate.state,
    country: candidate.country,
    countryCode: candidate.countryCode,
    postalCode: candidate.postalCode,
  });
  return result.ok ? result.place.id : null;
}
