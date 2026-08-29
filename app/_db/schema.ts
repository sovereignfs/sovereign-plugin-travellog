/**
 * Sovereign Travellog — Drizzle schema (SQLite).
 *
 * Application code queries through this file on both dialects — the query
 * builder is bound to the client connection, not the table object. The
 * Postgres twin (`schema.postgres.ts`) exists only to drive
 * `drizzle-kit generate --dialect postgresql`; keep the two structurally
 * identical, and keep Postgres column types serialization-compatible with
 * these (plain integer for booleans/ids — never native boolean; see
 * schema.postgres.ts's own header for the one deliberate divergence,
 * timestamps). See docs/plugin-database.md.
 *
 * Conventions:
 * - ids are caller-generated text (nanoid).
 * - timestamps are Unix milliseconds (integer).
 * - `position` is a fractional REAL — see ./position.ts.
 * - `tenant_id` on every table (multi-tenancy readiness).
 *
 * Slice 2 (`T.10`) adds `trips`/`stops`/`tripDays`/`itineraryItems`/
 * `attachments` and activates `visits.tripId`'s FK (previously deferred —
 * see that column's own comment, below). Population (the auto-link engine)
 * is `T.12`'s job, not this file's.
 *
 * `travellog_trip_members` (SPEC.md's Data model section) was **not**
 * built: CONCEPT.md's open question 2 (real shared access vs. lightweight
 * companion tags) was still unresolved when `T.10` shipped, and the task's
 * own conditional scope says to substitute a plain field in that case —
 * `trips.companions`, below, same JSON-string[]-of-names shape as
 * `visits.companions`. Revisit if that open question resolves toward real
 * shared access; `T.14`'s spec already documents both UI branches.
 */
import { index, integer, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { encryptedText } from '@sovereignfs/sdk/drizzle';

export const places = sqliteTable(
  'travellog_places',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    category: text('category'),
    lat: real('lat'),
    lng: real('lng'),
    address: text('address'),
    city: text('city'),
    state: text('state'),
    country: text('country'),
    countryCode: text('country_code'),
    postalCode: text('postal_code'),
    /** 'manual' | 'osm' | 'google' | 'import' — enforced in the data layer, not the schema. */
    source: text('source').notNull(),
    /** External id from the provider/import source, for de-dup. Null for a plain manual entry. */
    sourceRef: text('source_ref'),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('travellog_places_tenant_name_idx').on(t.tenantId, t.name)],
);

export const visits = sqliteTable(
  'travellog_visits',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    userId: text('user_id').notNull(),
    placeId: text('place_id')
      .notNull()
      .references(() => places.id, { onDelete: 'restrict' }),
    /** Unix ms, UTC. Always paired with tzIana/tzOffsetMinutes — never read alone for "local time". */
    happenedAt: integer('happened_at').notNull(),
    tzIana: text('tz_iana').notNull(),
    tzOffsetMinutes: integer('tz_offset_minutes').notNull(),
    /**
     * `T.24` (RFC 0092) — classified `sensitive`. Not blind-indexed: nothing
     * in this plugin queries a check-in by note text (see SPEC.md's
     * "Encryption posture"). Always run through `sdk.crypto.seal()` before a
     * write and `sdk.crypto.open()` after a read — the column's own
     * `toDriver` tripwire throws on an unsealed write, but reads need the
     * explicit `open()` call to come back as plaintext.
     */
    note: encryptedText('note', { sensitivity: 'sensitive' }),
    /** JSON-encoded string[] of companion names — see SPEC.md's Data model notes. */
    companions: text('companions'),
    /**
     * Nullable — a visit never requires a trip. FK activated in `T.10`
     * (`travellog_trips` now exists); populated by `T.12`'s auto-link
     * engine, or by a manual override, not by this schema.
     *
     * `onDelete: 'set null'` only clears this column, never `linkSource` —
     * a hard-deleted trip would leave a stale `linkSource` behind on any
     * visit that pointed at it. `_lib/trips.ts`'s `deleteTrip` explicitly
     * nulls `linkSource` for affected visits in the same transaction
     * (`WHERE trip_id = ?`, before the trip delete itself) — a deliberate
     * choice specific to whole-trip deletion, not a general "keep them in
     * sync" rule; see `linkSource`'s own comment for why a *manual* unlink
     * does the opposite.
     */
    tripId: text('trip_id').references(() => trips.id, { onDelete: 'set null' }),
    /**
     * `'auto' | 'manual'`, enforced in the data layer — **not** simply
     * "null iff tripId is null" (`T.10`'s original framing, corrected in
     * `T.12`). A manual override can set `linkSource: 'manual'` with
     * `tripId: null` too — a user explicitly saying "no trip for this
     * check-in," which must survive a future `T.12` recompute exactly like
     * an explicit link does (`_lib/auto-link.ts`'s `recomputeAutoLinksForActor`
     * skips every `'manual'` row regardless of its `tripId`). The only true
     * invariant: `linkSource` is null **only** when the visit has never
     * been decided either way (never auto-matched, never manually
     * touched) — once it's `'manual'`, nothing but another manual action
     * changes it. `deleteTrip`'s own explicit null-out (see `tripId`'s
     * comment) is the one deliberate exception: deleting the whole trip an
     * override pointed at resets the visit to fully undecided, not to a
     * "manually excluded from everything" state nobody asked for.
     */
    linkSource: text('link_source'),
    /** 'manual' | 'gps' | 'import:swarm' — enforced in the data layer, not the schema. */
    source: text('source').notNull(),
    /** Import de-dup key — unique per (tenantId, source, externalRef) below. Null for manual/gps check-ins. */
    externalRef: text('external_ref'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('travellog_visits_user_happened_idx').on(t.userId, t.happenedAt),
    index('travellog_visits_place_idx').on(t.placeId),
    unique('travellog_visits_tenant_source_external_ref_unique').on(
      t.tenantId,
      t.source,
      t.externalRef,
    ),
  ],
);

