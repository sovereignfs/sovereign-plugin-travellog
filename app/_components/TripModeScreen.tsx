'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
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
import { distanceMeters } from '../_lib/geo';
import {
  OFFLINE_CACHE_KEY_TRIP_MODE,
  OFFLINE_PLUGIN_ID,
  type CachedTripMode,
} from '../_lib/offline-cache';
import { formatCountdown, resolveNextItem } from '../_lib/trip-mode';
import { localTimeOfDay } from '../_lib/timezone';
import { useCurrentPosition } from '../_lib/use-current-position';
import styles from './TripModeScreen.module.css';

/** How often the countdown / "next" pointer and the itinerary are re-derived and refetched while the screen is open. */
const TICK_MS = 30_000;
const REFETCH_MS = 5 * 60_000;

type Platform = 'ios' | 'android' | 'other';

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

/**
 * The maps hand-off, by platform: an Apple Maps universal link on iOS
 * (opens the native app from a plain `<a>`, no scheme registration), a
 * `geo:` URI on Android (any installed maps app claims it — the Apple link
 * was a web page there), and Google Maps' web directions elsewhere (a
 * desktop browser has no native app to hand to). `daddr`/`destination`
 * draw directions when coordinates exist; a place with no geocoded
 * coordinates falls back to a named search; a title-only item has nothing
 * to hand off.
 */
export function mapsHandoffUrl(
  item: { placeName: string | null; placeLat: number | null; placeLng: number | null },
  platform: Platform,
): string | null {
  const name = item.placeName ? encodeURIComponent(item.placeName) : '';
  if (item.placeLat !== null && item.placeLng !== null) {
    const coords = `${String(item.placeLat)},${String(item.placeLng)}`;
    if (platform === 'ios')
      return `https://maps.apple.com/?daddr=${coords}${name ? `&q=${name}` : ''}`;
    if (platform === 'android') return `geo:${coords}?q=${coords}${name ? `(${name})` : ''}`;
    return `https://www.google.com/maps/dir/?api=1&destination=${coords}`;
  }
  if (item.placeName) {
    if (platform === 'ios') return `https://maps.apple.com/?q=${name}`;
    if (platform === 'android') return `geo:0,0?q=${name}`;
    return `https://www.google.com/maps/search/?api=1&query=${name}`;
  }
  return null;
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${String(Math.round(meters / 10) * 10)} m away`;
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km away`;
}

/**
 * `T.19` — Trip Mode. Resolves "today" client-side, not as a server-
 * rendered prop: `nowUtcMs`/`tzIana` are inherently client concepts (the
 * browser's own clock and `Intl`-resolved zone).
 *
 * Live, not a snapshot: the "next" pointer and countdown are re-derived
 * from the fetched item list every `TICK_MS` (`resolveNextItem`, the same
 * pure function the server used), the itinerary is refetched every
 * `REFETCH_MS` and whenever the tab becomes visible again, and the device
 * position is *watched* rather than read once, with the straight-line
 * distance to the next stop shown beside it (`_lib/geo.ts`'s haversine —
 * phase 1's "current position + next stop + countdown", not the deferred
 * Phase 2a reordering). Past items are dimmed; an item's notes show under
 * its name.
 *
 * `T.21` — offline-cache read/write-through (`@sovereignfs/sdk/offline`,
 * "render cache immediately, always attempt a fresh fetch, let a
 * successful fetch win"). Only a *populated* result is ever cached.
 */
