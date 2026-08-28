/**
 * Local place creation — deliberately not part of the `PlaceProvider`
 * interface (../place-provider.ts). Every place a visit or itinerary item
 * ends up referencing must exist as a real `travellog_places` row
 * regardless of which provider found it; an external provider only ever
 * finds candidates, it doesn't own creating local rows for them.
 */
import { and, eq } from 'drizzle-orm';
import type { TravellogDb } from '../_db/client';
import * as schema from '../_db/schema';
import { newId } from './ids';

export type PlaceRow = typeof schema.places.$inferSelect;

/** 'manual' | 'osm' | 'google' | 'import' */
export type PlaceSource = 'manual' | 'osm' | 'google' | 'import';

export interface CreatePlaceInput {
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
  source: PlaceSource;
  sourceRef?: string | null;
}

export interface CreatePlaceContext {
  tenantId: string;
  userId: string;
}

/**
 * Creating a place with no coordinates is allowed and must not break
 * anything downstream (SPEC.md's T.3 review checklist) — it just doesn't
 * get a map pin once a map exists. `lat`/`lng` stay `null` rather than
 * being defaulted to 0/0, which would silently and wrongly place it in the
 * Gulf of Guinea.
 */
export async function createPlace(
  db: TravellogDb,
  ctx: CreatePlaceContext,
  input: CreatePlaceInput,
): Promise<PlaceRow> {
  const now = Date.now();
  const id = newId();

  await db.insert(schema.places).values({
    id,
    tenantId: ctx.tenantId,
    name: input.name,
    category: input.category ?? null,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    address: input.address ?? null,
    city: input.city ?? null,
    state: input.state ?? null,
    country: input.country ?? null,
    countryCode: input.countryCode ?? null,
    postalCode: input.postalCode ?? null,
    source: input.source,
    sourceRef: input.sourceRef ?? null,
    createdBy: ctx.userId,
    createdAt: now,
    updatedAt: now,
  });

  const [row] = await db.select().from(schema.places).where(eq(schema.places.id, id));
  if (!row) throw new Error('createPlace: insert did not return a row');
  return row;
}

/**
 * `T.8`'s importer calls this instead of `createPlace` directly — the same
 * Foursquare venue turns up on many check-ins (a decade of visits to one
 * coffee shop), and across a re-run of the same export, so importing must
 * reuse the local place row it already minted rather than creating a
 * duplicate every time. `createPlace` itself stays a plain unconditional
 * insert (T.3's contract — no caller expects it to silently dedupe).
 */
export async function findOrCreateImportedPlace(
  db: TravellogDb,
  ctx: CreatePlaceContext,
  input: Omit<CreatePlaceInput, 'source'>,
): Promise<PlaceRow> {
  if (input.sourceRef) {
    const existing = await db
      .select()
      .from(schema.places)
      .where(
        and(
          eq(schema.places.tenantId, ctx.tenantId),
          eq(schema.places.source, 'import'),
          eq(schema.places.sourceRef, input.sourceRef),
        ),
      )
      .limit(1);
    if (existing[0]) return existing[0];
  }
  return createPlace(db, ctx, { ...input, source: 'import' });
}
