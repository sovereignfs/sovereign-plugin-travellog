'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, Icon, PageContainer } from '@sovereignfs/ui';
import { offline } from '@sovereignfs/sdk/offline';
import { OFFLINE_CACHE_KEY_TRIP_MODE, OFFLINE_PLUGIN_ID, type CachedTripMode } from '../_lib/offline-cache';
import styles from './OfflineHomeView.module.css';

/**
 * `T.21` — the bare route's real content, entirely client-side
 * (`app/page.tsx`'s own doc comment explains why). Reads whatever
 * `TripModeScreen` last cached for `OFFLINE_CACHE_KEY_TRIP_MODE` — no live
 * fetch of its own, since this shell doesn't know a `tripId` to fetch with
 * in the first place, and it needs to render something with zero network
 * regardless (`sdk.offline` is exactly "whatever was true last time this
 * plugin's own client code ran while online").
 *
 * "Check in" is always the primary action (`CONCEPT.md`: "checking in is
 * always available and stands on its own") — present whether or not a
 * cached trip exists, and whether online or offline (the check-in screen
 * itself, `T.21`, is what actually branches on connectivity).
 */
export function OfflineHomeView() {
  const [cached, setCached] = useState<CachedTripMode | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    offline
      .get<CachedTripMode>(OFFLINE_PLUGIN_ID, OFFLINE_CACHE_KEY_TRIP_MODE)
      .then((value) => {
        if (!cancelled) setCached(value);
      })
      .catch(() => {
        if (!cancelled) setCached(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PageContainer maxWidth="sm">
      <h1 className={styles.title}>Travellog</h1>

      <Link href="/travellog/checkin" className={styles.checkinLink}>
        <Icon name="map-pin" size="sm" aria-hidden={true} />
        Check in
      </Link>

      {cached && cached.view.stop && (
        <Card as="div" className={styles.tripCard}>
          <div className={styles.tripLabel}>Trip in progress</div>
          <div className={styles.tripName}>{cached.view.stop.placeName}</div>
          <div className={styles.tripMeta}>{cached.tripName}</div>
          <Link href={`/travellog/planner/${cached.tripId}/mode`} className={styles.tripLink}>
            Continue trip →
          </Link>
        </Card>
      )}

      {cached === null && (
        <p className={styles.hint}>
          Open Travellog once online to cache a trip here for offline viewing.
        </p>
      )}

      <nav className={styles.nav} aria-label="Travellog">
        <Link href="/travellog/checkins">Check-ins</Link>
        <Link href="/travellog/trips">Trips</Link>
      </nav>
    </PageContainer>
  );
}
