'use server';

/**
 * Server actions — the mutation layer every surface (web + mobile) calls.
 *
 * Every action:
 * 1. `requireUser()` — session, always first.
 * 2. Per-resource authorization (`requireVisitOwner`) where applicable — a
 *    server action is a public POST endpoint dispatched by action id;
 *    route gating never covers it. Denials read as "not found" so
 *    existence isn't leaked.
 * 3. Returns `ActionResult` (or a purpose-built result type) — domain
 *    failures are values, never throws.
 *
 * Plain typed-object parameters, not the `(prevState, formData)` /
 * `useActionState` shape — check-in is a multi-step flow (search a place,
 * possibly create one, then confirm) rather than one plain `<form
 * action={...}>`, matching how `sovereign-plugin-kanban`'s own
 * `createProject`/`createBoard` (richer client-driven flows) are typed,
 * as distinct from its simpler single-field dialogs.
 */
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { sdk } from '@sovereignfs/sdk';
import { fail, ok, type ActionResult } from './_lib/action-result';
import { recomputeAutoLinksForActor } from './_lib/auto-link';
import {
  createAttachment,
  deleteAttachment,
  listAttachments,
  InvalidAttachmentTargetError,
  type AttachmentKind,
  type AttachmentRow,
} from './_lib/attachments';
import {
  requireAttachmentOwner,
  requireItineraryItemOwner,
  requireStopOwner,
  requireTripDayOwner,
  requireTripOwner,
  requireUser,
  requireVisitOwner,
} from './_lib/authz';
import { getDb } from './_lib/db';
import {
  getImportJob,
  getLatestImportJob,
  setImportJobPlatformJobId,
  type ImportJobRow,
} from './_lib/import-jobs';
import {
  createItineraryItem,
  deleteItineraryItem,
  reorderItineraryItem,
  updateItineraryItem,
  type CreateItineraryItemInput,
  type ItineraryItemRow,
  type UpdateItineraryItemInput,
} from './_lib/itinerary-items';
import { getPlaceProvider, type PlaceCandidate } from './_lib/place-provider';
import { createPlace, type PlaceRow } from './_lib/places';
import {
  getVisitDetail,
  getVisitTimelinePage,
  listRecentPlaces,
  type RecentPlace,
  type VisitDetail,
  type VisitTimelineCursor,
  type VisitTimelinePage,
} from './_lib/queries';
import {
  createStop,
  deleteStop,
  reorderStop,
  TripDayHasItemsError,
  updateStop,
  type CreateStopInput,
  type StopRow,
  type UpdateStopInput,
} from './_lib/stops';
import { isValidIanaTimeZone, localDateKey } from './_lib/timezone';
import {
  resolveActiveStop,
  resolveTripModeToday,
  type ActiveStopInfo,
  type TripModeToday,
} from './_lib/trip-mode';
import { createTrip, deleteTrip, updateTrip, type TripRow, type UpdateTripInput } from './_lib/trips';
import {
  createVisit,
  deleteVisit,
  isVisitAlreadySynced,
  setVisitTripLink,
  updateVisit,
  type CreateVisitPhotoInput,
  type UpdateVisitInput,
} from './_lib/visits';

const NOT_FOUND_VISIT = 'Check-in not found.';
const NOT_FOUND_TRIP = 'Trip not found.';
const NOT_FOUND_STOP = 'Stop not found.';
const NOT_FOUND_TRIP_DAY = 'Day not found.';
const NOT_FOUND_ITEM = 'Itinerary item not found.';
const NOT_FOUND_ATTACHMENT = 'Attachment not found.';

function refresh(): void {
  revalidatePath('/travellog', 'layout');
}

// ---------------------------------------------------------------------------
// Places

/** A read, not a mutation — no ActionResult wrapper; an empty array is a normal result. */
export async function searchPlacesAction(
  query: string,
  near?: { lat: number; lng: number },
): Promise<PlaceCandidate[]> {
  const actor = await requireUser();
  const db = await getDb();
  const provider = await getPlaceProvider(db, actor);
  return provider.search(query, near);
}

