/**
 * Sovereign portability hooks (RFC 0007, RFC 0052) — `T.23`. Additional to,
 * not a replacement for, the Swarm importer (`T.8`): see SPEC.md's "Import
 * design" for why these are two separate mechanisms. `travellog_import_jobs`
 * is deliberately excluded from the export — it tracks one Swarm-upload
 * job's resume cursor against a ZIP stored on *this* instance, which has no
 * meaning after a cross-instance restore (a fresh Swarm import needs a
 * fresh ZIP upload there anyway).
 *
 * Every table here has exactly one owner (`authz.ts`'s own header comment:
 * "a trip has exactly one owner, same as a visit" — real shared access,
 * `travellog_trip_members`, was never built, `T.10`/`T.14`), so — unlike
 * `sovereign-plugin-docs`' `portability.ts`, which has to find a successor
 * owner for a shared document/folder before deleting one — deletion here is
 * a straight per-user row sweep, no membership transfer needed.
 *
 * `visits`/`trips`/`places` carry a real `tenant_id` column and are scoped
 * by it directly; `stops`/`trip_days`/`itinerary_items`/`attachments` don't
 * (`authz.ts`: ownership for those is always resolved transitively through
 * the trip they belong to) — scoped here the same way, via `inArray` over
 * the user's own trip ids.
 *
 * `manifest.json` already declared `data:export`/`data:import` ahead of
 * this task (scaffolded early, per this repo's own pattern elsewhere) —
 * `docs/plugin-development.md` warns against exactly that ("declare only
 * once you've actually registered the matching hook"); this file is what
 * finally earns it.
 */
import { sdk } from '@sovereignfs/sdk';
import type {
  DeletionContext,
  DeletionResult,
  ExportContext,
  ImportContext,
  PluginExportSection,
} from '@sovereignfs/sdk';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type { TravellogDb } from '../_db/client';
import * as schema from '../_db/schema';
import { newId } from './ids';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DeletionContext.db is opaque (unknown); same generic-args pattern every plugin's own Db type uses.
type Db = BaseSQLiteDatabase<'async', any, any>;

const PLUGIN_ID = 'fs.sovereign.travellog';
const EXPORT_SCHEMA_VERSION = 1;

/**
 * Registers Travellog's export/import/delete participation. Must be called
 * from a request-scoped route (this repo calls it from `app/layout.tsx`,
 * same as `sovereign-plugin-docs` and `warden`) — registrations are
 * in-process and reset on restart.
 */
export async function registerPortabilityHandlers(): Promise<void> {
  await sdk.portability.provideExport(exportTravellogData);
  await sdk.portability.provideImport(importTravellogData);
  await sdk.portability.provideDelete(deleteAllTravellogData);
}

// ---- Export shape ----