export const visitPhotos = sqliteTable(
  'travellog_visit_photos',
  {
    id: text('id').primaryKey(),
    visitId: text('visit_id')
      .notNull()
      .references(() => visits.id, { onDelete: 'cascade' }),
    /** sdk.storage object key — bytes are never stored in this table. */
    storageKey: text('storage_key').notNull(),
    position: real('position').notNull(),
    /** 'upload' | 'import' — enforced in the data layer, not the schema. */
    source: text('source').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('travellog_visit_photos_visit_position_idx').on(t.visitId, t.position)],
);

/**
 * `T.10`'s trip/stop/itinerary tables (SPEC.md's Data model section).
 *
 * `startDate`/`endDate` are a denormalized cache — never independently
 * editable — recomputed server-side (`T.11`) in the same transaction as
 * any stop add/edit/remove/reorder: first stop's `arriveDate` → this
 * trip's `startDate`; last stop's `departDate` → this trip's `endDate`.
 * They, like every other date field in this task's tables (`stops.arriveDate`/
 * `departDate`, `tripDays.date`), are plain `YYYY-MM-DD` calendar-date
 * text — never a millisecond timestamp — matching the auto-link
 * algorithm's own framing (SPEC.md: compares a visit's *local calendar
 * date* against a trip's derived date range, not a raw UTC instant). A
 * trip's own status (`planning`/`upcoming`/`ongoing`/`completed`) is
 * computed, never stored (`T.11`).
 *
 * `companions` — see this file's header comment: the `travellog_trip_members`
 * real-access-sharing table was not built, since CONCEPT.md's open
 * question 2 was still unresolved when this shipped. Same shape as
 * `visits.companions` (JSON-encoded `string[]`, informational only).
 */
export const trips = sqliteTable(
  'travellog_trips',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    ownerId: text('owner_id').notNull(),
    name: text('name').notNull(),
    startDate: text('start_date'),
    endDate: text('end_date'),
    /** IANA zone, nullable — a trip's "home" zone for display; individual stops carry no zone of their own in phase 1. */
    timezone: text('timezone'),
    companions: text('companions'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('travellog_trips_owner_start_idx').on(t.ownerId, t.startDate)],
);

/**
 * A trip's ordered locations ("starting point, then other locations in
 * between") — `position` is fractional (midpoint-insertion, same pattern
 * as `sovereign-plugin-kanban`'s `_db/position.ts`), independent of
 * `arriveDate`/`departDate` so a stop can be reordered before its dates
 * are finalized.
 */
