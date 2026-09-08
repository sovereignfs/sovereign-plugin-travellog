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
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type { TravellogDb } from '../_db/client';
import * as schema from '../_db/schema';
import { newId } from './ids';
import { deleteImportJobsForUser } from './import-jobs';

/**
 * Bind-parameter budget for one `IN (...)` list. SQLite's default
 * `SQLITE_MAX_VARIABLE_NUMBER` is 32766 and Postgres caps a statement at
 * 65535 parameters; a decade of Swarm imports is tens of thousands of
 * visits, so an unchunked `inArray` over every visit id threw
 * "too many SQL variables" at exactly the scale this plugin advertises.
 */
const IN_CHUNK = 500;

function chunk<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_CHUNK) out.push(items.slice(i, i + IN_CHUNK));
  return out;
}

async function selectInChunks<T>(
  ids: string[],
  query: (ids: string[]) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunk(ids)) out.push(...(await query(part)));
  return out;
}

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
  const [stopRows, tripDayRows, itineraryItemRows] = await Promise.all([
    selectInChunks(tripIds, (ids) =>
      db.select().from(schema.stops).where(inArray(schema.stops.tripId, ids)),
    ),
    selectInChunks(tripIds, (ids) =>
      db.select().from(schema.tripDays).where(inArray(schema.tripDays.tripId, ids)),
    ),
    selectInChunks(tripIds, (ids) =>
      db.select().from(schema.itineraryItems).where(inArray(schema.itineraryItems.tripId, ids)),
    ),
  ]);
  // Both attachment scopes: trip-level (`trip_id` set) *and* day-level
  // (`trip_day_id` set, `trip_id` null by the XOR rule in `attachments.ts`).
  // A `WHERE trip_id IN (...)` alone silently dropped every day-level
  // attachment from the export — lost on the documented
  // export → delete → import round trip.
  const tripDayIds = tripDayRows.map((d) => d.id);
  const attachmentRows = [
    ...(await selectInChunks(tripIds, (ids) =>
      db.select().from(schema.attachments).where(inArray(schema.attachments.tripId, ids)),
    )),
    ...(await selectInChunks(tripDayIds, (ids) =>
      db.select().from(schema.attachments).where(inArray(schema.attachments.tripDayId, ids)),
    )),
  ];

  const visitIds = visitRows.map((v) => v.id);
  const photoRows = await selectInChunks(visitIds, (ids) =>
    db.select().from(schema.visitPhotos).where(inArray(schema.visitPhotos.visitId, ids)),
  );

  // Every place referenced by this user's own data — never the tenant's
  // whole place pool, which is shared across users.
  const placeIds = new Set<string>();
  for (const v of visitRows) placeIds.add(v.placeId);
  for (const s of stopRows) placeIds.add(s.placeId);
  for (const i of itineraryItemRows) if (i.placeId) placeIds.add(i.placeId);
  const placeRows = await selectInChunks([...placeIds], (ids) =>
    db
      .select()
      .from(schema.places)
      .where(and(eq(schema.places.tenantId, tenantId), inArray(schema.places.id, ids))),
  );

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
        warnings.push(
          `An attachment ("${a.title}") could not be read from storage and was skipped.`,
        );
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
    Array.isArray(c.visitPhotos) &&
    Array.isArray(c.trips) &&
    Array.isArray(c.stops) &&
    Array.isArray(c.tripDays) &&
    Array.isArray(c.itineraryItems) &&
    Array.isArray(c.attachments)
  );
}

/**
 * Uploads every blob the import will reference *before* the transaction
 * opens, so a rolled-back import leaves no orphaned storage objects; on a
 * failed transaction the caller removes exactly these. `null` entries are
 * blobs that weren't in the bundle (`includeFiles` was false, or the read
 * failed at export time — already warned about there).
 */
async function stageBlobs(
  section: PluginExportSection,
  ctx: ImportContext,
  entries: Array<{
    blobPath: string | null;
    contentType: string | null;
    area: 'visits' | 'attachments';
  }>,
): Promise<(string | null)[]> {
  const keys: (string | null)[] = [];
  for (const entry of entries) {
    const bytes = entry.blobPath ? section.blobs?.[entry.blobPath] : undefined;
    if (!bytes) {
      keys.push(null);
      continue;
    }
    const object = await sdk.storage.put({
      key: `${entry.area}/${ctx.userId}/${newId()}`,
      body: bytes,
      contentType: entry.contentType ?? 'application/octet-stream',
      ownerUserId: ctx.userId,
    });
    keys.push(object.key);
  }
  return keys;
}

