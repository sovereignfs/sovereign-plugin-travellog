'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Dialog,
  FormField,
  Icon,
  SuggestionInput,
  type SuggestionOption,
} from '@sovereignfs/ui';
import { createItineraryItemAction, createPlaceAction, searchPlacesAction } from '../actions';
import type { PlaceCandidate } from '../_lib/place-provider';
import type { WorkspaceItineraryItem } from '../_lib/queries';
import styles from './AddItineraryItemDialog.module.css';

const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;

function candidateLocation(candidate: PlaceCandidate): string | null {
  return [candidate.category, candidate.city, candidate.country].filter(Boolean).join(' · ') || null;
}

/**
 * No dedicated wireframe screen — `docs/adhoc/web-planner.md`'s engineering
 * notes call for reusing screen 4's place-search flow (`AddStopDialog`),
 * scoped down: no dates (the day is already fixed by which "+ Add activity"
 * row opened this), and a second path the stop dialog doesn't need — an
 * item can be title-only, with no resolved place at all
 * (`itinerary-items.ts`'s `assertValid`: needs *either* a place or a title).
 * `SuggestionInput`'s existing `onSelect`/`onCreate` pair maps onto that
 * split directly: picking a real suggestion resolves a place exactly like
 * `AddStopDialog`; "add without a place" instead skips place creation
 * entirely and stores the typed text as `title`. Planned time, the Fixed
 * toggle, and notes are edited afterward in the detail column (screen 5),
 * not here — matches "clicking an item row opens the detail column" already
 * being the only documented way to reach that panel.
 */
export function AddItineraryItemDialog({
  tripDayId,
  open,
  onClose,
  onAdded,
}: {
  tripDayId: string;
  open: boolean;
  onClose: () => void;
  onAdded: (item: WorkspaceItineraryItem) => void;
}) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<PlaceCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedPlace, setSelectedPlace] = useState<PlaceCandidate | null>(null);
  const [titleOnly, setTitleOnly] = useState<string | null>(null);
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
    setSelectedPlace(null);
    setTitleOnly(null);
    setError(null);
    onClose();
  }

  async function handleSubmit(): Promise<void> {
    if ((!selectedPlace && !titleOnly) || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      let placeId: string | null = null;
      if (selectedPlace) {
        placeId = selectedPlace.existingPlaceId ?? (await resolvePlaceId(selectedPlace));
        if (!placeId) {
          setError('That place couldn’t be saved. Try again.');
          return;
        }
      }
      const result = await createItineraryItemAction(tripDayId, {
        placeId,
        title: selectedPlace ? null : titleOnly,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onAdded({
        id: result.item.id,
        tripDayId,
        placeId,
        placeName: selectedPlace?.name ?? null,
        placeCategory: selectedPlace?.category ?? null,
        title: selectedPlace ? null : titleOnly,
        plannedTime: null,
        isFixed: false,
        notes: null,
        position: result.item.position,
      });
      handleClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={handleClose} size="md" title="Add activity">
      <div className={styles.form}>
        {error && (
          <p className={styles.feedbackError} role="status" aria-live="polite">
            {error}
          </p>
        )}

        <FormField label="Activity" required>
          {(field) =>
            selectedPlace || titleOnly !== null ? (
              <div className={styles.selectedSummary}>
                <span className={styles.selectedSummaryMain}>
                  <div className={styles.selectedSummaryName}>{selectedPlace?.name ?? titleOnly}</div>
                  {selectedPlace && candidateLocation(selectedPlace) && (
                    <div className={styles.selectedSummaryMeta}>{candidateLocation(selectedPlace)}</div>
                  )}
                  {!selectedPlace && (
                    <div className={styles.selectedSummaryMeta}>No place — a text-only activity</div>
                  )}
                </span>
                <button
                  type="button"
                  className={styles.changeButton}
                  onClick={() => {
                    setSelectedPlace(null);
                    setTitleOnly(null);
                  }}
                >
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
                placeholder="Search for a place, or add plain text"
                aria-label="Search for a place, or add plain text"
                onSelect={(option) => {
                  const candidate = options[Number(option.id)];
                  if (candidate) setSelectedPlace(candidate);
                }}
                createLabel={(value) => `Add "${value}" without a place`}
                onCreate={(value) => setTitleOnly(value)}
              />
            )
          }
        </FormField>

        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={handleClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            loading={submitting}
            disabled={!selectedPlace && !titleOnly}
          >
            {submitting ? 'Adding…' : 'Add activity'}
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