export const stops = sqliteTable(
  'travellog_stops',
  {
    id: text('id').primaryKey(),
    tripId: text('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    placeId: text('place_id')
      .notNull()
      .references(() => places.id, { onDelete: 'restrict' }),
    arriveDate: text('arrive_date').notNull(),
    departDate: text('depart_date').notNull(),
    position: real('position').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('travellog_stops_trip_position_idx').on(t.tripId, t.position)],
);

/**
 * Keyed by `stopId`, not directly by trip — `tripId` here is a
 * denormalized convenience copy (avoids joining through `stops` to filter
 * a trip's days), kept in sync by the app layer at creation time, never
 * independently edited. Editing a stop's date range auto-generates/removes
 * rows here to match (`T.11`).
 */
export const tripDays = sqliteTable(
  'travellog_trip_days',
  {
    id: text('id').primaryKey(),
    stopId: text('stop_id')
      .notNull()
      .references(() => stops.id, { onDelete: 'cascade' }),
    tripId: text('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    title: text('title'),
    notes: text('notes'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [unique('travellog_trip_days_stop_date_unique').on(t.stopId, t.date)],
);

/**
 * One day's ordered plan. `tripDayId`/`tripId` (the latter a denormalized
 * copy, same rationale as `tripDays.tripId`) are both `onDelete: 'restrict'`
 * — the one deliberate exception to "deletes cascade" in this schema.
 * Removing a day, a stop, or a whole trip that still has itinerary items
 * anywhere beneath it must be blocked and the user prompted, never silently
 * cascaded (SPEC.md's Data model notes, called out explicitly for `T.11`'s
 * tests) — restricting both FKs is what makes that true at the DB layer,
 * not just an app-layer convention: a `stops`/`trips` cascade delete that
 * would transitively remove a populated `tripDay` fails outright instead of
 * silently taking the itinerary items down with it.
 *
 * `isFixed` is only meaningful alongside a `plannedTime` — the Planner UI
 * (`T.16`) should require a time before allowing the fixed toggle; not
 * enforced at this layer.
 */
export const itineraryItems = sqliteTable(
  'travellog_itinerary_items',
  {
    id: text('id').primaryKey(),
    tripDayId: text('trip_day_id')
      .notNull()
      .references(() => tripDays.id, { onDelete: 'restrict' }),
    tripId: text('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'restrict' }),
    /** Nullable — a title-only item (no resolved place) is schema-legal. */
    placeId: text('place_id').references(() => places.id, { onDelete: 'restrict' }),
    /** Required if placeId is null — enforced in the data layer, not the schema. */
    title: text('title'),
    /** "HH:mm", nullable — no commitment ("sometime today") vs. a real planned time. */
    plannedTime: text('planned_time'),
    /** 0 | 1 — plain integer, never a native boolean (dialect portability). */
    isFixed: integer('is_fixed').notNull().default(0),
    position: real('position').notNull(),
    notes: text('notes'),
    /**
     * `T.20` — unix ms, nullable. The claim marker a reminder tick sets via
     * a conditional `UPDATE … WHERE reminder_sent_at IS NULL` before
     * sending: `schedules` handlers have no persistence of their own
     * (`docs/plugin-development.md`: "claim work with conditional updates…
     * before acting on it"), so this column *is* the idempotency guarantee
     * that a reminder fires once per item, not once per tick.
     */
    reminderSentAt: integer('reminder_sent_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('travellog_itinerary_items_day_position_idx').on(t.tripDayId, t.position)],
);

/**
 * A receipt, booking confirmation, or accommodation record — exactly one
 * of `tripId`/`tripDayId` is set, app-layer checked (unit-tested, not just
 * documented — `T.10`'s own review checklist). Bytes live in `sdk.storage`;
 * `storageKey` is the only pointer to them here.
 */
export const attachments = sqliteTable(
  'travellog_attachments',
  {
    id: text('id').primaryKey(),
    tripId: text('trip_id').references(() => trips.id, { onDelete: 'cascade' }),
    tripDayId: text('trip_day_id').references(() => tripDays.id, { onDelete: 'cascade' }),
    /** 'receipt' | 'booking' | 'accommodation' | 'other' — enforced in the data layer, not the schema. */
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    storageKey: text('storage_key').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('travellog_attachments_trip_idx').on(t.tripId),
    index('travellog_attachments_trip_day_idx').on(t.tripDayId),
  ],
);

/**
 * `T.8`'s Swarm import — one row per uploaded export, the durable unit of
 * resumable progress. Distinct from the platform's own `plugin_jobs` row
 * (`sdk.jobs.enqueue()`'s `JobRef`): that row is disposable per attempt —
 * the platform deliberately never auto-reclaims one stuck `running` after a
 * crash (`runtime/src/jobs.ts`'s own doc comment) — while `cursor` here
 * survives across attempts, so a user-triggered "Resume" (a fresh
 * `sdk.jobs.enqueue()` carrying this row's id) picks up exactly where a
 * dead attempt left off instead of re-reading the whole export.
 *
 * De-dup on re-run (or a resume racing a still-live attempt) is enforced by
 * `visits`' own `travellog_visits_tenant_source_external_ref_unique`
 * index (`T.2`), not by anything here — this row's `cursor` is a
 * performance optimization (skip already-processed entries quickly), not
 * the correctness guarantee.
 */
export const importJobs = sqliteTable(
  'travellog_import_jobs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    userId: text('user_id').notNull(),
    /** 'pending' | 'running' | 'completed' | 'failed' — enforced in the data layer, not the schema. */
    status: text('status').notNull(),
    /** sdk.storage object key of the uploaded ZIP. */
    storageKey: text('storage_key').notNull(),
    /** Most recent sdk.jobs.enqueue() JobRef.id — reassigned on each resume. */
    platformJobId: text('platform_job_id'),
    /** Null until the ZIP's checkins.json has been read once. */
    totalCheckins: integer('total_checkins'),
    processedCheckins: integer('processed_checkins').notNull(),
    totalPhotos: integer('total_photos'),
    processedPhotos: integer('processed_photos').notNull(),
    /** A photo that failed to fetch/store — logged and skipped, never aborts the job. */
    failedPhotos: integer('failed_photos').notNull(),
    /** Index into the parsed checkins array — resume starts here, not from 0. */
    cursor: integer('cursor').notNull(),
    errorMessage: text('error_message'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (t) => [index('travellog_import_jobs_user_created_idx').on(t.userId, t.createdAt)],
);