/**
 * A read, not a mutation. Backs `T.7`'s "check in here" GPS path — a single
 * best-guess candidate for the caller's current position, or `null` when
 * nothing resolves (the manual provider never can; the OSM provider's own
 * reverse endpoint returning nothing is a normal, expected outcome, not an
 * error). The caller always keeps `searchPlacesAction` available as a
 * fallback — this action never blocks manual/search entry.
 */
export async function reverseGeocodePlaceAction(
  lat: number,
  lng: number,
): Promise<PlaceCandidate | null> {
  const actor = await requireUser();
  const db = await getDb();
  const provider = await getPlaceProvider(db, actor);
  return provider.reverseGeocode(lat, lng);
}

/**
 * User-facing subset of `CreatePlaceInput` only — deliberately excludes
 * `source`/`sourceRef`. Those carry system meaning (`T.8`'s Swarm importer
 * writes `source: 'import'` directly via `createPlace()`, never through
 * this action); trusting a client-supplied `source` here would let a
 * hand-crafted call claim a place came from somewhere it didn't. Every
 * place created through this action is unconditionally `source: 'manual'`.
 */
export interface CreatePlaceActionInput {
  name: string;
  category?: string | null;
  lat?: number | null;
  lng?: number | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  countryCode?: string | null;
  postalCode?: string | null;
}

export type CreatePlaceActionResult =
  | { ok: true; place: Pick<PlaceRow, 'id' | 'name' | 'lat' | 'lng'> }
  | { ok: false; error: string };

export async function createPlaceAction(
  input: CreatePlaceActionInput,
): Promise<CreatePlaceActionResult> {
  const actor = await requireUser();
  const name = input.name.trim();
  if (name.length === 0) return { ok: false, error: 'Place name is required.' };

  const db = await getDb();
  const place = await createPlace(db, actor, { ...input, name, source: 'manual' });
  refresh();
  return { ok: true, place: { id: place.id, name: place.name, lat: place.lat, lng: place.lng } };
}

// ---------------------------------------------------------------------------
// Visits (check-ins)

/**
 * User-facing subset only — `'import:swarm'` and `externalRef` are never
 * client-controllable here; `T.8`'s importer calls `./_lib/visits.ts`'s
 * `createVisit()` directly with those, bypassing this action entirely
 * (it's a background job processing a whole export, not a per-visit form
 * submission).
 */
export interface CreateVisitActionInput {
  placeId: string;
  /** Unix ms, UTC — paired with tzIana/tzOffsetMinutes, both client-supplied. Never guessed server-side. */
  happenedAt: number;
  tzIana: string;
  tzOffsetMinutes: number;
  note?: string;
  companions?: string[];
  source: 'manual' | 'gps';
  photos?: CreateVisitPhotoInput[];
}

export async function createVisitAction(input: CreateVisitActionInput): Promise<ActionResult> {
  const actor = await requireUser();

  if (input.placeId.trim().length === 0) return fail('A check-in needs a place.');
  if (!Number.isFinite(input.happenedAt)) return fail('A check-in needs a real date and time.');
  if (!isValidIanaTimeZone(input.tzIana)) return fail("That timezone doesn't look valid.");

  const db = await getDb();
  await createVisit(db, actor, input);
  refresh();
  return ok('Checked in.');
}

/** A read, not a mutation. `T.21`'s offline check-in picker caches this client-side (`sdk.offline`) while online, for later selection with no network at all. */
export async function listRecentPlacesAction(): Promise<RecentPlace[]> {
  const actor = await requireUser();
  const db = await getDb();
  return listRecentPlaces(db, actor);
}

