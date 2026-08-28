/**
 * `T.21` — shared constants/types for this plugin's `sdk.offline`/
 * `sdk.offline-queue` usage (`@sovereignfs/sdk/offline`,
 * `@sovereignfs/sdk/offline-queue`; `docs/plugin-development.md`'s
 * "offline"/"Offline writes" sections). One file so the plugin id and
 * cache/queue key strings exist exactly once, rather than re-typed at
 * every call site — those SDK modules take the plugin id and key as plain
 * strings, there's no manifest-derived constant to import instead.
 */
import type { TripModeView } from '../actions';

/** This plugin's own manifest `id` — every `sdk.offline`/`sdk.offline-queue` call is scoped by this. */
export const OFFLINE_PLUGIN_ID = 'fs.sovereign.travellog';

/**
 * Written by `TripModeScreen` on every successful `getTripModeAction` call;
 * read by it as a fallback and by the bare route's offline home shell
 * (`OfflineHomeView`) — the one thing the bare route can show about an
 * active trip with no server round-trip of its own.
 */
export const OFFLINE_CACHE_KEY_TRIP_MODE = 'activeTripMode';

export interface CachedTripMode {
  tripId: string;
  tripName: string;
  view: TripModeView;
}

/** Written by the check-in screen on every mount while online; read by it as the offline place picker. */
export const OFFLINE_CACHE_KEY_RECENT_PLACES = 'recentPlaces';

/** `offlineQueue.enqueue()`'s `op` for a queued offline check-in — the only mutation kind this plugin currently queues. */
export const OFFLINE_QUEUE_OP_CHECKIN = 'checkin';

export interface QueuedCheckinPayload {
  placeId: string;
  placeName: string;
  happenedAt: number;
  tzIana: string;
  tzOffsetMinutes: number;
  note?: string;
}