export function TripModeScreen({ tripId, tripName }: { tripId: string; tripName: string }) {
  const router = useRouter();
  const position = useCurrentPosition({ watch: true });
  const isOffline = useIsOffline();
  // `undefined` = still loading; `null` = resolved, but Trip Mode isn't
  // active right now (no stop covers today) — distinct states.
  const [view, setView] = useState<TripModeView | null | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const [platform, setPlatform] = useState<Platform>('other');

  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  useEffect(() => {
    let cancelled = false;

    function fetchView(): void {
      getTripModeAction(tripId, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone)
        .then((result) => {
          if (cancelled) return;
          setView(result);
          setNow(Date.now());
          if (result) {
            void offline.set<CachedTripMode>(OFFLINE_PLUGIN_ID, OFFLINE_CACHE_KEY_TRIP_MODE, {
              tripId,
              tripName,
              view: result,
            });
          }
        })
        .catch(() => {
          // Offline (or a real error) — keep whatever the cache read below
          // already rendered; only fall to the inactive/unavailable state if
          // nothing was ever cached for this trip.
          if (!cancelled) setView((current) => (current === undefined ? null : current));
        });
    }

    offline
      .get<CachedTripMode>(OFFLINE_PLUGIN_ID, OFFLINE_CACHE_KEY_TRIP_MODE)
      .then((cached) => {
        if (cancelled || !cached || cached.tripId !== tripId) return;
        setView((current) => (current === undefined ? cached.view : current));
      })
      .catch(() => {
        // IndexedDB unavailable — the live fetch decides the render.
      });

    fetchView();
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    const refetch = setInterval(fetchView, REFETCH_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        setNow(Date.now());
        fetchView();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearInterval(tick);
      clearInterval(refetch);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [tripId, tripName]);

  // Re-derive "next" and the countdown from the item list as the clock
  // ticks — the server's values are only right at the instant it answered.
  const live = useMemo(() => {
    if (!view) return null;
    const zone = view.tzIana;
    const { nextItem, countdownMinutes } = resolveNextItem(
      view.today.items,
      view.today.date,
      now,
      zone,
    );
    const nowTime = localTimeOfDay(now, zone);
    return { nextItem, countdownMinutes, nowTime };
  }, [view, now]);

  const distanceToNext =
    live?.nextItem &&
    position.coords &&
    live.nextItem.placeLat !== null &&
    live.nextItem.placeLng !== null
      ? distanceMeters(position.coords, {
          lat: live.nextItem.placeLat,
          lng: live.nextItem.placeLng,
        })
      : null;

  if (view === undefined) {
    return (
      <PageContainer maxWidth="sm">
        <PageHeader title={tripName} onBack={() => router.push(`/travellog/planner/${tripId}`)} />
        <div className={styles.loading}>
          <Spinner />
        </div>
      </PageContainer>
    );
  }

  if (view === null) {
    return (
      <PageContainer maxWidth="sm">
        <PageHeader title={tripName} onBack={() => router.push(`/travellog/planner/${tripId}`)} />
        <EmptyState
          icon="route"
          heading={isOffline ? 'Not available offline yet' : 'Trip Mode isn’t active right now'}
          description={
            isOffline
              ? 'Open Travellog once online to cache this trip’s itinerary for offline viewing.'
              : "Trip Mode only works during a stop's real dates. Open the trip in Planner to check the itinerary."
          }
          action={
            <Link href={`/travellog/planner/${tripId}`} className={styles.plannerLink}>
              Open in Planner →
            </Link>
          }
        />
      </PageContainer>
    );
  }

  const { stop, today } = view;
  const nextItem = live?.nextItem ?? null;
  const handoffUrl = nextItem ? mapsHandoffUrl(nextItem, platform) : null;

  return (
    <PageContainer maxWidth="sm">
      <PageHeader
        title={stop.placeName}
        description={tripName}
        onBack={() => router.push(`/travellog/planner/${tripId}`)}
      />

      <div className={styles.positionRow}>
        <Icon name="map-pin" size="sm" aria-hidden={true} />
        <span className={styles.positionText}>
          {position.status === 'idle' && 'Location not shared'}
          {position.status === 'loading' && 'Finding your location…'}
          {position.status === 'denied' && 'Location access denied'}
          {position.status === 'unavailable' && !position.coords && 'Location isn’t available here'}
          {position.coords &&
            (distanceToNext !== null
              ? `${formatDistance(distanceToNext)} from your next stop`
              : 'Following your location')}
        </span>
        {position.status === 'idle' && (
          <button
            type="button"
            className={styles.positionButton}
            onClick={() => position.request()}
          >
            Share location
          </button>
        )}
      </div>

      {nextItem && (
        <Card as="div" className={styles.nextCard}>
          <div className={styles.nextLabel}>Next</div>
          <div className={styles.nextName}>{nextItem.placeName ?? nextItem.title}</div>
          <div className={styles.nextMeta}>
            {nextItem.plannedTime}
            {live?.countdownMinutes !== null &&
              live?.countdownMinutes !== undefined &&
              ` · in ${formatCountdown(live.countdownMinutes)}`}
          </div>
          {distanceToNext !== null && (
            <div className={styles.nextDistance}>{formatDistance(distanceToNext)}</div>
          )}
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
            {today.items.map((item) => {
              const isPast =
                item.plannedTime !== null &&
                live !== null &&
                item.plannedTime <= live.nowTime &&
                item.id !== nextItem?.id;
              return (
                <li
                  key={item.id}
                  className={[styles.row, isPast ? styles.rowPast : ''].filter(Boolean).join(' ')}
                >
                  {item.plannedTime && <span className={styles.rowTime}>{item.plannedTime}</span>}
                  <span className={styles.rowMain}>
                    <span>{item.placeName ?? item.title}</span>
                    {item.notes && <span className={styles.rowNotes}>{item.notes}</span>}
                  </span>
                  {item.isFixed && (
                    <Badge variant="mono" uppercase={false} size="sm">
                      Fixed
                    </Badge>
                  )}
                </li>
              );
            })}
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
