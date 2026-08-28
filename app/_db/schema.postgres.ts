/**
 * Sovereign Travellog — Postgres migration-twin schema.
 *
 * Exists ONLY to drive `drizzle-kit generate --dialect postgresql`;
 * application code never imports it — queries always go through
 * `./schema.ts` (sqlite-core), whose column serialization this file must
 * match as closely as possible: plain `integer` for `tzOffsetMinutes`
 * (small values, no overflow risk), `doublePrecision` for REAL
 * lat/lng/position. Keep every table/column/index structurally identical
 * to ./schema.ts, EXCEPT timestamps (see below).
 *
 * Timestamps are the one deliberate divergence: `./schema.ts` stores them as
 * plain `integer` because SQLite's `integer` affinity has no real width
 * limit (values are stored as 64-bit regardless of the declared type), but
 * Postgres's `integer` is a real, fixed 32-bit type (max 2147483647). A Unix
 * millisecond timestamp is a 13-digit number, already ~800x past that limit
 * today. Every timestamp column here (`createdAt`, `updatedAt`, `happenedAt`)
 * uses `bigint({ mode: 'number' })` instead — safe up to 2^53, far beyond
 * any real timestamp.
 *
 * After regenerating Postgres migrations, strip any
 * `REFERENCES "public"."..."` schema qualifier down to an unqualified
 * `REFERENCES "..."` — plugin tables live in `plugin_<slug>` reached via
 * search_path, and the qualified form fails at migration time. See
 * docs/plugin-database.md "Foreign keys in a Postgres schema".
 */
import { bigint, doublePrecision, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';

export const places = pgTable(
  'travellog_places',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    category: text('category'),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    address: text('address'),
    city: text('city'),
    state: text('state'),
    country: text('country'),
    countryCode: text('country_code'),
    postalCode: text('postal_code'),
    source: text('source').notNull(),
    sourceRef: text('source_ref'),
    createdBy: text('created_by').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('travellog_places_tenant_name_idx').on(t.tenantId, t.name)],
);

export const visits = pgTable(
  'travellog_visits',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    userId: text('user_id').notNull(),
    placeId: text('place_id')
      .notNull()
      .references(() => places.id, { onDelete: 'restrict' }),
    happenedAt: bigint('happened_at', { mode: 'number' }).notNull(),
    tzIana: text('tz_iana').notNull(),
    tzOffsetMinutes: integer('tz_offset_minutes').notNull(),
    note: text('note'),
    companions: text('companions'),
    tripId: text('trip_id').references(() => trips.id, { onDelete: 'set null' }),
    linkSource: text('link_source'),
    source: text('source').notNull(),
    externalRef: text('external_ref'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
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

export const visitPhotos = pgTable(
  'travellog_visit_photos',
  {
    id: text('id').primaryKey(),
    visitId: text('visit_id')
      .notNull()
      .references(() => visits.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    position: doublePrecision('position').notNull(),
    source: text('source').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('travellog_visit_photos_visit_position_idx').on(t.visitId, t.position)],
);

export const trips = pgTable(
  'travellog_trips',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    ownerId: text('owner_id').notNull(),
    name: text('name').notNull(),
    startDate: text('start_date'),
    endDate: text('end_date'),
    timezone: text('timezone'),
    companions: text('companions'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('travellog_trips_owner_start_idx').on(t.ownerId, t.startDate)],
);

export const stops = pgTable(
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
    position: doublePrecision('position').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('travellog_stops_trip_position_idx').on(t.tripId, t.position)],
);

export const tripDays = pgTable(
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
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [unique('travellog_trip_days_stop_date_unique').on(t.stopId, t.date)],
);

export const itineraryItems = pgTable(
  'travellog_itinerary_items',
  {
    id: text('id').primaryKey(),
    tripDayId: text('trip_day_id')
      .notNull()
      .references(() => tripDays.id, { onDelete: 'restrict' }),
    tripId: text('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'restrict' }),
    placeId: text('place_id').references(() => places.id, { onDelete: 'restrict' }),
    title: text('title'),
    plannedTime: text('planned_time'),
    isFixed: integer('is_fixed').notNull().default(0),
    position: doublePrecision('position').notNull(),
    notes: text('notes'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('travellog_itinerary_items_day_position_idx').on(t.tripDayId, t.position)],
);

export const attachments = pgTable(
  'travellog_attachments',
  {
    id: text('id').primaryKey(),
    tripId: text('trip_id').references(() => trips.id, { onDelete: 'cascade' }),
    tripDayId: text('trip_day_id').references(() => tripDays.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    storageKey: text('storage_key').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('travellog_attachments_trip_idx').on(t.tripId),
    index('travellog_attachments_trip_day_idx').on(t.tripDayId),
  ],
);

export const importJobs = pgTable(
  'travellog_import_jobs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    userId: text('user_id').notNull(),
    status: text('status').notNull(),
    storageKey: text('storage_key').notNull(),
    platformJobId: text('platform_job_id'),
    totalCheckins: integer('total_checkins'),
    processedCheckins: integer('processed_checkins').notNull(),
    totalPhotos: integer('total_photos'),
    processedPhotos: integer('processed_photos').notNull(),
    failedPhotos: integer('failed_photos').notNull(),
    cursor: integer('cursor').notNull(),
    errorMessage: text('error_message'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    completedAt: bigint('completed_at', { mode: 'number' }),
  },
  (t) => [index('travellog_import_jobs_user_created_idx').on(t.userId, t.createdAt)],
);
