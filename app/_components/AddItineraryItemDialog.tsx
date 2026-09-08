'use client';

import { useState, type FormEvent } from 'react';
import { Button, Dialog, FormField } from '@sovereignfs/ui';
import { createItineraryItemAction } from '../actions';
import type { PlaceCandidate } from '../_lib/place-provider';
import type { WorkspaceItineraryItem } from '../_lib/queries';
import {
  candidateLocation,
  PlaceSearchField,
  resolvePlaceId,
  SelectedPlaceSummary,
} from './PlaceSearchField';
import styles from './AddItineraryItemDialog.module.css';

/**
 * No dedicated wireframe screen — `docs/adhoc/web-planner.md`'s engineering
 * notes call for reusing screen 4's place-search flow (`StopDialog`),
 * scoped down: no dates (the day is already fixed by which "+ Add activity"
 * row opened this), and a second path the stop dialog doesn't need — an
 * item can be title-only, with no resolved place at all
 * (`itinerary-items.ts`'s `assertValid`: needs *either* a place or a title).
 * The shared `PlaceSearchField`'s `onSelect`/`onCreate` pair maps onto that
 * split directly: picking a real suggestion resolves a place exactly like
 * the stop dialog; "add without a place" instead skips place creation
 * entirely and stores the typed text as `title`. Planned time, the Fixed
 * toggle, and notes are edited afterward in the detail column (screen 5).
 * A real `<form>`, so Enter submits.
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
  const [selectedPlace, setSelectedPlace] = useState<PlaceCandidate | null>(null);
  const [titleOnly, setTitleOnly] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function handleClose(): void {
    if (submitting) return;
    setQuery('');
    setSelectedPlace(null);
    setTitleOnly(null);
    setError(null);
    onClose();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if ((!selectedPlace && !titleOnly) || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      let placeId: string | null = null;
      if (selectedPlace) {
        placeId = await resolvePlaceId(selectedPlace);
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
      <form onSubmit={(e) => void handleSubmit(e)} className={styles.form}>
        {error && (
          <p className={styles.feedbackError} role="status" aria-live="polite">
            {error}
          </p>
        )}

        <FormField label="Activity" required>
          {(field) =>
            selectedPlace || titleOnly !== null ? (
              <SelectedPlaceSummary
                name={selectedPlace?.name ?? titleOnly ?? ''}
                meta={
                  selectedPlace
                    ? candidateLocation(selectedPlace)
                    : 'No place — a text-only activity'
                }
                onChange={() => {
                  setSelectedPlace(null);
                  setTitleOnly(null);
                }}
              />
            ) : (
              <PlaceSearchField
                id={field.id}
                value={query}
                onChange={setQuery}
                placeholder="Search for a place, or add plain text"
                onSelect={setSelectedPlace}
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
          <Button type="submit" loading={submitting} disabled={!selectedPlace && !titleOnly}>
            {submitting ? 'Adding…' : 'Add activity'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
