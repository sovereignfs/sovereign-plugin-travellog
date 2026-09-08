'use client';

import { useEffect, useMemo, useState } from 'react';
import { Icon, SuggestionInput, type SuggestionOption } from '@sovereignfs/ui';
import { createPlaceAction, searchPlacesAction } from '../actions';
import type { PlaceCandidate } from '../_lib/place-provider';
import styles from './PlaceSearchField.module.css';

const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;

/** Structurally compatible with both `PlaceCandidate` and `RecentPlace` — every call site passes one or the other. */
export function candidateLocation(candidate: {
  category?: string | null;
  city?: string | null;
  country?: string | null;
}): string | null {
  return (
    [candidate.category, candidate.city, candidate.country].filter(Boolean).join(' · ') || null
  );
}

/**
 * Turns a candidate into a real `travellog_places` row id — reusing an
 * existing row when the candidate already is one, creating it otherwise.
 * `null` when creation fails (the caller shows its own error).
 */
export async function resolvePlaceId(candidate: PlaceCandidate): Promise<string | null> {
  if (candidate.existingPlaceId) return candidate.existingPlaceId;
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

/**
 * Debounced place search against `searchPlacesAction` — the one
 * implementation the check-in screen, the stop dialog, and the activity
 * dialog all share (`docs/adhoc/web-planner.md`: "the exact same
 * component/flow, not a separate implementation"; it had been copied three
 * times). `near` biases ranking toward the caller's position when known.
 */
export function usePlaceSearch(query: string, near?: { lat: number; lng: number } | null) {
  const [options, setOptions] = useState<PlaceCandidate[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (query.trim().length < MIN_QUERY_LENGTH) {
      setOptions([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      searchPlacesAction(query.trim(), near ?? undefined)
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
  }, [query, near]);

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

  return { options, searching, suggestionOptions };
}

/**
 * The shared search-or-create field: a `SuggestionInput` over
 * `usePlaceSearch`, with the DS's own create affordance. `onCreate`
 * receives the raw typed text; callers decide whether that becomes a
 * name-only place (check-in, stops) or a title-only activity.
 */
export function PlaceSearchField({
  id,
  value,
  onChange,
  onSelect,
  onCreate,
  createLabel,
  placeholder = 'Search for a place',
  near,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  onSelect: (candidate: PlaceCandidate) => void;
  onCreate: (value: string) => void;
  createLabel: (value: string) => string;
  placeholder?: string;
  near?: { lat: number; lng: number } | null;
}) {
  const { options, searching, suggestionOptions } = usePlaceSearch(value, near);
  return (
    <SuggestionInput
      id={id}
      value={value}
      onChange={onChange}
      options={suggestionOptions}
      loading={searching}
      placeholder={placeholder}
      aria-label={placeholder}
      onSelect={(option) => {
        const candidate = options[Number(option.id)];
        if (candidate) onSelect(candidate);
      }}
      createLabel={createLabel}
      onCreate={onCreate}
    />
  );
}

/** The "you picked X — Change" summary every place-picking flow shows once a candidate is chosen. */
export function SelectedPlaceSummary({
  name,
  meta,
  onChange,
  changeLabel = 'Change',
}: {
  name: string;
  meta?: string | null;
  onChange: () => void;
  changeLabel?: string;
}) {
  return (
    <div className={styles.summary}>
      <span className={styles.summaryIcon}>
        <Icon name="map-pin" size="md" aria-hidden={true} />
      </span>
      <span className={styles.summaryMain}>
        <span className={styles.summaryName}>{name}</span>
        {meta && <span className={styles.summaryMeta}>{meta}</span>}
      </span>
      <button type="button" className={styles.changeButton} onClick={onChange}>
        {changeLabel}
      </button>
    </div>
  );
}