/**
 * `T.21` — applies one queued offline check-in (`sdk.offline-queue`'s
 * `drainQueue()`), keyed by the mutation's own client-minted `id` rather
 * than `createVisitAction`'s narrower public shape above (which
 * deliberately excludes `externalRef` — see that action's own doc
 * comment). A dedicated action, not an extension of `createVisitAction`,
 * for the same reason `T.8`'s importer calls `createVisit()` directly
 * instead of going through it: a different caller, a different input
 * shape, no reason to widen the normal per-visit form's own narrower
 * contract to accommodate it.
 *
 * Only ever offers a `placeId` the client already has — genuinely offline,
 * there's no way to search or create a *new* place (`_lib/queries.ts`'s
 * `listRecentPlaces` doc comment), so unlike `createVisitAction`, this
 * never resolves/creates a place itself.
 *
 * Idempotent by construction (RFC 0078 §4's apply contract,
 * `docs/plugin-development.md`'s "Offline writes" section): `mutationId`
 * becomes the created visit's `externalRef`, and a retried apply for a
 * mutation already synced — a resumed `drainQueue()` after a dropped
 * response, for instance — is a no-op `ok` rather than a duplicate visit.
 */
export interface SyncOfflineCheckinInput {
  placeId: string;
  happenedAt: number;
  tzIana: string;
  tzOffsetMinutes: number;
  note?: string;
}

export async function syncOfflineCheckinAction(
  mutationId: string,
  input: SyncOfflineCheckinInput,
): Promise<ActionResult> {
  const actor = await requireUser();

  if (input.placeId.trim().length === 0) return fail('A check-in needs a place.');
  if (!Number.isFinite(input.happenedAt)) return fail('A check-in needs a real date and time.');
  if (!isValidIanaTimeZone(input.tzIana)) return fail("That timezone doesn't look valid.");

  const db = await getDb();
  const alreadySynced = await isVisitAlreadySynced(db, actor, 'manual', mutationId);
  if (!alreadySynced) {
    await createVisit(db, actor, { ...input, source: 'manual', externalRef: mutationId });
    refresh();
  }
  return ok('Synced.');
}

export async function updateVisitAction(
  visitId: string,
  patch: UpdateVisitInput,
): Promise<ActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  const existing = await requireVisitOwner(db, visitId, actor);
  if (!existing) return fail(NOT_FOUND_VISIT);

  if (patch.tzIana !== undefined && !isValidIanaTimeZone(patch.tzIana)) {
    return fail("That timezone doesn't look valid.");
  }

  await updateVisit(db, visitId, patch);
  refresh();
  return ok('Check-in updated.');
}

export async function deleteVisitAction(visitId: string): Promise<ActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  const existing = await requireVisitOwner(db, visitId, actor);
  if (!existing) return fail(NOT_FOUND_VISIT);

  await deleteVisit(db, visitId);
  refresh();
  return ok('Check-in deleted.');
}

/**
 * A read, not a mutation — no `ActionResult` wrapper. `T.6`'s "Load more"
 * (subsequent pages) calls this again with the previous page's
 * `nextCursor`; the initial page load fetches server-side in
 * `app/(home)/checkins/page.tsx` directly (no client round trip needed for
 * the first page).
 */
export async function getVisitTimelinePageAction(
  cursor?: VisitTimelineCursor,
): Promise<VisitTimelinePage> {
  const actor = await requireUser();
  const db = await getDb();
  return getVisitTimelinePage(db, actor, cursor);
}

export interface VisitDetailPhotoView {
  id: string;
  /** A short-lived signed URL (RFC 0044), never the raw `storageKey` — the client should never see that. */
  url: string;
  position: number;
}

export type VisitDetailView = Omit<VisitDetail, 'photos'> & { photos: VisitDetailPhotoView[] };

/**
 * A read, not a mutation. Ownership-scoped inside `getVisitDetail` itself
 * (its own `WHERE` clause, not a separate `requireVisitOwner` call this
 * action could forget) — returns `null` for a non-existent or
 * not-your-own visit, indistinguishable from the caller's perspective
 * (`T.4`'s "reading someone else's visit is impossible").
 *
 * Resolves each photo's `storageKey` to a signed, short-lived URL here —
 * not in `_lib/queries.ts`, which stays a pure DB read with no `sdk.storage`
 * dependency. 1 hour (the max `sdk.storage.getSignedUrl` allows) rather
 * than the 5-minute default, so an open detail panel's images don't break
 * mid-view.
 *
 * `getSignedUrl` throws when the underlying object is gone (deleted,
 * failed upload, bad data) — expected, not exceptional, for one photo out
 * of a visit that may have several. Resolving each independently and
 * dropping the ones that fail means a single missing photo degrades to
 * "one fewer photo shown", not a thrown error that crashes the entire
 * detail panel (caught live: a seeded `visit_photos` row pointing at a
 * storage object that was never actually uploaded blew up the whole page).
 */
