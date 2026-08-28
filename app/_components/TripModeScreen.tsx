'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  PageContainer,
  PageHeader,
  Spinner,
  useIsOffline,
} from '@sovereignfs/ui';
import { offline } from '@sovereignfs/sdk/offline';
import { getTripModeAction, type TripModeView } from '../actions';
import { OFFLINE_CACHE_KEY_TRIP_MODE, OFFLINE_PLUGIN_ID, type CachedTripMode } from '../_lib/offline-cache';
import { formatCountdown } from '../_lib/trip-mode';
import { useCurrentPosition } from '../_lib/use-current-position';
import styles from './TripModeScreen.module.css';

/**
 * The single maps deep-link convention `T.19`'s own deliverable calls for
 * ("pick one... don't build three"): an Apple Maps *universal link*
 * (`https://maps.apple.com/...`), not the `maps://` custom URI scheme.
 * iOS intercepts this host and opens the native Maps app directly from a
 * plain `<a>` — no scheme registration, no confirmation prompt, and it
 * degrades gracefully to the Apple Maps *website* on a platform with no
 * native app (desktop web), rather than a dead custom-scheme link. `daddr`
 * (destination address) draws directions when coordinates exist; falls
 * back to a plain named search (`q`) when a place has no geocoded
 * coordinates, and to nothing at all for a title-only item with neither.
 */
function mapsHandoffUrl(item: {
  placeName: string | null;
  placeLat: number | null;
  placeLng: number | null;
}): string | null {
  if (item.placeLat !== null && item.placeLng !== null) {
    const label = item.placeName ? `&q=${encodeURIComponent(item.placeName)}` : '';
    return `https://maps.apple.com/?daddr=${String(item.placeLat)},${String(item.placeLng)}${label}`;
  }
  if (item.placeName) {
    return `https://maps.apple.com/?q=${encodeURIComponent(item.placeName)}`;
  }
  return null;
}

/**
 * `T.19` — `docs/adhoc/`'s usual wireframe-first pass doesn't apply here:
 * `SPEC.md`'s own deliverable says this screen's exact layout waits for a
 * mobile concept-review pass that hasn't happened, and to "build the
 * 'Start' entry point and the data wiring now" instead — same deliberately
 * plain, undesigned-layout precedent `T.7`'s `checkin/page.tsx` already
 * set for the same reason.
 *
 * Resolves "today" client-side, not as a server-rendered prop: `nowUtcMs`/
 * `tzIana` are inherently client concepts (the browser's own clock and
 * `Intl`-resolved zone) — the server has no way to know either just from
 * the request, same rule `checkin/page.tsx`'s own check-in submission
 * already follows for `tzIana`.
 *
 * `T.21` — offline-cache read/write-through (`@sovereignfs/sdk/offline`,
 * same "render cache immediately, always attempt a fresh fetch, let a
 * successful fetch win" pattern `plugins/launcher`'s `LauncherOfflineView`
 * establishes, the only other `offline-first` plugin in this repo). Only a
 * *populated* result is ever cached — a confirmed "not active today" is
 * real, common, expected state for most of a trip's lifecycle, not
 * something worth overwriting a still-somewhat-relevant cached itinerary
 * with; the tradeoff is a stale cached trip can outlive its own active
 * window if the screen is never reopened during a later real one, which
 * only means the bare route's shortcut leads to a screen that itself
 * correctly resolves to "not active" once opened — not a correctness bug.
 */