interface ExportPlace {
  id: string;
  name: string;
  category: string | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  countryCode: string | null;
  postalCode: string | null;
  source: string;
  sourceRef: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ExportVisit {
  id: string;
  placeId: string;
  happenedAt: number;
  tzIana: string;
  tzOffsetMinutes: number;
  note: string | null;
  companions: string[];
  tripId: string | null;
  linkSource: 'auto' | 'manual' | null;
  source: string;
  externalRef: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ExportVisitPhoto {
  id: string;
  visitId: string;
  /** Relative path into this section's `blobs` — null when `includeFiles` was false, or the bytes couldn't be read back (see `warnings`). */
  blobPath: string | null;
  contentType: string | null;
  position: number;
  source: string;
  createdAt: number;
}

interface ExportTrip {
  id: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  timezone: string | null;
  /** Informational-only tag list — not real shared access; see `schema.ts`'s header comment. */
  companions: string[];
  createdAt: number;
  updatedAt: number;
}

interface ExportStop {
  id: string;
  tripId: string;
  placeId: string;
  arriveDate: string;
  departDate: string;
  position: number;
  createdAt: number;
  updatedAt: number;
}

interface ExportTripDay {
  id: string;
  stopId: string;
  tripId: string;
  date: string;
  title: string | null;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ExportItineraryItem {
  id: string;
  tripDayId: string;
  tripId: string;
  placeId: string | null;
  title: string | null;
  plannedTime: string | null;
  isFixed: boolean;
  position: number;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ExportAttachment {
  id: string;
  tripId: string | null;
  tripDayId: string | null;
  kind: string;
  title: string;
  blobPath: string | null;
  contentType: string | null;
  createdAt: number;
}

interface TravellogExportData {
  places: ExportPlace[];
  visits: ExportVisit[];
  visitPhotos: ExportVisitPhoto[];
  trips: ExportTrip[];
  stops: ExportStop[];
  tripDays: ExportTripDay[];
  itineraryItems: ExportItineraryItem[];
  attachments: ExportAttachment[];
}

function parseCompanions(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

async function fetchBlobBytes(
  storageKey: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const object = await sdk.storage.get(storageKey);
  if (!object) return null;
  const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
  return { bytes, contentType: object.contentType };
}

async function exportTravellogData(ctx: ExportContext): Promise<PluginExportSection> {
  const db = (await sdk.db.getClient()) as TravellogDb;
  const { userId, tenantId } = ctx;
  const warnings: string[] = [];

  const [rawVisitRows, tripRows] = await Promise.all([
    db
      .select()
      .from(schema.visits)
      .where(and(eq(schema.visits.tenantId, tenantId), eq(schema.visits.userId, userId))),
    db
      .select()
      .from(schema.trips)
      .where(and(eq(schema.trips.tenantId, tenantId), eq(schema.trips.ownerId, userId))),
  ]);
  // Exports are the user's own data, in plaintext — never envelopes
  // (docs/plugin-development.md's field-encryption checklist, step 6).
  const visitRows = (await sdk.crypto.open(
    schema.visits,
    rawVisitRows as Record<string, unknown>[],
  )) as unknown as typeof rawVisitRows;

  const tripIds = tripRows.map((t) => t.id);
  const [stopRows, tripDayRows, itineraryItemRows, attachmentRows] = await Promise.all([
    tripIds.length > 0
      ? db.select().from(schema.stops).where(inArray(schema.stops.tripId, tripIds))
      : Promise.resolve([]),
    tripIds.length > 0
      ? db.select().from(schema.tripDays).where(inArray(schema.tripDays.tripId, tripIds))
      : Promise.resolve([]),
    tripIds.length > 0
      ? db
          .select()
          .from(schema.itineraryItems)
          .where(inArray(schema.itineraryItems.tripId, tripIds))
      : Promise.resolve([]),
    tripIds.length > 0
      ? db.select().from(schema.attachments).where(inArray(schema.attachments.tripId, tripIds))
      : Promise.resolve([]),
  ]);

  const visitIds = visitRows.map((v) => v.id);
  const photoRows =
    visitIds.length > 0
      ? await db
          .select()
          .from(schema.visitPhotos)
          .where(inArray(schema.visitPhotos.visitId, visitIds))
      : [];

  // Every place referenced by this user's own data — never the tenant's
  // whole place pool, which is shared across users.
  const placeIds = new Set<string>();
  for (const v of visitRows) placeIds.add(v.placeId);
  for (const s of stopRows) placeIds.add(s.placeId);
  for (const i of itineraryItemRows) if (i.placeId) placeIds.add(i.placeId);
  const placeRows =
    placeIds.size > 0
      ? await db
          .select()
          .from(schema.places)
          .where(
            and(eq(schema.places.tenantId, tenantId), inArray(schema.places.id, [...placeIds])),
          )
      : [];

  const blobs: Record<string, Uint8Array> = {};

  const visitPhotos: ExportVisitPhoto[] = [];
  for (const p of photoRows) {
    let blobPath: string | null = null;
    let contentType: string | null = null;
    if (ctx.options.includeFiles) {
      const fetched = await fetchBlobBytes(p.storageKey);
      if (fetched) {
        blobPath = `visit-photos/${p.id}`;
        contentType = fetched.contentType;
        blobs[blobPath] = fetched.bytes;
      } else {
        warnings.push(`A check-in photo (${p.id}) could not be read from storage and was skipped.`);
      }
    }
    visitPhotos.push({
      id: p.id,
      visitId: p.visitId,
      blobPath,
      contentType,
      position: p.position,
      source: p.source,
      createdAt: p.createdAt,
    });
  }

  const attachments: ExportAttachment[] = [];
  for (const a of attachmentRows) {
    let blobPath: string | null = null;
    let contentType: string | null = null;
    if (ctx.options.includeFiles) {
      const fetched = await fetchBlobBytes(a.storageKey);
      if (fetched) {
        blobPath = `attachments/${a.id}`;
        contentType = fetched.contentType;
        blobs[blobPath] = fetched.bytes;
      } else {
        warnings.push(`An attachment ("${a.title}") could not be read from storage and was skipped.`);
      }
    }
    attachments.push({
      id: a.id,
      tripId: a.tripId,
      tripDayId: a.tripDayId,
      kind: a.kind,
      title: a.title,
      blobPath,
      contentType,
      createdAt: a.createdAt,
    });
  }

  const data: TravellogExportData = {
    places: placeRows.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      lat: p.lat,
      lng: p.lng,
      address: p.address,
      city: p.city,
      state: p.state,
      country: p.country,
      countryCode: p.countryCode,
      postalCode: p.postalCode,
      source: p.source,
      sourceRef: p.sourceRef,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
    visits: visitRows.map((v) => ({
      id: v.id,
      placeId: v.placeId,
      happenedAt: v.happenedAt,
      tzIana: v.tzIana,
      tzOffsetMinutes: v.tzOffsetMinutes,
      note: v.note,
      companions: parseCompanions(v.companions),
      tripId: v.tripId,
      linkSource: v.linkSource as 'auto' | 'manual' | null,
      source: v.source,
      externalRef: v.externalRef,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    })),
    visitPhotos,
    trips: tripRows.map((t) => ({
      id: t.id,
      name: t.name,
      startDate: t.startDate,
      endDate: t.endDate,
      timezone: t.timezone,
      companions: parseCompanions(t.companions),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
    stops: stopRows.map((s) => ({
      id: s.id,
      tripId: s.tripId,
      placeId: s.placeId,
      arriveDate: s.arriveDate,
      departDate: s.departDate,
      position: s.position,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    })),
    tripDays: tripDayRows.map((d) => ({
      id: d.id,
      stopId: d.stopId,
      tripId: d.tripId,
      date: d.date,
      title: d.title,
      notes: d.notes,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    })),
    itineraryItems: itineraryItemRows.map((i) => ({
      id: i.id,
      tripDayId: i.tripDayId,
      tripId: i.tripId,
      placeId: i.placeId,
      title: i.title,
      plannedTime: i.plannedTime,
      isFixed: i.isFixed === 1,
      position: i.position,
      notes: i.notes,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    })),
    attachments,
  };

  return {
    pluginId: PLUGIN_ID,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    data,
    blobs: ctx.options.includeFiles ? blobs : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

// ---- Import ----
// Additive only, mirroring `sovereign-plugin-docs`' own import: every row is
// a fresh insert with a remapped id, scoped to the importing user/tenant —
// never a merge/dedup against existing data (matches this task's own review
// checklist: "export → delete all local data → import round-trips") — with
// one deliberate exception: a visit whose `(tenantId, source, externalRef)`
// already exists in the target account is skipped rather than inserted.
// `travellog_visits_tenant_source_external_ref_unique` (`schema.ts`) enforces
// this at the DB layer regardless — found live testing this task's own
// review checklist against a re-import onto the *same*, not-yet-emptied
// account (the checklist's literal flow deletes first, which sidesteps this
// entirely, but nothing about the SDK contract guarantees an import target
// is empty, and a hard 500 on a legitimate re-import is a real footgun): a
// Swarm-imported visit's `externalRef` collided with the copy already in the
// account, and the raw unique-constraint violation aborted the *entire*
// `/api/account/import` request, not just this one row — `restore.ts`
// doesn't isolate one plugin's import failure the way `assemble.ts` isolates
// export failures. Skipping (mirroring `isVisitAlreadyImported`'s existing
// pre-check, generalized past its hardcoded `'import:swarm'` source) also
// skips that visit's photos, whose `visitId` FK would otherwise point at a
// row that was never inserted.
// `reminder_sent_at` is deliberately never set on import — a fresh account
// shouldn't inherit "already reminded" state from a different instance/user.
// The whole import runs in one transaction — either every row lands or none
// does, matching `createVisit`'s own transactional convention for multi-row
// writes elsewhere in this plugin.

function isTravellogExportData(value: unknown): value is TravellogExportData {
  if (!value || typeof value !== 'object') return false;
  const c = value as Partial<TravellogExportData>;
  return (
    Array.isArray(c.places) &&
    Array.isArray(c.visits) &&
    Array.isArray(c.trips) &&
    Array.isArray(c.stops)
  );
}

async function importTravellogData(
  section: PluginExportSection,
  ctx: ImportContext,
): Promise<void> {
  if (section.schemaVersion !== EXPORT_SCHEMA_VERSION || !isTravellogExportData(section.data)) {
    throw new Error('Travellog import section has an unrecognized shape.');
  }
  const data = section.data;
  const db = (await sdk.db.getClient()) as TravellogDb;

  await db.transaction(async (tx) => {
    // Places first — every other table below references one.
    for (const p of data.places) {
      await tx.insert(schema.places).values({
        id: ctx.remapId(p.id),
        tenantId: ctx.tenantId,
        name: p.name,
        category: p.category,
        lat: p.lat,
        lng: p.lng,
        address: p.address,
        city: p.city,
        state: p.state,
        country: p.country,
        countryCode: p.countryCode,
        postalCode: p.postalCode,
        source: p.source,
        sourceRef: p.sourceRef,
        createdBy: ctx.userId,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      });
    }

    // Trips before anything that references one.
    for (const t of data.trips) {
      await tx.insert(schema.trips).values({
        id: ctx.remapId(t.id),
        tenantId: ctx.tenantId,
        ownerId: ctx.userId,
        name: t.name,
        startDate: t.startDate,
        endDate: t.endDate,
        timezone: t.timezone,
        companions: t.companions.length > 0 ? JSON.stringify(t.companions) : null,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      });
    }

    for (const s of data.stops) {
      await tx.insert(schema.stops).values({
        id: ctx.remapId(s.id),
        tripId: ctx.remapId(s.tripId),
        placeId: ctx.remapId(s.placeId),
        arriveDate: s.arriveDate,
        departDate: s.departDate,
        position: s.position,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      });
    }

    for (const d of data.tripDays) {
      await tx.insert(schema.tripDays).values({
        id: ctx.remapId(d.id),
        stopId: ctx.remapId(d.stopId),
        tripId: ctx.remapId(d.tripId),
        date: d.date,
        title: d.title,
        notes: d.notes,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      });
    }

    for (const i of data.itineraryItems) {
      await tx.insert(schema.itineraryItems).values({
        id: ctx.remapId(i.id),
        tripDayId: ctx.remapId(i.tripDayId),
        tripId: ctx.remapId(i.tripId),
        placeId: i.placeId ? ctx.remapId(i.placeId) : null,
        title: i.title,
        plannedTime: i.plannedTime,
        isFixed: i.isFixed ? 1 : 0,
        position: i.position,
        notes: i.notes,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
      });
    }

    // A visit whose (source, externalRef) already exists in this tenant
    // would otherwise hit `travellog_visits_tenant_source_external_ref_unique`
    // head-on (see this section's header comment) — skip it, and track its
    // original id so its photos are skipped too, rather than inserting a
    // photo row whose visitId FK points at a row that was never created.
    const existingExternalRefs = new Set(
      (
        await tx
          .select({ source: schema.visits.source, externalRef: schema.visits.externalRef })
          .from(schema.visits)
          .where(
            and(eq(schema.visits.tenantId, ctx.tenantId), isNotNull(schema.visits.externalRef)),
          )
      ).map((row) => `${row.source}::${row.externalRef ?? ''}`),
    );
    const skippedVisitIds = new Set<string>();

    for (const v of data.visits) {
      if (v.externalRef && existingExternalRefs.has(`${v.source}::${v.externalRef}`)) {
        skippedVisitIds.add(v.id);
        continue;
      }
      // data.visits[].note is plaintext (the export resolver open()s it —
      // see above) — seal() before this insert, same as every other write
      // path to this column.
      const sealed = await sdk.crypto.seal(schema.visits, {
        id: ctx.remapId(v.id),
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        placeId: ctx.remapId(v.placeId),
        happenedAt: v.happenedAt,
        tzIana: v.tzIana,
        tzOffsetMinutes: v.tzOffsetMinutes,
        note: v.note,
        companions: v.companions.length > 0 ? JSON.stringify(v.companions) : null,
        tripId: v.tripId ? ctx.remapId(v.tripId) : null,
        // Carried through as-is, not re-derived from tripId: `linkSource` can
        // legitimately be `'manual'` with `tripId: null` (an explicit "no
        // trip for this check-in" override — schema.ts's own invariant on
        // this column). Resetting it here would silently undo that override.
        linkSource: v.linkSource,
        source: v.source,
        externalRef: v.externalRef,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      });
      await tx.insert(schema.visits).values(sealed);
    }

    for (const p of data.visitPhotos) {
      if (skippedVisitIds.has(p.visitId)) continue;
      const bytes = p.blobPath ? section.blobs?.[p.blobPath] : undefined;
      if (!bytes) continue; // includeFiles was false, or the original read failed at export time — already warned about there.
      const object = await sdk.storage.put({
        key: `visits/${ctx.userId}/${newId()}`,
        body: bytes,
        contentType: p.contentType ?? 'application/octet-stream',
        ownerUserId: ctx.userId,
      });
      await tx.insert(schema.visitPhotos).values({
        id: ctx.remapId(p.id),
        visitId: ctx.remapId(p.visitId),
        storageKey: object.key,
        position: p.position,
        source: p.source,
        createdAt: p.createdAt,
      });
    }

    for (const a of data.attachments) {
      const bytes = a.blobPath ? section.blobs?.[a.blobPath] : undefined;
      if (!bytes) continue;
      const object = await sdk.storage.put({
        key: `attachments/${ctx.userId}/${newId()}`,
        body: bytes,
        contentType: a.contentType ?? 'application/octet-stream',
        ownerUserId: ctx.userId,
      });
      await tx.insert(schema.attachments).values({
        id: ctx.remapId(a.id),
        tripId: a.tripId ? ctx.remapId(a.tripId) : null,
        tripDayId: a.tripDayId ? ctx.remapId(a.tripDayId) : null,
        kind: a.kind,
        title: a.title,
        storageKey: object.key,
        createdBy: ctx.userId,
        createdAt: a.createdAt,
      });
    }
  });
}

// ---- Delete ----
// A straight per-user sweep — no successor-transfer logic, unlike
// `sovereign-plugin-docs`' own deletion handler: every row here has exactly
// one owner (this file's own header comment). `sdk.storage` cleanup is
// deliberately **not** done here — every photo/attachment was uploaded with
// `ownerUserId` set, so the platform's own account-deletion storage sweep
// (`runtime/src/user-deletion.ts`'s Phase 4, RFC 0044) already removes them
// generically, the same reasoning `warden`'s own deletion handler documents
// for why it doesn't touch `sdk.connections`/`sdk.secrets` either.

async function deleteAllTravellogData(ctx: DeletionContext): Promise<DeletionResult> {
  const db = ctx.db as Db;
  let deleted = 0;

  const tripRows = await db
    .select({ id: schema.trips.id })
    .from(schema.trips)
    .where(and(eq(schema.trips.tenantId, ctx.tenantId), eq(schema.trips.ownerId, ctx.userId)));
  const tripIds = tripRows.map((t) => t.id);

  if (tripIds.length > 0) {
    const itemCount = await db
      .select({ id: schema.itineraryItems.id })
      .from(schema.itineraryItems)
      .where(inArray(schema.itineraryItems.tripId, tripIds));
    await db.delete(schema.itineraryItems).where(inArray(schema.itineraryItems.tripId, tripIds));
    deleted += itemCount.length;

    const attachmentCount = await db
      .select({ id: schema.attachments.id })
      .from(schema.attachments)
      .where(inArray(schema.attachments.tripId, tripIds));
    await db.delete(schema.attachments).where(inArray(schema.attachments.tripId, tripIds));
    deleted += attachmentCount.length;

    const dayCount = await db
      .select({ id: schema.tripDays.id })
      .from(schema.tripDays)
      .where(inArray(schema.tripDays.tripId, tripIds));
    await db.delete(schema.tripDays).where(inArray(schema.tripDays.tripId, tripIds));
    deleted += dayCount.length;

    const stopCount = await db
      .select({ id: schema.stops.id })
      .from(schema.stops)
      .where(inArray(schema.stops.tripId, tripIds));
    await db.delete(schema.stops).where(inArray(schema.stops.tripId, tripIds));
    deleted += stopCount.length;
  }

  // Visits are scoped by userId, not by trip — deleting the trips above
  // didn't remove any (schema.ts: visits.tripId is `onDelete: 'set null'`,
  // not cascade), so every visit this user owns is deleted explicitly here
  // regardless of whether it was ever linked to one of their trips.
  const visitRows = await db
    .select({ id: schema.visits.id })
    .from(schema.visits)
    .where(and(eq(schema.visits.tenantId, ctx.tenantId), eq(schema.visits.userId, ctx.userId)));
  const visitIds = visitRows.map((v) => v.id);
  if (visitIds.length > 0) {
    const photoCount = await db
      .select({ id: schema.visitPhotos.id })
      .from(schema.visitPhotos)
      .where(inArray(schema.visitPhotos.visitId, visitIds));
    await db.delete(schema.visitPhotos).where(inArray(schema.visitPhotos.visitId, visitIds));
    deleted += photoCount.length;
  }
  await db
    .delete(schema.visits)
    .where(and(eq(schema.visits.tenantId, ctx.tenantId), eq(schema.visits.userId, ctx.userId)));
  deleted += visitRows.length;

  if (tripIds.length > 0) {
    await db.delete(schema.trips).where(inArray(schema.trips.id, tripIds));
    deleted += tripIds.length;
  }

  // Places this user created and are no longer referenced by anyone else's
  // visit/stop/itinerary item are left in place — places are shared
  // entities (SPEC.md's Data model notes), so a place another user's own
  // history still points at must survive this user's deletion. Phase 1 has
  // no reference-counting cleanup for now-orphaned places; an operator can
  // remove them manually if it ever matters at scale.

  return { deleted };
}