export async function getVisitDetailAction(visitId: string): Promise<VisitDetailView | null> {
  const actor = await requireUser();
  const db = await getDb();
  const detail = await getVisitDetail(db, actor, visitId);
  if (!detail) return null;

  const resolved = await Promise.all(
    detail.photos.map(async (photo) => {
      try {
        const url = await sdk.storage.getSignedUrl(photo.storageKey, { expiresInSeconds: 3600 });
        return { id: photo.id, url, position: photo.position };
      } catch (err) {
        console.error(`[travellog] Failed to resolve photo "${photo.id}" for check-in "${visitId}":`, err);
        return null;
      }
    }),
  );

  return { ...detail, photos: resolved.filter((photo) => photo !== null) };
}

// ---------------------------------------------------------------------------
// Swarm import (T.8)

/**
 * A read, not a mutation. The import status page's poll target — ownership-
 * scoped in its own `WHERE` clause (via `getLatestImportJob`), so it's only
 * ever the caller's own most recent import, never anyone else's.
 */
export async function getLatestImportJobAction(): Promise<ImportJobRow | null> {
  const actor = await requireUser();
  const db = await getDb();
  return getLatestImportJob(db, actor);
}

/**
 * Re-enqueues a `travellog_import_jobs` row's platform job — the "Resume"
 * affordance for a row stuck `running` (the platform never auto-reclaims a
 * crashed job; see that table's own doc comment) or still `pending`. The
 * handler always resumes from the row's own persisted `cursor`, never from
 * zero, regardless of how many times this fires.
 *
 * Deliberately no `dedupeKey`. A `dedupeKey` matching an "already-active
 * (queued/scheduled/running)" job would have seemed like the safe choice —
 * except a crashed job is indistinguishable from a healthy one by status
 * alone (the platform never auto-reclaims a stuck `running` row; see
 * `runtime/src/jobs.ts`'s own doc comment), so dedupe would silently no-op
 * *every* resume attempt against a truly dead job, permanently blocking the
 * one scenario this button exists for. The real safety net against a
 * genuine double-run (this landing while an earlier attempt is actually
 * still healthy) is `import-swarm.ts`'s own per-checkin de-dup check plus
 * `travellog_visits_tenant_source_external_ref_unique` (T.2) as the
 * final backstop if both still race on the same insert.
 */
export async function resumeImportAction(importJobId: string): Promise<ActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  const job = await getImportJob(db, importJobId);
  if (!job || job.tenantId !== actor.tenantId || job.userId !== actor.userId) {
    return fail('Import not found.');
  }
  if (job.status === 'completed') {
    return fail('This import has already finished.');
  }

  const requestHeaders = await headers();
  const jobRef = await sdk.jobs.enqueue(
    { type: 'import.swarm', payload: { importJobId } },
    requestHeaders,
  );
  await setImportJobPlatformJobId(db, importJobId, jobRef.id);
  refresh();
  return ok('Resuming import…');
}

// ---------------------------------------------------------------------------
// Trips (T.11)
//
// No separate "sharing" actions here — `travellog_trip_members` was never
// built (`T.10`'s status entry: CONCEPT.md's open question 2 was still
// unresolved). `trips.companions` is a plain field, edited through
// `updateTripAction` like any other — see `_lib/authz.ts`'s own header
// comment for the full reasoning.

export type CreateTripActionResult =
  | { ok: true; trip: Pick<TripRow, 'id' | 'name'> }
  | { ok: false; error: string };

