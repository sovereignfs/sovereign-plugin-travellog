'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Card,
  FileDropzone,
  Icon,
  Input,
  PageContainer,
  PageHeader,
  Spinner,
  SuggestionInput,
  useCommitOnEnterOrBlur,
  useToast,
  type SuggestionOption,
} from '@sovereignfs/ui';
import { createPlaceAction, createVisitAction, reverseGeocodePlaceAction, searchPlacesAction } from '../actions';
import type { PlaceCandidate } from '../_lib/place-provider';
import { useCurrentPosition } from '../_lib/use-current-position';
import type { CreateVisitPhotoInput } from '../_lib/visits';
import styles from './page.module.css';

const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;

function candidateLocation(candidate: PlaceCandidate): string | null {
  return [candidate.category, candidate.city, candidate.country].filter(Boolean).join(' · ') || null;
}

/**
 * `T.7`'s check-in creation flow — the three paths from `CONCEPT.md`
 * (search-first, GPS "check in here", manual free-text) converging on the
 * same confirm step. Deliberately plain, un-designed layout: `SPEC.md`'s
 * `T.7` explicitly defers screen placement/layout to a mobile
 * concept-review pass that hasn't happened yet — this builds the real
 * server-action-consuming logic now, not a finished screen. A top-level
 * route (outside `(home)/`), not nested under the sidebar layout —
 * `ThreeColumnLayout` has no responsive behavior and is confirmed broken
 * below 768px (`T.5`'s status entry), which would defeat a mobile-only
 * screen before it even loaded.
 */
