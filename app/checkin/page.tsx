'use client';

import { useEffect, useState } from 'react';
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
  useIsOffline,
  useToast,
} from '@sovereignfs/ui';
import { offline } from '@sovereignfs/sdk/offline';
import { offlineQueue } from '@sovereignfs/sdk/offline-queue';
import { createVisitAction, listRecentPlacesAction, reverseGeocodePlaceAction } from '../actions';
import {
  OFFLINE_CACHE_KEY_RECENT_PLACES,
  OFFLINE_PLUGIN_ID,
  OFFLINE_QUEUE_OP_CHECKIN,
  type QueuedCheckinPayload,
} from '../_lib/offline-cache';
import type { PlaceCandidate } from '../_lib/place-provider';
import type { RecentPlace } from '../_lib/queries';
import { localDateKey, localTimeOfDay, zonedTimeToUtcMs } from '../_lib/timezone';
import { useCurrentPosition } from '../_lib/use-current-position';
import type { CreateVisitPhotoInput } from '../_lib/visits';
import {
  candidateLocation,
  PlaceSearchField,
  resolvePlaceId,
  SelectedPlaceSummary,
} from '../_components/PlaceSearchField';
import styles from './page.module.css';

/** `"YYYY-MM-DDTHH:mm"` for a `datetime-local` input, in the given zone. */
function toLocalInputValue(utcMs: number, tzIana: string): string {
  return `${localDateKey(utcMs, tzIana)}T${localTimeOfDay(utcMs, tzIana)}`;
}

/**
 * `T.7`'s check-in creation flow — the three paths from `CONCEPT.md`
 * (search-first, GPS "check in here", manual free-text) converging on the
 * same confirm step, plus a backdated "when" field (the moment defaults to
 * now and stays there unless changed — a check-in for last night's dinner
 * shouldn't have to wait for the Check-ins screen to be re-dated). A
 * top-level route (outside `(home)/`), not nested under the sidebar layout.
 *
 * The note field does **not** submit on blur. It used to (via
 * `useCommitOnEnterOrBlur`), which meant tapping "Add a photo", "Remove
 * photo", "Change", or the when field after typing a note checked the
 * user in on the spot — the rule's own stated exception applies: a form
 * with an always-visible submit button. Enter still submits, as a form.
 */