export async function createTripAction(name: string): Promise<CreateTripActionResult> {
  const actor = await requireUser();
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, error: 'Trip name is required.' };

  const db = await getDb();
  const trip = await createTrip(db, actor, trimmed);
  refresh();
  return { ok: true, trip: { id: trip.id, name: trip.name } };
}

export async function updateTripAction(tripId: string, patch: UpdateTripInput): Promise<ActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  const existing = await requireTripOwner(db, tripId, actor);
  if (!existing) return fail(NOT_FOUND_TRIP);

  await updateTrip(db, tripId, patch);
  refresh();
  return ok('Trip updated.');
}

export async function deleteTripAction(tripId: string): Promise<ActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  const existing = await requireTripOwner(db, tripId, actor);
  if (!existing) return fail(NOT_FOUND_TRIP);

  await deleteTrip(db, tripId);
  refresh();
  return ok('Trip deleted.');
}

// ---------------------------------------------------------------------------
// Stops (T.11)

export type CreateStopActionResult =
  | { ok: true; stop: Pick<StopRow, 'id' | 'arriveDate' | 'departDate' | 'position'> }
  | { ok: false; error: string };

export async function createStopAction(
  tripId: string,
  input: CreateStopInput,
): Promise<CreateStopActionResult> {
  const actor = await requireUser();
  const db = await getDb();
  const trip = await requireTripOwner(db, tripId, actor);
  if (!trip) return { ok: false, error: NOT_FOUND_TRIP };

  try {
    const stop = await createStop(db, tripId, input);
    refresh();
    return {
      ok: true,
      stop: { id: stop.id, arriveDate: stop.arriveDate, departDate: stop.departDate, position: stop.position },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not add that stop.' };
  }
}

export async function updateStopAction(
  tripId: string,
  stopId: string,
  patch: UpdateStopInput,
): Promise<ActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  const trip = await requireTripOwner(db, tripId, actor);
  if (!trip) return fail(NOT_FOUND_TRIP);
  const stop = await requireStopOwner(db, stopId, actor);
  if (!stop || stop.tripId !== tripId) return fail(NOT_FOUND_STOP);

  try {
    await updateStop(db, tripId, stopId, patch);
  } catch (err) {
    if (err instanceof TripDayHasItemsError) return fail(err.message);
    throw err;
  }
  refresh();
  return ok('Stop updated.');
}

export async function deleteStopAction(tripId: string, stopId: string): Promise<ActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  const trip = await requireTripOwner(db, tripId, actor);
  if (!trip) return fail(NOT_FOUND_TRIP);
  const stop = await requireStopOwner(db, stopId, actor);
  if (!stop || stop.tripId !== tripId) return fail(NOT_FOUND_STOP);

  try {
    await deleteStop(db, tripId, stopId);
  } catch (err) {
    if (err instanceof TripDayHasItemsError) return fail(err.message);
    throw err;
  }
  refresh();
  return ok('Stop removed.');
}

/** `targetIndex` is 0-based among the trip's *other* stops — see `_lib/stops.ts`'s `reorderStop`. */
export async function reorderStopAction(
  tripId: string,
  stopId: string,
  targetIndex: number,
): Promise<ActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  const trip = await requireTripOwner(db, tripId, actor);
  if (!trip) return fail(NOT_FOUND_TRIP);
  const stop = await requireStopOwner(db, stopId, actor);
  if (!stop || stop.tripId !== tripId) return fail(NOT_FOUND_STOP);

  await reorderStop(db, tripId, stopId, targetIndex);
  refresh();
  return ok('Stop reordered.');
}

// ---------------------------------------------------------------------------
// Itinerary items (T.11)

export type CreateItineraryItemActionResult =
  | { ok: true; item: Pick<ItineraryItemRow, 'id' | 'position'> }
  | { ok: false; error: string };

export async function createItineraryItemAction(
  tripDayId: string,
  input: CreateItineraryItemInput,
): Promise<CreateItineraryItemActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  const day = await requireTripDayOwner(db, tripDayId, actor);
  if (!day) return { ok: false, error: NOT_FOUND_TRIP_DAY };

  try {
    const item = await createItineraryItem(db, tripDayId, day.tripId, input);
    refresh();
    return { ok: true, item: { id: item.id, position: item.position } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not add that item.' };
  }
}