export function TripModeScreen({ tripId, tripName }: { tripId: string; tripName: string }) {
  const router = useRouter();
  const position = useCurrentPosition();
  const isOffline = useIsOffline();
  // `undefined` = still loading; `null` = resolved, but Trip Mode isn't
  // active right now (no stop covers today) — distinct states, not the
  // same "nothing to show yet" bucket.
  const [view, setView] = useState<TripModeView | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    offline
      .get<CachedTripMode>(OFFLINE_PLUGIN_ID, OFFLINE_CACHE_KEY_TRIP_MODE)
      .then((cached) => {
        if (cancelled || !cached || cached.tripId !== tripId) return;
        // Only fills in while still "loading" — a fetch that's already
        // resolved (success or failure) is never downgraded back to a
        // stale cached value arriving late.
        setView((current) => (current === undefined ? cached.view : current));
      })
      .catch(() => {
        // IndexedDB unavailable — the live fetch below still decides the render.
      });

    getTripModeAction(tripId, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone)
      .then((result) => {
        if (cancelled) return;
        setView(result);
        if (result) {
          void offline.set<CachedTripMode>(OFFLINE_PLUGIN_ID, OFFLINE_CACHE_KEY_TRIP_MODE, {
            tripId,
            tripName,
            view: result,
          });
        }
      })
      .catch(() => {
        // Offline (or a real error) — keep whatever the cache read above
        // already rendered; only fall to the inactive/unavailable state if
        // nothing was ever cached for this trip.
        if (!cancelled) setView((current) => (current === undefined ? null : current));
      });

    return () => {
      cancelled = true;
    };
  }, [tripId, tripName]);

  const backToPlanner = (): void => router.push(`/travellog/planner/${tripId}`);

  if (view === undefined) {
    return (
      <PageContainer maxWidth="sm">
        <PageHeader title={tripName} onBack={backToPlanner} />
        <div className={styles.loading}>
          <Spinner />
        </div>
      </PageContainer>
    );
  }

  if (view === null) {
    // Two different reasons collapse into this one state: a confirmed
    // "no stop covers today," or a fetch that failed with nothing ever
    // cached for this trip — genuinely different situations, so `isOffline`
    // picks between `docs/plugin-development.md`'s own suggested copy for
    // the latter ("Not available offline yet — open once online") and the
    // normal explanation for the former.
    return (
      <PageContainer maxWidth="sm">
        <PageHeader title={tripName} onBack={backToPlanner} />
        <EmptyState
          icon="route"
          heading={isOffline ? 'Not available offline yet' : 'Trip Mode isn’t active right now'}
          description={
            isOffline
              ? 'Open Travellog once online to cache this trip’s itinerary for offline viewing.'
              : "Trip Mode only works during a stop's real dates. Open the trip in Planner to check the itinerary."
          }
          action={<Button onClick={backToPlanner}>Open in Planner</Button>}
        />
      </PageContainer>
    );
  }

  const { stop, today } = view;
  const handoffUrl = today.nextItem ? mapsHandoffUrl(today.nextItem) : null;

  return (
    <PageContainer maxWidth="sm">
      <PageHeader title={stop.placeName} description={tripName} onBack={backToPlanner} />

      <div className={styles.positionRow}>
        <Icon name="map-pin" size="sm" aria-hidden={true} />
        <span className={styles.positionText}>
          {position.status === 'idle' && 'Location not shared'}
          {position.status === 'loading' && 'Finding your location…'}
          {position.status === 'denied' && 'Location access denied'}
          {position.status === 'unavailable' && 'Location isn’t available here'}
          {position.status === 'granted' &&
            position.coords &&
            `${position.coords.lat.toFixed(3)}, ${position.coords.lng.toFixed(3)}`}
        </span>
        {position.status === 'idle' && (
          <button type="button" className={styles.positionButton} onClick={() => position.request()}>
            Share location
          </button>
        )}
      </div>

      {today.nextItem && (
        <Card as="div" className={styles.nextCard}>
          <div className={styles.nextLabel}>Next</div>
          <div className={styles.nextName}>{today.nextItem.placeName ?? today.nextItem.title}</div>
          <div className={styles.nextMeta}>
            {today.nextItem.plannedTime}
            {today.countdownMinutes !== null && ` · in ${formatCountdown(today.countdownMinutes)}`}
          </div>
          {handoffUrl && (
            <a href={handoffUrl} target="_blank" rel="noreferrer" className={styles.handoffLink}>
              <Icon name="route" size="sm" aria-hidden={true} />
              Directions
            </a>
          )}
        </Card>
      )}

      <div className={styles.section}>
        <div className={styles.sectionHeading}>Today</div>
        {today.items.length === 0 ? (
          <p className={styles.emptyToday}>Nothing planned for today.</p>
        ) : (
          <ul className={styles.list}>
            {today.items.map((item) => (
              <li key={item.id} className={styles.row}>
                {item.plannedTime && <span className={styles.rowTime}>{item.plannedTime}</span>}
                <span className={styles.rowMain}>{item.placeName ?? item.title}</span>
                {item.isFixed && (
                  <Badge variant="mono" uppercase={false} size="sm">
                    Fixed
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Button
        variant="secondary"
        className={styles.checkinButton}
        onClick={() => router.push('/travellog/checkin')}
      >
        <Icon name="map-pin" size="sm" aria-hidden={true} />
        Quick check-in
      </Button>
    </PageContainer>
  );
}