export default function CheckInPage() {
  const router = useRouter();
  const toast = useToast();
  const position = useCurrentPosition();

  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<PlaceCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [gpsSuggestion, setGpsSuggestion] = useState<PlaceCandidate | null | undefined>(undefined);

  const [selected, setSelected] = useState<PlaceCandidate | null>(null);
  const [selectedSource, setSelectedSource] = useState<'manual' | 'gps'>('manual');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // One object URL per selected photo, revoked on change/unmount — never
  // created inline during render, which would mint a fresh (leaked) URL on
  // every re-render instead of once per actual photo selection.
  useEffect(() => {
    if (!photo) {
      setPhotoPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(photo);
    setPhotoPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [photo]);

  // Debounced search, ranked by GPS proximity when available — the same
  // `let cancelled` + cleanup-clears-timer pattern as
  // `sovereign-plugin-docs`'s `FolderShareDialog`.
  useEffect(() => {
    if (query.trim().length < MIN_QUERY_LENGTH) {
      setOptions([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      searchPlacesAction(query.trim(), position.coords ?? undefined)
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
  }, [query, position.coords]);

  // Once a position is granted, resolve it to a single best-guess place —
  // "check in here" is a suggestion to confirm, not an auto check-in.
  useEffect(() => {
    if (position.status !== 'granted' || !position.coords) return;
    let cancelled = false;
    const { lat, lng } = position.coords;
    reverseGeocodePlaceAction(lat, lng)
      .then((candidate) => {
        if (!cancelled) setGpsSuggestion(candidate);
      })
      .catch(() => {
        if (!cancelled) setGpsSuggestion(null);
      });
    return () => {
      cancelled = true;
    };
  }, [position.status, position.coords]);

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

  function choosePlace(candidate: PlaceCandidate, source: 'manual' | 'gps'): void {
    setSelected(candidate);
    setSelectedSource(source);
  }

  function changePlace(): void {
    setSelected(null);
    setNote('');
    setPhoto(null);
  }

  async function resolvePlaceId(candidate: PlaceCandidate): Promise<string | null> {
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

  async function uploadPhoto(file: File): Promise<string | null> {
    const formData = new FormData();
    formData.set('file', file);
    const response = await fetch('/travellog/checkin/upload-photo', {
      method: 'POST',
      body: formData,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { storageKey: string };
    return data.storageKey;
  }

  async function handleCheckIn(): Promise<void> {
    if (!selected || submitting) return;
    setSubmitting(true);
    try {
      const placeId = await resolvePlaceId(selected);
      if (!placeId) {
        toast.show({
          title: 'Couldn’t check in',
          message: 'That place couldn’t be saved. Try again.',
          category: 'error',
        });
        return;
      }

      const photos: CreateVisitPhotoInput[] = [];
      if (photo) {
        const storageKey = await uploadPhoto(photo);
        if (!storageKey) {
          toast.show({
            title: 'Couldn’t check in',
            message: 'That photo couldn’t be uploaded. Try a smaller file or check in without one.',
            category: 'error',
          });
          return;
        }
        photos.push({ storageKey, source: 'upload' as const });
      }

      const result = await createVisitAction({
        placeId,
        happenedAt: Date.now(),
        tzIana: Intl.DateTimeFormat().resolvedOptions().timeZone,
        tzOffsetMinutes: -new Date().getTimezoneOffset(),
        note: note.trim() || undefined,
        source: selectedSource,
        photos,
      });

      if (result.ok) {
        toast.show({ title: 'Checked in', message: selected.name, category: 'success' });
        router.push('/travellog/checkins');
      } else {
        toast.show({ title: 'Couldn’t check in', message: result.error, category: 'error' });
      }
    } finally {
      setSubmitting(false);
    }
  }

  // The note field doubles as this flow's fast path: Enter or losing focus
  // (iOS's Done key only fires blur, never Enter — CLAUDE.md's hard rule)
  // completes the check-in exactly like tapping the always-visible "Check
  // in" button below. Deliberately the LAST field before that button (after
  // the photo picker) so a normal top-to-bottom pass reaches it once the
  // user has already attached a photo if they wanted one — reaching it
  // early by tabbing out of order still submits, same as the button would.
  const noteHandlers = useCommitOnEnterOrBlur(() => {
    void handleCheckIn();
  });

  return (
    <PageContainer maxWidth="sm">
      <PageHeader title="Check in" />

      {!selected && (
        <div className={styles.section}>
          <Card
            as="div"
            interactive
            className={styles.gpsCard}
            role="button"
            tabIndex={0}
            onClick={() => position.request()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') position.request();
            }}
          >
            <span
              className={[styles.gpsIcon, position.status === 'loading' ? styles.gpsIconActive : '']
                .filter(Boolean)
                .join(' ')}
            >
              {position.status === 'loading' ? (
                <Spinner size="sm" />
              ) : (
                <Icon name="map-pin" size="sm" aria-hidden={true} />
              )}
            </span>
            <span className={styles.gpsMain}>
              <div className={styles.gpsTitle}>Check in here</div>
              <div className={styles.gpsHint}>
                {position.status === 'idle' && 'Use your current location'}
                {position.status === 'loading' && 'Finding your location…'}
                {position.status === 'denied' &&
                  'Location access denied — search for your place below instead'}
                {position.status === 'unavailable' &&
                  'Location isn’t available here — search for your place below instead'}
                {position.status === 'granted' &&
                  gpsSuggestion === undefined &&
                  'Looking up nearby places…'}
                {position.status === 'granted' &&
                  gpsSuggestion === null &&
                  'Nothing found nearby — search for your place below instead'}
                {position.status === 'granted' &&
                  gpsSuggestion &&
                  `Tap to confirm: ${gpsSuggestion.name}`}
              </div>
            </span>
          </Card>

          {position.status === 'granted' && gpsSuggestion && (
            <Card
              as="div"
              interactive
              className={styles.selectedSummary}
              role="button"
              tabIndex={0}
              onClick={() => choosePlace(gpsSuggestion, 'gps')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') choosePlace(gpsSuggestion, 'gps');
              }}
            >
              <span className={styles.suggestionIcon}>
                <Icon name="map-pin" size="md" aria-hidden={true} />
              </span>
              <span className={styles.selectedSummaryMain}>
                <div className={styles.selectedSummaryName}>{gpsSuggestion.name}</div>
                {candidateLocation(gpsSuggestion) && (
                  <div className={styles.selectedSummaryMeta}>{candidateLocation(gpsSuggestion)}</div>
                )}
              </span>
            </Card>
          )}

          <div className={styles.divider}>or search</div>

          <SuggestionInput
            value={query}
            onChange={setQuery}
            options={suggestionOptions}
            loading={searching}
            placeholder="Search for a place"
            aria-label="Search for a place"
            onSelect={(option) => {
              const candidate = options[Number(option.id)];
              if (candidate) choosePlace(candidate, 'manual');
            }}
            createLabel={(value) => `Add "${value}" as a new place`}
            onCreate={(value) => {
              choosePlace({ name: value, lat: null, lng: null }, 'manual');
            }}
          />
        </div>
      )}

      {selected && (
        <div className={styles.section}>
          <div className={styles.selectedSummary}>
            <span className={styles.suggestionIcon}>
              <Icon name="map-pin" size="md" aria-hidden={true} />
            </span>
            <span className={styles.selectedSummaryMain}>
              <div className={styles.selectedSummaryName}>{selected.name}</div>
              {candidateLocation(selected) && (
                <div className={styles.selectedSummaryMeta}>{candidateLocation(selected)}</div>
              )}
            </span>
            <button type="button" className={styles.changeButton} onClick={changePlace}>
              Change
            </button>
          </div>

          {photo && photoPreviewUrl ? (
            <div className={styles.photoPreview}>
              <img src={photoPreviewUrl} alt="" className={styles.photoThumb} />
              <Button variant="secondary" size="sm" onClick={() => setPhoto(null)}>
                Remove photo
              </Button>
            </div>
          ) : (
            <FileDropzone
              accept="image/*"
              label="Add a photo"
              hint="Optional"
              ariaLabel="Add a photo to this check-in"
              onFileSelect={setPhoto}
            />
          )}

          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note (optional)"
            aria-label="Note"
            onKeyDown={noteHandlers.onKeyDown}
            onBlur={noteHandlers.onBlur}
          />

          <Button onClick={() => void handleCheckIn()} loading={submitting}>
            Check in
          </Button>
        </div>
      )}
    </PageContainer>
  );
}