export async function updateItineraryItemAction(
  itemId: string,
  patch: UpdateItineraryItemInput,
): Promise<ActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  const existing = await requireItineraryItemOwner(db, itemId, actor);
  if (!existing) return fail(NOT_FOUND_ITEM);

  try {
    await updateItineraryItem(db, itemId, patch);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Could not update that item.');
  }
  refresh();
  return ok('Item updated.');
}

export async function deleteItineraryItemAction(itemId: string): Promise<ActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  const existing = await requireItineraryItemOwner(db, itemId, actor);
  if (!existing) return fail(NOT_FOUND_ITEM);

  await deleteItineraryItem(db, itemId);
  refresh();
  return ok('Item removed.');
}

/** `targetIndex` is 0-based among the day's *other* items — see `_lib/itinerary-items.ts`'s `reorderItineraryItem`. */
export async function reorderItineraryItemAction(
  tripDayId: string,
  itemId: string,
  targetIndex: number,
): Promise<ActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  const day = await requireTripDayOwner(db, tripDayId, actor);
  if (!day) return fail(NOT_FOUND_TRIP_DAY);
  const item = await requireItineraryItemOwner(db, itemId, actor);
  if (!item || item.tripDayId !== tripDayId) return fail(NOT_FOUND_ITEM);

  await reorderItineraryItem(db, tripDayId, itemId, targetIndex);
  refresh();
  return ok('Item reordered.');
}

// ---------------------------------------------------------------------------
// Attachments (T.11)

/**
 * Creates the DB row for an object `../(home)/trips/attachments/upload/route.ts`
 * already wrote to `sdk.storage` — ownership of the target (`tripId` or
 * `tripDayId`) is checked here independently of that route's own check
 * (never trust a client-supplied id twice removed from its own
 * authorization), which is also where `InvalidAttachmentTargetError`
 * (`T.10`'s XOR validator) gets translated into a plain `ActionResult`.
 */
export interface CreateAttachmentActionInput {
  tripId?: string;
  tripDayId?: string;
  kind: AttachmentKind;
  title: string;
  storageKey: string;
}

export async function createAttachmentAction(
  input: CreateAttachmentActionInput,
): Promise<ActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  if (input.tripId) {
    const trip = await requireTripOwner(db, input.tripId, actor);
    if (!trip) return fail(NOT_FOUND_TRIP);
  } else if (input.tripDayId) {
    const day = await requireTripDayOwner(db, input.tripDayId, actor);
    if (!day) return fail(NOT_FOUND_TRIP_DAY);
  }

  try {
    await createAttachment(db, actor, input);
  } catch (err) {
    if (err instanceof InvalidAttachmentTargetError) return fail(err.message);
    throw err;
  }
  refresh();
  return ok('Attachment added.');
}

export async function deleteAttachmentAction(attachmentId: string): Promise<ActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  const existing = await requireAttachmentOwner(db, attachmentId, actor);
  if (!existing) return fail(NOT_FOUND_ATTACHMENT);

  const deleted = await deleteAttachment(db, attachmentId);
  if (deleted) {
    await sdk.storage.delete(deleted.storageKey);
  }
  refresh();
  return ok('Attachment deleted.');
}

export interface TripAttachmentView {
  id: string;
  kind: AttachmentKind;
  title: string;
  url: string;
}

/**
 * `T.17` — fetched on demand when `TripDetailPanel` opens for a trip, same
 * "resolve on select, not bundled into the cards list fetch" pattern as
 * Check-ins' `getVisitDetailAction`. Signed URLs, not raw `storageKey`s,
 * for the same reason: a client-rendered download/view link needs a URL it
 * can actually use. Resolves each attachment's URL independently and drops
 * the ones that fail (`getSignedUrl` throws for a gone/never-uploaded
 * object) rather than let one bad attachment blank the whole panel — same
 * defensive shape `getVisitDetailAction` already established for photos.
 */