export default function CheckInPage() {
  const router = useRouter();
  const toast = useToast();
  const position = useCurrentPosition();
  const isOffline = useIsOffline();

  const [query, setQuery] = useState('');
  const [gpsSuggestion, setGpsSuggestion] = useState<PlaceCandidate | null | undefined>(undefined);
  const [recentPlaces, setRecentPlaces] = useState<RecentPlace[]>([]);

  const [selected, setSelected] = useState<PlaceCandidate | null>(null);
  const [selectedSource, setSelectedSource] = useState<'manual' | 'gps'>('manual');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  /** `null` = "now" (resolved at submit time); a string = the user backdated it. */
  const [when, setWhen] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // `T.21` — feeds the offline picker below: while online, refresh the
  // cache every time this screen mounts; offline, fall back to whatever was
  // cached last time. A genuinely offline device can't search or create a
  // *new* place at all (`_lib/queries.ts`'s `listRecentPlaces` doc
  // comment), so this is the only place-selection path that still works
  // with no network.
  useEffect(() => {
    let cancelled = false;
    listRecentPlacesAction()
      .then((places) => {
        if (cancelled) return;
        setRecentPlaces(places);
        void offline.set(OFFLINE_PLUGIN_ID, OFFLINE_CACHE_KEY_RECENT_PLACES, places);
      })
      .catch(() => {
        offline
          .get<RecentPlace[]>(OFFLINE_PLUGIN_ID, OFFLINE_CACHE_KEY_RECENT_PLACES)
          .then((cached) => {
            if (!cancelled && cached) setRecentPlaces(cached);
          })
          .catch(() => {
            // IndexedDB unavailable too — the picker just renders empty.
          });
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  function choosePlace(candidate: PlaceCandidate, source: 'manual' | 'gps'): void {
    setSelected(candidate);
    setSelectedSource(source);
  }

  function changePlace(): void {
    setSelected(null);
    setNote('');
    setPhoto(null);
    setWhen(null);
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

  /** The instant being recorded: now, or the backdated wall-clock value read in the device's own zone. */
  function resolveHappenedAt(tzIana: string): number {
    if (!when) return Date.now();
    const [dateKey, time] = when.split('T');
    if (!dateKey || !time) return Date.now();
    return zonedTimeToUtcMs(dateKey, time.slice(0, 5), tzIana);
  }

  /**
   * `T.21` — no place/photo resolution here at all, unlike the online path:
   * a genuinely offline device can only offer a place it already has a real
   * `placeId` for (the Recent places picker below always sets
   * `existingPlaceId`), and photo upload needs a network round-trip this
   * flow deliberately doesn't attempt. `OfflineSyncBoundary`
   * (`app/layout.tsx`) drains the queue against `syncOfflineCheckinAction`
   * once back online, from wherever the user happens to be by then.
   */
  async function queueOfflineCheckIn(): Promise<void> {
    if (!selected) return;
    if (!selected.existingPlaceId) {
      toast.show({
        title: 'Couldn’t check in',
        message: 'That place isn’t available offline — pick one from Recent places.',
        category: 'error',
      });
      return;
    }
    const tzIana = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const payload: QueuedCheckinPayload = {
      placeId: selected.existingPlaceId,
      placeName: selected.name,
      happenedAt: resolveHappenedAt(tzIana),
      tzIana,
      tzOffsetMinutes: -new Date().getTimezoneOffset(),
      note: note.trim() || undefined,
    };
    try {
      await offlineQueue.enqueue(OFFLINE_PLUGIN_ID, OFFLINE_QUEUE_OP_CHECKIN, payload);
      toast.show({
        title: 'Queued',
        message: `${selected.name} — will sync once you're back online.`,
        category: 'success',
      });
      changePlace();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Something went wrong saving this offline.';
      toast.show({ title: 'Couldn’t queue check-in', message, category: 'error' });
    }
  }

  async function handleCheckIn(): Promise<void> {
    if (!selected || submitting) return;
    setSubmitting(true);
    try {
      if (isOffline) {
        await queueOfflineCheckIn();
        return;
      }

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

      const tzIana = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const result = await createVisitAction({
        placeId,
        happenedAt: resolveHappenedAt(tzIana),
        tzIana,
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

  return (
    <PageContainer maxWidth="sm">
      <PageHeader title="Check in" />

      {!selected && isOffline && (
        <div className={styles.section}>
          <p className={styles.offlineHint}>
            You’re offline — search and new places aren’t available. Pick from somewhere you’ve
            checked in before:
          </p>
          {recentPlaces.length === 0 ? (
            <p className={styles.offlineHint}>
              Nothing cached yet — open Check in once online first.
            </p>
          ) : (
            recentPlaces.map((place) => (
              <Card
                key={place.id}
                as="div"
                interactive
                className={styles.selectedSummary}
                role="button"
                tabIndex={0}
                onClick={() =>
                  choosePlace(
                    { name: place.name, lat: place.lat, lng: place.lng, existingPlaceId: place.id },
                    'manual',
                  )
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    choosePlace(
                      {
                        name: place.name,
                        lat: place.lat,
                        lng: place.lng,
                        existingPlaceId: place.id,
                      },
                      'manual',
                    );
                  }
                }}
              >
                <span className={styles.suggestionIcon}>
                  <Icon name="map-pin" size="md" aria-hidden={true} />
                </span>
                <span className={styles.selectedSummaryMain}>
                  <span className={styles.selectedSummaryName}>{place.name}</span>
                  {candidateLocation(place) && (
                    <span className={styles.selectedSummaryMeta}>{candidateLocation(place)}</span>
                  )}
                </span>
              </Card>
            ))
          )}
        </div>
      )}

      {!selected && !isOffline && (
        <div className={styles.section}>
          <Card
            as="div"
            interactive
            className={styles.gpsCard}
            role="button"
            tabIndex={0}
            onClick={() => position.request()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                position.request();
              }
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
              <span className={styles.gpsTitle}>Check in here</span>
              <span className={styles.gpsHint}>
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
              </span>
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
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  choosePlace(gpsSuggestion, 'gps');
                }
              }}
            >
              <span className={styles.suggestionIcon}>
                <Icon name="map-pin" size="md" aria-hidden={true} />
              </span>
              <span className={styles.selectedSummaryMain}>
                <span className={styles.selectedSummaryName}>{gpsSuggestion.name}</span>
                {candidateLocation(gpsSuggestion) && (
                  <span className={styles.selectedSummaryMeta}>
                    {candidateLocation(gpsSuggestion)}
                  </span>
                )}
              </span>
            </Card>
          )}

          <div className={styles.divider}>or search</div>

          <PlaceSearchField
            value={query}
            onChange={setQuery}
            near={position.coords}
            onSelect={(candidate) => choosePlace(candidate, 'manual')}
            createLabel={(value) => `Add "${value}" as a new place`}
            onCreate={(value) => choosePlace({ name: value, lat: null, lng: null }, 'manual')}
          />
        </div>
      )}

      {selected && (
        <form
          className={styles.section}
          onSubmit={(e) => {
            e.preventDefault();
            void handleCheckIn();
          }}
        >
          <SelectedPlaceSummary
            name={selected.name}
            meta={candidateLocation(selected)}
            onChange={changePlace}
          />

          {isOffline ? (
            <p className={styles.offlineHint}>
              Photos aren’t available offline — add one later from Check-ins.
            </p>
          ) : photo && photoPreviewUrl ? (
            <div className={styles.photoPreview}>
              <img
                src={photoPreviewUrl}
                alt={`Preview for ${selected.name}`}
                className={styles.photoThumb}
              />
              <Button type="button" variant="secondary" size="sm" onClick={() => setPhoto(null)}>
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

          <div className={styles.whenRow}>
            <Input
              type="datetime-local"
              aria-label="When"
              value={
                when ??
                toLocalInputValue(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone)
              }
              onChange={(e) => setWhen(e.target.value)}
              max={toLocalInputValue(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone)}
            />
            {when ? (
              <button type="button" className={styles.whenReset} onClick={() => setWhen(null)}>
                Use the current time instead
              </button>
            ) : (
              <span className={styles.whenHint}>
                Right now — change it to log something earlier.
              </span>
            )}
          </div>

          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note (optional)"
            aria-label="Note"
          />

          <Button type="submit" loading={submitting}>
            Check in
          </Button>
        </form>
      )}
    </PageContainer>
  );
}
