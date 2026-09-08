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
 * 3. Runtime input validation (`_lib/validation.ts`) — the TypeScript
 *    parameter types are documentation, not enforcement, for a public
 *    endpoint. Every enum, length, range, and format is re-checked before
 *    a write, and the failure is a `fail(...)` value, never a thrown
 *    driver error (which would surface as a 500 and, in a catch-all,
 *    could leak internal error text to the client).
 * 4. Returns `ActionResult` (or a purpose-built result type) — domain
 *    failures are values, never throws.
 *
 * Plain typed-object parameters, not the `(prevState, formData)` /
 * `useActionState` shape — check-in is a multi-step flow (search a place,
 * possibly create one, then confirm) rather than one plain `<form
 * action={...}>`, matching how `sovereign-plugin-kanban`'s own
 * `createProject`/`createBoard` (richer client-driven flows) are typed,
 * as distinct from its simpler single-field dialogs.
 *
 * Storage cleanup: the data layer never touches `sdk.storage` (so it stays
 * testable against a bare DB — `_lib/attachments.ts`'s header); every
 * delete below that cascades away photo/attachment rows gets their keys
 * back and removes the objects here, after the transaction has committed.
 */
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { sdk } from '@sovereignfs/sdk';
import { fail, ok, type ActionResult } from './_lib/action-result';
import { recomputeAutoLinksForActor } from './_lib/auto-link';
import {
  createAttachment,
  deleteAttachment,
  listAttachmentsWithDates,
  InvalidAttachmentTargetError,
  type AttachmentKind,
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
  cancelImportJob,
  getImportJob,
  getLatestImportJob,
  reopenImportJob,
  setImportJobPlatformJobId,
  type ImportJobRow,
} from './_lib/import-jobs';
import {
  createItineraryItem,
  deleteItineraryItem,
  ItineraryItemValidationError,
  moveItineraryItem,
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
  listTripsForLinking,
  type RecentPlace,
  type TripLinkOption,
  type VisitDetail,
  type VisitTimelineCursor,
  type VisitTimelineFilter,
  type VisitTimelinePage,
} from './_lib/queries';
import {
  createStop,
  deleteStop,
  reorderStop,
  StopValidationError,
  updateStop,
  type CreateStopInput,
  type StopRow,
  type UpdateStopInput,
} from './_lib/stops';
import { plural } from './_lib/format';
import { isValidIanaTimeZone, localDateKey } from './_lib/timezone';
import {
  resolveActiveStop,
  resolveTripModeToday,
  type ActiveStopInfo,
  type TripModeToday,
} from './_lib/trip-mode';
import {
  createTrip,
  deleteTrip,
  updateTrip,
  type TripRow,
  type UpdateTripInput,
} from './_lib/trips';
import {
  isNonEmptyString,
  isOneOf,
  isOptionalString,
  isOwnStorageKey,
  isValidDateKeyInput,
  isValidHappenedAt,
  isValidIndex,
  isValidLatitude,
  isValidLongitude,
  isValidPlannedTime,
  isValidTzOffsetMinutes,
  MAX_NAME_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_PHOTOS_PER_VISIT,
  MAX_TITLE_LENGTH,
  normalizeCompanions,
} from './_lib/validation';
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
const INVALID_TIMEZONE = "That timezone doesn't look valid.";
const INVALID_HAPPENED_AT = 'A check-in needs a real date and time — not in the future.';
const INVALID_COMPANIONS = 'Companion names must be short text.';
const NOTE_TOO_LONG = `A note can be at most ${String(MAX_NOTE_LENGTH)} characters.`;

const ATTACHMENT_KINDS = ['receipt', 'booking', 'accommodation', 'other'] as const;
const VISIT_SOURCES = ['manual', 'gps'] as const;
const PHOTO_SOURCES = ['upload'] as const;

function refresh(): void {
  revalidatePath('/travellog', 'layout');
}

/** Best-effort removal of storage objects whose rows are already gone — a leftover object is a quota leak, never a reason to fail the user's action. */
async function deleteStorageObjects(keys: string[]): Promise<void> {
  for (const key of new Set(keys)) {
    try {
      await sdk.storage.delete(key);
    } catch (err) {
      console.error(`[travellog] Could not remove storage object "${key}":`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Places

/** A read, not a mutation — no ActionResult wrapper; an empty array is a normal result. */
export async function searchPlacesAction(
  query: string,
  near?: { lat: number; lng: number },
): Promise<PlaceCandidate[]> {
  const actor = await requireUser();
  if (typeof query !== 'string' || query.trim().length === 0 || query.length > MAX_NAME_LENGTH)
    return [];
  const nearValid =
    near && isValidLatitude(near.lat) && isValidLongitude(near.lng) ? near : undefined;
  const db = await getDb();
  const provider = await getPlaceProvider(db, actor);
  return provider.search(query, nearValid);
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
  if (!isValidLatitude(lat) || !isValidLongitude(lng)) return null;
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
  { ok: true; place: Pick<PlaceRow, 'id' | 'name' | 'lat' | 'lng'> } | { ok: false; error: string };

export async function createPlaceAction(
  input: CreatePlaceActionInput,
): Promise<CreatePlaceActionResult> {
  const actor = await requireUser();
  if (!isNonEmptyString(input.name, MAX_NAME_LENGTH)) {
    return { ok: false, error: 'Place name is required.' };
  }
  const name = input.name.trim();
  const hasLat = input.lat != null;
  const hasLng = input.lng != null;
  if (hasLat !== hasLng)
    return { ok: false, error: 'A place needs both a latitude and a longitude.' };
  if (hasLat && (!isValidLatitude(input.lat) || !isValidLongitude(input.lng))) {
    return { ok: false, error: 'Those coordinates are out of range.' };
  }
  for (const field of [
    'category',
    'address',
    'city',
    'state',
    'country',
    'countryCode',
    'postalCode',
  ] as const) {
    if (!isOptionalString(input[field], MAX_NAME_LENGTH)) {
      return { ok: false, error: 'Place details must be short text.' };
    }
  }

  const db = await getDb();
  const place = await createPlace(db, actor, {
    name,
    category: input.category ?? null,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    address: input.address ?? null,
    city: input.city ?? null,
    state: input.state ?? null,
    country: input.country ?? null,
    countryCode: input.countryCode ?? null,
    postalCode: input.postalCode ?? null,
    source: 'manual',
  });
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

  if (!isNonEmptyString(input.placeId, 64)) return fail('A check-in needs a place.');
  if (!isValidHappenedAt(input.happenedAt)) return fail(INVALID_HAPPENED_AT);
  if (!isValidIanaTimeZone(input.tzIana)) return fail(INVALID_TIMEZONE);
  if (!isValidTzOffsetMinutes(input.tzOffsetMinutes)) return fail(INVALID_TIMEZONE);
  if (!isOptionalString(input.note, MAX_NOTE_LENGTH)) return fail(NOTE_TOO_LONG);
  if (!isOneOf(input.source, VISIT_SOURCES)) return fail('Unknown check-in source.');
  const companions = normalizeCompanions(input.companions);
  if (!companions) return fail(INVALID_COMPANIONS);
  const photos = input.photos ?? [];
  if (!Array.isArray(photos) || photos.length > MAX_PHOTOS_PER_VISIT) {
    return fail(`A check-in can have at most ${String(MAX_PHOTOS_PER_VISIT)} photos.`);
  }
  for (const photo of photos) {
    // Only a key this plugin minted for *this* user through the upload
    // route — see `isOwnStorageKey`'s doc comment for what a foreign key
    // would otherwise let a caller do through this plugin's own storage calls.
    if (
      !isOwnStorageKey(photo?.storageKey, 'visits', actor.userId) ||
      !isOneOf(photo.source, PHOTO_SOURCES)
    ) {
      return fail('That photo upload isn’t valid. Try uploading it again.');
    }
  }

  const db = await getDb();
  try {
    await createVisit(db, actor, {
      placeId: input.placeId.trim(),
      happenedAt: input.happenedAt,
      tzIana: input.tzIana,
      tzOffsetMinutes: input.tzOffsetMinutes,
      note: input.note?.trim() || null,
      companions,
      source: input.source,
      photos: photos.map((p) => ({ storageKey: p.storageKey, source: p.source })),
    });
  } catch (err) {
    if (isForeignKeyError(err)) return fail('That place no longer exists — pick it again.');
    throw err;
  }
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
 * The `externalRef` is namespaced with the user id: the unique index is
 * per tenant, not per user, so two devices minting the same id for two
 * different users must never collide into a raw constraint error (which
 * `drainQueue` would retry forever).
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

  if (!isNonEmptyString(mutationId, 128)) return fail('That queued check-in is malformed.');
  if (!isNonEmptyString(input.placeId, 64)) return fail('A check-in needs a place.');
  if (!isValidHappenedAt(input.happenedAt)) return fail(INVALID_HAPPENED_AT);
  if (!isValidIanaTimeZone(input.tzIana)) return fail(INVALID_TIMEZONE);
  if (!isValidTzOffsetMinutes(input.tzOffsetMinutes)) return fail(INVALID_TIMEZONE);
  if (!isOptionalString(input.note, MAX_NOTE_LENGTH)) return fail(NOTE_TOO_LONG);

  const externalRef = `${actor.userId}:${mutationId}`;
  const db = await getDb();
  const alreadySynced = await isVisitAlreadySynced(db, actor, 'manual', externalRef);
  if (!alreadySynced) {
    try {
      await createVisit(db, actor, {
        placeId: input.placeId,
        happenedAt: input.happenedAt,
        tzIana: input.tzIana,
        tzOffsetMinutes: input.tzOffsetMinutes,
        note: input.note?.trim() || null,
        source: 'manual',
        externalRef,
      });
    } catch (err) {
      if (isForeignKeyError(err)) return fail('That place no longer exists.');
      throw err;
    }
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

  if (patch.tzIana !== undefined && !isValidIanaTimeZone(patch.tzIana))
    return fail(INVALID_TIMEZONE);
  if (patch.happenedAt !== undefined && !isValidHappenedAt(patch.happenedAt))
    return fail(INVALID_HAPPENED_AT);
  if (patch.tzOffsetMinutes !== undefined && !isValidTzOffsetMinutes(patch.tzOffsetMinutes)) {
    return fail(INVALID_TIMEZONE);
  }
  if (!isOptionalString(patch.note, MAX_NOTE_LENGTH)) return fail(NOTE_TOO_LONG);
  const companions =
    patch.companions === undefined ? undefined : normalizeCompanions(patch.companions);
  if (companions === null) return fail(INVALID_COMPANIONS);

  await updateVisit(db, visitId, {
    ...(patch.note !== undefined ? { note: patch.note?.trim() || null } : {}),
    ...(companions !== undefined ? { companions } : {}),
    ...(patch.happenedAt !== undefined ? { happenedAt: patch.happenedAt } : {}),
    ...(patch.tzIana !== undefined ? { tzIana: patch.tzIana } : {}),
    ...(patch.tzOffsetMinutes !== undefined ? { tzOffsetMinutes: patch.tzOffsetMinutes } : {}),
  });
  refresh();
  return ok('Check-in updated.');
}

export async function deleteVisitAction(visitId: string): Promise<ActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  const existing = await requireVisitOwner(db, visitId, actor);
  if (!existing) return fail(NOT_FOUND_VISIT);

  const { photoStorageKeys } = await deleteVisit(db, visitId);
  await deleteStorageObjects(photoStorageKeys);
  refresh();
  return ok('Check-in deleted.');
}

/**
 * A read, not a mutation — no `ActionResult` wrapper. `T.6`'s "Load more"
 * (subsequent pages) calls this again with the previous page's
 * `nextCursor`; the initial page load fetches server-side in
 * `app/(home)/checkins/page.tsx` directly (no client round trip needed for
 * the first page). `filter` narrows to one place and/or one trip.
 */
export async function getVisitTimelinePageAction(
  cursor?: VisitTimelineCursor,
  filter?: VisitTimelineFilter,
): Promise<VisitTimelinePage> {
  const actor = await requireUser();
  const db = await getDb();
  const safeCursor =
    cursor && Number.isFinite(cursor.happenedAt) && typeof cursor.id === 'string'
      ? cursor
      : undefined;
  const safeFilter: VisitTimelineFilter = {
    ...(isNonEmptyString(filter?.placeId, 64) ? { placeId: filter.placeId } : {}),
    ...(isNonEmptyString(filter?.tripId, 64) ? { tripId: filter.tripId } : {}),
  };
  return getVisitTimelinePage(db, actor, safeCursor, safeFilter);
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
        console.error(
          `[travellog] Failed to resolve photo "${photo.id}" for check-in "${visitId}":`,
          err,
        );
        return null;
      }
    }),
  );

  return { ...detail, photos: resolved.filter((photo) => photo !== null) };
}

/** A read, not a mutation — the "Link to trip" picker's option list, the caller's own trips only. */
export async function listTripsForLinkAction(): Promise<TripLinkOption[]> {
  const actor = await requireUser();
  const db = await getDb();
  return listTripsForLinking(db, actor);
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
 * crashed job; see that table's own doc comment), still `pending`, marked
 * `failed`, or `cancelled` by the user. The handler always resumes from the
 * row's own persisted `cursor`, never from zero, regardless of how many
 * times this fires.
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
  if (job.status === 'cancelled') {
    // The handler treats a `cancelled` row as terminal — flip it back to
    // pending before re-enqueueing so the resumed attempt actually runs.
    await reopenImportJob(db, importJobId);
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

/** Asks a running import to stop at its next progress checkpoint — the cursor is kept, so "Resume" later continues from there. */
export async function cancelImportAction(importJobId: string): Promise<ActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  const job = await getImportJob(db, importJobId);
  if (!job || job.tenantId !== actor.tenantId || job.userId !== actor.userId) {
    return fail('Import not found.');
  }
  const cancelled = await cancelImportJob(db, importJobId);
  if (!cancelled) return fail('This import isn’t running.');
  refresh();
  return ok('Stopping the import…');
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
  { ok: true; trip: Pick<TripRow, 'id' | 'name'> } | { ok: false; error: string };

export async function createTripAction(name: string): Promise<CreateTripActionResult> {
  const actor = await requireUser();
  if (!isNonEmptyString(name, MAX_NAME_LENGTH))
    return { ok: false, error: 'Trip name is required.' };
  const trimmed = name.trim();

  const db = await getDb();
  const trip = await createTrip(db, actor, trimmed);
  refresh();
  return { ok: true, trip: { id: trip.id, name: trip.name } };
}

export async function updateTripAction(
  tripId: string,
  patch: UpdateTripInput,
): Promise<ActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  const existing = await requireTripOwner(db, tripId, actor);
  if (!existing) return fail(NOT_FOUND_TRIP);

  if (patch.name !== undefined && !isNonEmptyString(patch.name, MAX_NAME_LENGTH)) {
    return fail('Trip name is required.');
  }
  if (patch.timezone != null && !isValidIanaTimeZone(patch.timezone)) return fail(INVALID_TIMEZONE);
  const companions =
    patch.companions === undefined ? undefined : normalizeCompanions(patch.companions);
  if (companions === null) return fail(INVALID_COMPANIONS);

  await updateTrip(db, tripId, {
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
    ...(companions !== undefined ? { companions } : {}),
  });
  refresh();
  return ok('Trip updated.');
}

export async function deleteTripAction(tripId: string): Promise<ActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  const existing = await requireTripOwner(db, tripId, actor);
  if (!existing) return fail(NOT_FOUND_TRIP);

  const { attachmentStorageKeys } = await deleteTrip(db, tripId);
  await deleteStorageObjects(attachmentStorageKeys);
  refresh();
  return ok('Trip deleted.');
}

// ---------------------------------------------------------------------------
// Stops (T.11)

export type CreateStopActionResult =
  | { ok: true; stop: Pick<StopRow, 'id' | 'arriveDate' | 'departDate' | 'position'> }
  | { ok: false; error: string };

function validateStopPatch(input: Partial<CreateStopInput>): string | null {
  if (input.placeId !== undefined && !isNonEmptyString(input.placeId, 64))
    return 'A stop needs a place.';
  if (input.arriveDate !== undefined && !isValidDateKeyInput(input.arriveDate)) {
    return 'A stop needs a real arrival date.';
  }
  if (input.departDate !== undefined && !isValidDateKeyInput(input.departDate)) {
    return 'A stop needs a real departure date.';
  }
  return null;
}

export async function createStopAction(
  tripId: string,
  input: CreateStopInput,
): Promise<CreateStopActionResult> {
  const actor = await requireUser();
  const db = await getDb();
  const trip = await requireTripOwner(db, tripId, actor);
  if (!trip) return { ok: false, error: NOT_FOUND_TRIP };

  if (!isNonEmptyString(input.placeId, 64)) return { ok: false, error: 'A stop needs a place.' };
  const invalid = validateStopPatch(input);
  if (invalid) return { ok: false, error: invalid };

  try {
    const stop = await createStop(db, tripId, {
      placeId: input.placeId.trim(),
      arriveDate: input.arriveDate,
      departDate: input.departDate,
    });
    refresh();
    return {
      ok: true,
      stop: {
        id: stop.id,
        arriveDate: stop.arriveDate,
        departDate: stop.departDate,
        position: stop.position,
      },
    };
  } catch (err) {
    if (err instanceof StopValidationError) return { ok: false, error: err.message };
    if (isForeignKeyError(err))
      return { ok: false, error: 'That place no longer exists — pick it again.' };
    throw err;
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

  const invalid = validateStopPatch(patch);
  if (invalid) return fail(invalid);

  try {
    await updateStop(db, tripId, stopId, {
      ...(patch.placeId !== undefined ? { placeId: patch.placeId.trim() } : {}),
      ...(patch.arriveDate !== undefined ? { arriveDate: patch.arriveDate } : {}),
      ...(patch.departDate !== undefined ? { departDate: patch.departDate } : {}),
    });
  } catch (err) {
    if (err instanceof StopValidationError) return fail(err.message);
    if (isForeignKeyError(err)) return fail('That place no longer exists — pick it again.');
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

  let attachmentStorageKeys: string[];
  try {
    ({ attachmentStorageKeys } = await deleteStop(db, tripId, stopId));
  } catch (err) {
    if (err instanceof StopValidationError) return fail(err.message);
    throw err;
  }
  await deleteStorageObjects(attachmentStorageKeys);
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
  if (!isValidIndex(targetIndex)) return fail('Invalid position.');

  await reorderStop(db, tripId, stopId, targetIndex);
  refresh();
  return ok('Stop reordered.');
}

// ---------------------------------------------------------------------------
// Itinerary items (T.11)

export type CreateItineraryItemActionResult =
  { ok: true; item: Pick<ItineraryItemRow, 'id' | 'position'> } | { ok: false; error: string };

function validateItemPatch(input: UpdateItineraryItemInput): string | null {
  if (input.placeId != null && !isNonEmptyString(input.placeId, 64))
    return 'That place isn’t valid.';
  if (!isOptionalString(input.title, MAX_TITLE_LENGTH)) {
    return `A title can be at most ${String(MAX_TITLE_LENGTH)} characters.`;
  }
  if (input.plannedTime != null && !isValidPlannedTime(input.plannedTime)) {
    return 'A planned time must look like 14:30.';
  }
  if (input.isFixed !== undefined && typeof input.isFixed !== 'boolean')
    return 'Invalid fixed flag.';
  if (!isOptionalString(input.notes, MAX_NOTE_LENGTH)) return NOTE_TOO_LONG;
  return null;
}

export async function createItineraryItemAction(
  tripDayId: string,
  input: CreateItineraryItemInput,
): Promise<CreateItineraryItemActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  const day = await requireTripDayOwner(db, tripDayId, actor);
  if (!day) return { ok: false, error: NOT_FOUND_TRIP_DAY };
  const invalid = validateItemPatch(input);
  if (invalid) return { ok: false, error: invalid };

  try {
    const item = await createItineraryItem(db, tripDayId, day.tripId, input);
    refresh();
    return { ok: true, item: { id: item.id, position: item.position } };
  } catch (err) {
    if (err instanceof ItineraryItemValidationError) return { ok: false, error: err.message };
    if (isForeignKeyError(err))
      return { ok: false, error: 'That place no longer exists — pick it again.' };
    throw err;
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
  const invalid = validateItemPatch(patch);
  if (invalid) return fail(invalid);

  try {
    await updateItineraryItem(db, itemId, patch);
  } catch (err) {
    if (err instanceof ItineraryItemValidationError) return fail(err.message);
    if (isForeignKeyError(err)) return fail('That place no longer exists — pick it again.');
    throw err;
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

/** Moves an item to another day of the same trip (appended at the end of that day). Both the item and the target day must be the caller's. */
export async function moveItineraryItemAction(
  itemId: string,
  targetTripDayId: string,
): Promise<ActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  const existing = await requireItineraryItemOwner(db, itemId, actor);
  if (!existing) return fail(NOT_FOUND_ITEM);
  const day = await requireTripDayOwner(db, targetTripDayId, actor);
  if (!day) return fail(NOT_FOUND_TRIP_DAY);

  try {
    await moveItineraryItem(db, itemId, targetTripDayId);
  } catch (err) {
    if (err instanceof ItineraryItemValidationError) return fail(err.message);
    throw err;
  }
  refresh();
  return ok('Item moved.');
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
  if (!isValidIndex(targetIndex)) return fail('Invalid position.');

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
 * The `storageKey` must be one that route minted for this user
 * (`isOwnStorageKey`) — a foreign key here would let a caller sign, and
 * later delete, any object whose key they'd learned.
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

  const tripId = input.tripId || undefined;
  const tripDayId = input.tripDayId || undefined;
  if (tripId) {
    const trip = await requireTripOwner(db, tripId, actor);
    if (!trip) return fail(NOT_FOUND_TRIP);
  } else if (tripDayId) {
    const day = await requireTripDayOwner(db, tripDayId, actor);
    if (!day) return fail(NOT_FOUND_TRIP_DAY);
  }
  if (!isOneOf(input.kind, ATTACHMENT_KINDS)) return fail('Unknown attachment kind.');
  if (!isNonEmptyString(input.title, MAX_TITLE_LENGTH)) return fail('An attachment needs a title.');
  if (!isOwnStorageKey(input.storageKey, 'attachments', actor.userId)) {
    return fail('That upload isn’t valid. Try uploading the file again.');
  }

  try {
    await createAttachment(db, actor, {
      tripId,
      tripDayId,
      kind: input.kind,
      title: input.title.trim(),
      storageKey: input.storageKey,
    });
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
  if (deleted) await deleteStorageObjects([deleted.storageKey]);
  refresh();
  return ok('Attachment deleted.');
}

export interface TripAttachmentView {
  id: string;
  kind: AttachmentKind;
  title: string;
  url: string;
  /** The day this attachment belongs to (`YYYY-MM-DD`), or `null` for a trip-level one. */
  date: string | null;
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

  const rows = await listAttachmentsWithDates(db, tripId);
  const resolved = await Promise.all(
    rows.map(async (row) => {
      try {
        const url = await sdk.storage.getSignedUrl(row.storageKey, { expiresInSeconds: 3600 });
        return {
          id: row.id,
          kind: row.kind as AttachmentKind,
          title: row.title,
          url,
          date: row.date,
        };
      } catch (err) {
        console.error(
          `[travellog] Failed to resolve attachment "${row.id}" for trip "${tripId}":`,
          err,
        );
        return null;
      }
    }),
  );
  return resolved.filter((a) => a !== null);
}

// ---------------------------------------------------------------------------
// Auto-link (T.12)

/**
 * The manual-override action — `T.6`'s detail column is the UI hook point
 * (`CheckinDetailPanel.tsx`'s Unlink button and "Link to trip" picker).
 * `tripId: null` unlinks; a real id links to that trip. Either way this
 * always writes `linkSource: 'manual'` (`_lib/visits.ts`'s `setVisitTripLink`),
 * so a future recompute never overrides the user's explicit choice —
 * including the unlink, which is why this isn't just `updateVisitAction`
 * with a `tripId` field.
 */
export async function setVisitTripLinkAction(
  visitId: string,
  tripId: string | null,
): Promise<ActionResult> {
  const actor = await requireUser();
  const db = await getDb();

  const visit = await requireVisitOwner(db, visitId, actor);
  if (!visit) return fail(NOT_FOUND_VISIT);

  if (tripId !== null && !isNonEmptyString(tripId, 64)) return fail(NOT_FOUND_TRIP);
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
      : `Updated ${plural(changed, 'check-in link')}.`,
  );
}

// ---------------------------------------------------------------------------
// Trip Mode (T.19)

export interface TripModeView {
  stop: ActiveStopInfo;
  today: TripModeToday;
  /** The zone `today` was resolved in — echoed back so the client re-derives "next" and the countdown in the same zone as the clock ticks. */
  tzIana: string;
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
  if (!trip || !isValidIanaTimeZone(tzIana) || !Number.isFinite(nowUtcMs)) return null;

  const dateKey = localDateKey(nowUtcMs, tzIana);
  const stop = await resolveActiveStop(db, tripId, dateKey);
  if (!stop) return null;

  const today = await resolveTripModeToday(db, stop.stopId, nowUtcMs, tzIana);
  if (!today) return null;

  return { stop, today, tzIana };
}

// ---------------------------------------------------------------------------

/** A driver FK violation (a `placeId` that doesn't exist) — surfaced as a friendly `fail`, never a 500 or a raw constraint message. */
function isForeignKeyError(err: unknown): boolean {
  const text = [err, (err as { cause?: unknown } | null)?.cause]
    .map((e) => (e instanceof Error ? e.message : String(e ?? '')))
    .join(' ');
  return /foreign key/i.test(text);
}