export async function getTripAttachmentsAction(tripId: string): Promise<TripAttachmentView[]> {
  const actor = await requireUser();
  const db = await getDb();

  const trip = await requireTripOwner(db, tripId, actor);
  if (!trip) return [];

  const rows = await listAttachments(db, tripId);
  const resolved = await Promise.all(
    rows.map(async (row: AttachmentRow) => {
      try {
        const url = await sdk.storage.getSignedUrl(row.storageKey, { expiresInSeconds: 3600 });
        return { id: row.id, kind: row.kind as AttachmentKind, title: row.title, url };
      } catch (err) {
        console.error(`[travellog] Failed to resolve attachment "${row.id}" for trip "${tripId}":`, err);
        return null;
      }
    }),
  );
  return resolved.filter((a) => a !== null);
}

// ---------------------------------------------------------------------------
// Auto-link (T.12)

/**
 * The manual-override / "Unlink" action — `T.6`'s detail column is the UI
 * hook point (`CheckinDetailPanel.tsx`'s Unlink button). `tripId: null`
 * unlinks; a real id links to that trip. Either way this always writes
 * `linkSource: 'manual'` (`_lib/visits.ts`'s `setVisitTripLink`), so a
 * future recompute never overrides the user's explicit choice — including
 * the unlink, which is why this isn't just `updateVisitAction` with a
 * `tripId` field.
 */
export async function setVisitTripLinkAction(
  visitId: string,
  tripId: string | null,
): Promise<ActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  const visit = await requireVisitOwner(db, visitId, actor);
  if (!visit) return fail(NOT_FOUND_VISIT);

  if (tripId) {
    const trip = await requireTripOwner(db, tripId, actor);
    if (!trip) return fail(NOT_FOUND_TRIP);
  }

  await setVisitTripLink(db, visitId, tripId);
  refresh();
  return ok(tripId ? 'Check-in linked to trip.' : 'Check-in unlinked.');
}

/**
 * The explicit "recompute auto-links" deliverable (SPEC.md's `T.12`) — a
 * manual escape hatch. `./_lib/stops.ts`'s create/update/delete/reorder
 * already trigger this automatically after every stop mutation, so this
 * action is a repair/backstop path (e.g. after a future data migration),
 * not the primary trigger.
 */
export async function recomputeMyAutoLinksAction(): Promise<ActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  const changed = await recomputeAutoLinksForActor(db, actor);
  refresh();
  return ok(
    changed === 0
      ? 'Check-in links are already up to date.'
      : `Updated ${String(changed)} check-in link${changed === 1 ? '' : 's'}.`,
  );
}

// ---------------------------------------------------------------------------
// Trip Mode (T.19)

export interface TripModeView {
  stop: ActiveStopInfo;
  today: TripModeToday;
}

/**
 * `nowUtcMs`/`tzIana` are the caller's own current instant and zone — never
 * guessed server-side, same rule `createVisitAction`'s own `tzIana`
 * parameter already follows. Returns `null` both when the caller doesn't
 * own the trip and when no stop covers today: the caller can't tell "not
 * yours" from "not active right now" apart from this alone, which is
 * exactly right — the former matches this file's "denial reads as not
 * found" convention, the latter is `T.19`'s own "empty state outside the
 * trip's real date range" deliverable, and neither should look different
 * from the other to someone probing for a trip id that isn't theirs.
 */
export async function getTripModeAction(
  tripId: string,
  nowUtcMs: number,
  tzIana: string,
): Promise<TripModeView | null> {
  const actor = await requireUser();
  const db = await getDb();

  const trip = await requireTripOwner(db, tripId, actor);
  if (!trip || !isValidIanaTimeZone(tzIana)) return null;

  const dateKey = localDateKey(nowUtcMs, tzIana);
  const stop = await resolveActiveStop(db, tripId, dateKey);
  if (!stop) return null;

  const today = await resolveTripModeToday(db, stop.stopId, nowUtcMs, tzIana);
  if (!today) return null;

  return { stop, today };
}