async function deleteStorageKeys(keys: Iterable<string>): Promise<void> {
  for (const key of keys) {
    try {
      await sdk.storage.delete(key);
    } catch (err) {
      console.error(`[travellog] Could not remove storage object "${key}":`, err);
    }
  }
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

  const photoKeys = await stageBlobs(
    section,
    ctx,
    data.visitPhotos.map((p) => ({
      blobPath: p.blobPath,
      contentType: p.contentType,
      area: 'visits',
    })),
  );
  const attachmentKeys = await stageBlobs(
    section,
    ctx,
    data.attachments.map((a) => ({
      blobPath: a.blobPath,
      contentType: a.contentType,
      area: 'attachments',
    })),
  );

  try {
    await importRows(db, data, ctx, photoKeys, attachmentKeys);
  } catch (err) {
    await deleteStorageKeys(
      [...photoKeys, ...attachmentKeys].filter((k): k is string => k !== null),
    );
    throw err;
  }
}

async function importRows(
  db: TravellogDb,
  data: TravellogExportData,
  ctx: ImportContext,
  photoKeys: (string | null)[],
  attachmentKeys: (string | null)[],
): Promise<void> {
  await db.transaction(async (tx) => {
    // Places first — every other table below references one. An imported
    // place that already exists in this tenant by provenance
    // (`(source, sourceRef)`, i.e. the same Foursquare venue from an
    // earlier Swarm import) is reused rather than duplicated — a re-import
    // onto a non-empty account used to mint a fresh copy of every place on
    // each attempt while correctly skipping the visits that pointed at
    // them.
    const existingByProvenance = new Map(
      (
        await tx
          .select({
            id: schema.places.id,
            source: schema.places.source,
            sourceRef: schema.places.sourceRef,
          })
          .from(schema.places)
          .where(and(eq(schema.places.tenantId, ctx.tenantId), isNotNull(schema.places.sourceRef)))
      ).map((row) => [`${row.source}::${row.sourceRef ?? ''}`, row.id]),
    );
    const placeAliases = new Map<string, string>();
    const placeIdFor = (originalId: string): string =>
      placeAliases.get(originalId) ?? ctx.remapId(originalId);

    for (const p of data.places) {
      const existingId = p.sourceRef
        ? existingByProvenance.get(`${p.source}::${p.sourceRef}`)
        : undefined;
      if (existingId) {
        placeAliases.set(p.id, existingId);
        continue;
      }
      await tx.insert(schema.places).values({
        id: placeIdFor(p.id),
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
        tenantId: ctx.tenantId,
        tripId: ctx.remapId(s.tripId),
        placeId: placeIdFor(s.placeId),
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
        tenantId: ctx.tenantId,
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
        tenantId: ctx.tenantId,
        tripDayId: ctx.remapId(i.tripDayId),
        tripId: ctx.remapId(i.tripId),
        placeId: i.placeId ? placeIdFor(i.placeId) : null,
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
        placeId: placeIdFor(v.placeId),
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

    for (const [index, p] of data.visitPhotos.entries()) {
      const storageKey = photoKeys[index];
      if (skippedVisitIds.has(p.visitId) || !storageKey) continue;
      await tx.insert(schema.visitPhotos).values({
        id: ctx.remapId(p.id),
        tenantId: ctx.tenantId,
        visitId: ctx.remapId(p.visitId),
        storageKey,
        position: p.position,
        source: p.source,
        createdAt: p.createdAt,
      });
    }

    for (const [index, a] of data.attachments.entries()) {
      const storageKey = attachmentKeys[index];
      if (!storageKey) continue;
      await tx.insert(schema.attachments).values({
        id: ctx.remapId(a.id),
        tenantId: ctx.tenantId,
        tripId: a.tripId ? ctx.remapId(a.tripId) : null,
        tripDayId: a.tripDayId ? ctx.remapId(a.tripDayId) : null,
        kind: a.kind,
        title: a.title,
        storageKey,
        createdBy: ctx.userId,
        createdAt: a.createdAt,
      });
    }
  });
}

// ---- Delete ----
// A straight per-user sweep — no successor-transfer logic, unlike
// `sovereign-plugin-docs`' own deletion handler: every row here has exactly
// one owner (this file's own header comment). One transaction: the runtime
// races this handler against a timeout and never cancels it, so a throw
// halfway through an unwrapped sweep used to leave a half-deleted account.
// Storage: photos and attachments were uploaded with `ownerUserId`, so the
// platform's own account-deletion sweep (`user-deletion.ts` Phase 4, RFC
// 0044) removes them too — they're still deleted explicitly here, best-
// effort, so nothing depends on that ordering. Import ZIPs are *unowned*
// (`checkins/import/upload/route.ts`) and only this handler ever removes
// them. Places are shared, tenant-wide rows other users' history may still
// point at, so they survive — only their `created_by` attribution to the
// departing user is severed (`NULL`, counted as `anonymized`; RFC 0097 —
// never a "deleted user" sentinel id).

async function deleteAllTravellogData(ctx: DeletionContext): Promise<DeletionResult> {
  const db = ctx.db as Db;
  const storageKeys: string[] = [];

  const { deleted, anonymized } = await db.transaction(async (tx) => {
    let deleted = 0;

    const tripIds = (
      await tx
        .select({ id: schema.trips.id })
        .from(schema.trips)
        .where(and(eq(schema.trips.tenantId, ctx.tenantId), eq(schema.trips.ownerId, ctx.userId)))
    ).map((t) => t.id);

    for (const ids of chunk(tripIds)) {
      const dayIds = (
        await tx
          .select({ id: schema.tripDays.id })
          .from(schema.tripDays)
          .where(inArray(schema.tripDays.tripId, ids))
      ).map((d) => d.id);

      const attachmentRows = await tx
        .select({ id: schema.attachments.id, storageKey: schema.attachments.storageKey })
        .from(schema.attachments)
        .where(
          dayIds.length > 0
            ? or(
                inArray(schema.attachments.tripId, ids),
                inArray(schema.attachments.tripDayId, dayIds),
              )
            : inArray(schema.attachments.tripId, ids),
        );
      for (const a of attachmentRows) storageKeys.push(a.storageKey);
      for (const attachmentIds of chunk(attachmentRows.map((a) => a.id))) {
        await tx.delete(schema.attachments).where(inArray(schema.attachments.id, attachmentIds));
      }
      deleted += attachmentRows.length;

      const itemRows = await tx
        .select({ id: schema.itineraryItems.id })
        .from(schema.itineraryItems)
        .where(inArray(schema.itineraryItems.tripId, ids));
      await tx.delete(schema.itineraryItems).where(inArray(schema.itineraryItems.tripId, ids));
      deleted += itemRows.length;

      await tx.delete(schema.tripDays).where(inArray(schema.tripDays.tripId, ids));
      deleted += dayIds.length;

      const stopRows = await tx
        .select({ id: schema.stops.id })
        .from(schema.stops)
        .where(inArray(schema.stops.tripId, ids));
      await tx.delete(schema.stops).where(inArray(schema.stops.tripId, ids));
      deleted += stopRows.length;
    }

    // Visits are scoped by userId, not by trip — deleting the trips above
    // didn't remove any (schema.ts: visits.tripId is `onDelete: 'set null'`,
    // not cascade), so every visit this user owns is deleted explicitly here
    // regardless of whether it was ever linked to one of their trips.
    const visitIds = (
      await tx
        .select({ id: schema.visits.id })
        .from(schema.visits)
        .where(and(eq(schema.visits.tenantId, ctx.tenantId), eq(schema.visits.userId, ctx.userId)))
    ).map((v) => v.id);
    for (const ids of chunk(visitIds)) {
      const photoRows = await tx
        .select({ storageKey: schema.visitPhotos.storageKey })
        .from(schema.visitPhotos)
        .where(inArray(schema.visitPhotos.visitId, ids));
      for (const p of photoRows) storageKeys.push(p.storageKey);
      await tx.delete(schema.visitPhotos).where(inArray(schema.visitPhotos.visitId, ids));
      deleted += photoRows.length;
      await tx.delete(schema.visits).where(inArray(schema.visits.id, ids));
    }
    deleted += visitIds.length;

    for (const ids of chunk(tripIds)) {
      await tx.delete(schema.trips).where(inArray(schema.trips.id, ids));
    }
    deleted += tripIds.length;

    const importJobs = await deleteImportJobsForUser(tx as unknown as TravellogDb, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
    });
    deleted += importJobs.deleted;
    storageKeys.push(...importJobs.storageKeys);

    const attributedPlaces = await tx
      .select({ id: schema.places.id })
      .from(schema.places)
      .where(
        and(eq(schema.places.tenantId, ctx.tenantId), eq(schema.places.createdBy, ctx.userId)),
      );
    await tx
      .update(schema.places)
      .set({ createdBy: null, updatedAt: Date.now() })
      .where(
        and(eq(schema.places.tenantId, ctx.tenantId), eq(schema.places.createdBy, ctx.userId)),
      );

    return { deleted, anonymized: attributedPlaces.length };
  });

  await deleteStorageKeys(new Set(storageKeys));

  return { deleted, anonymized };
}
