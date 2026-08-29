/**
 * The visit (check-in) mutation data layer — the query/read layer lives in
 * `./queries.ts`. Pure data-layer functions; `../actions.ts` wraps these
 * with `requireUser()`/`requireVisitOwner()` and `ActionResult`.
 */
import { and, eq } from 'drizzle-orm';
import { sdk } from '@sovereignfs/sdk';
import type { TravellogDb } from '../_db/client';
import * as schema from '../_db/schema';
import { computeAutoLinkForVisit } from './auto-link';
import type { Actor } from './authz';
import { newId } from './ids';
import { positionAfter } from '../_db/position';

export type VisitRow = typeof schema.visits.$inferSelect;
export type VisitSource = 'manual' | 'gps' | 'import:swarm';

export interface CreateVisitPhotoInput {
  storageKey: string;
  source: 'upload' | 'import';
}

export interface CreateVisitInput {
  placeId: string;
  /** Unix ms, UTC. */
  happenedAt: number;
  tzIana: string;
  tzOffsetMinutes: number;
  note?: string | null;
  companions?: string[];
  source: VisitSource;
  /** Import de-dup key — `T.8`'s Swarm importer sets this; manual/GPS check-ins never do. */
  externalRef?: string | null;
  photos?: CreateVisitPhotoInput[];
}

/**
 * Creates a visit and, in the same transaction, any attached photos —
 * either all rows exist or none do. `T.12`'s auto-link engine runs here
 * too, inside the same transaction (`computeAutoLinkForVisit` reads
 * through `tx`, the same not-yet-committed connection) — this single
 * function is `createVisit`'s one write path, called by both `T.4`'s
 * manual/GPS check-in action and `T.8`'s Swarm import job, so both get
 * auto-link for free without either caller needing to know it exists.
 */
export async function createVisit(
  db: TravellogDb,
  actor: Actor,
  input: CreateVisitInput,
): Promise<VisitRow> {
  const now = Date.now();
  const id = newId();

  await db.transaction(async (tx) => {
    const autoLink = await computeAutoLinkForVisit(tx, actor, {
      happenedAt: input.happenedAt,
      tzIana: input.tzIana,
    });

    const sealed = await sdk.crypto.seal(schema.visits, {
      id,
      tenantId: actor.tenantId,
      userId: actor.userId,
      placeId: input.placeId,
      happenedAt: input.happenedAt,
      tzIana: input.tzIana,
      tzOffsetMinutes: input.tzOffsetMinutes,
      note: input.note ?? null,
      companions:
        input.companions && input.companions.length > 0 ? JSON.stringify(input.companions) : null,
      tripId: autoLink.tripId,
      linkSource: autoLink.linkSource,
      source: input.source,
      externalRef: input.externalRef ?? null,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(schema.visits).values(sealed);

    let position: number | undefined;
    for (const photo of input.photos ?? []) {
      position = positionAfter(position);
      await tx.insert(schema.visitPhotos).values({
        id: newId(),
        visitId: id,
        storageKey: photo.storageKey,
        position,
        source: photo.source,
        createdAt: now,
      });
    }
  });

  const [row] = await db.select().from(schema.visits).where(eq(schema.visits.id, id));
  if (!row) throw new Error('createVisit: insert did not return a row');
  return (await sdk.crypto.open(schema.visits, row as Record<string, unknown>)) as unknown as VisitRow;
}

export interface UpdateVisitInput {
  note?: string | null;
  companions?: string[];
  happenedAt?: number;
  tzIana?: string;
  tzOffsetMinutes?: number;
}

/**
 * The caller (../actions.ts) resolves ownership via `requireVisitOwner`
 * first and passes the confirmed row — this function trusts `visitId`
 * without re-checking ownership, so it must never be exposed directly to
 * an action without that guard.
 */
export async function updateVisit(
  db: TravellogDb,
  visitId: string,
  patch: UpdateVisitInput,
): Promise<VisitRow> {
  const now = Date.now();
  const sealed = await sdk.crypto.seal(schema.visits, {
    ...(patch.note !== undefined ? { note: patch.note } : {}),
    ...(patch.companions !== undefined
      ? { companions: patch.companions.length > 0 ? JSON.stringify(patch.companions) : null }
      : {}),
    ...(patch.happenedAt !== undefined ? { happenedAt: patch.happenedAt } : {}),
    ...(patch.tzIana !== undefined ? { tzIana: patch.tzIana } : {}),
    ...(patch.tzOffsetMinutes !== undefined ? { tzOffsetMinutes: patch.tzOffsetMinutes } : {}),
    updatedAt: now,
  });
  await db.update(schema.visits).set(sealed).where(eq(schema.visits.id, visitId));

  const [row] = await db.select().from(schema.visits).where(eq(schema.visits.id, visitId));
  if (!row) throw new Error('updateVisit: row disappeared mid-update');
  return (await sdk.crypto.open(schema.visits, row as Record<string, unknown>)) as unknown as VisitRow;
}

/**
 * `T.12`'s manual override — always writes `linkSource: 'manual'`,
 * `tripId: 'to a real trip'` or `tripId: null` (the "Unlink" affordance,
 * `T.6`'s detail column). Either way, `linkSource: 'manual'` means a
 * future `recomputeAutoLinksForActor` will never touch this row again
 * (`./auto-link.ts`'s own doc comment; `schema.ts`'s `linkSource` comment
 * for the full invariant this deliberately isn't a strict "null iff tripId
 * null" anymore). Same trusts-the-caller-already-checked-ownership
 * contract as `updateVisit`.
 */
export async function setVisitTripLink(
  db: TravellogDb,
  visitId: string,
  tripId: string | null,
): Promise<VisitRow> {
  await db
    .update(schema.visits)
    .set({ tripId, linkSource: 'manual', updatedAt: Date.now() })
    .where(eq(schema.visits.id, visitId));

  const [row] = await db.select().from(schema.visits).where(eq(schema.visits.id, visitId));
  if (!row) throw new Error('setVisitTripLink: row disappeared mid-update');
  return (await sdk.crypto.open(schema.visits, row as Record<string, unknown>)) as unknown as VisitRow;
}

/** Photos cascade at the DB level (ON DELETE CASCADE) — no manual cleanup needed. */
export async function deleteVisit(db: TravellogDb, visitId: string): Promise<void> {
  await db.delete(schema.visits).where(eq(schema.visits.id, visitId));
}

/**
 * `T.8`'s de-dup check — a checkin already imported (this run's cursor
 * resuming past a crash, a full re-run of the same export, or two
 * overlapping attempts) is skipped, not re-inserted. The real backstop is
 * `travellog_visits_tenant_source_external_ref_unique` (`T.2`); this
 * pre-check exists so a resumed/re-run import doesn't pay the place-lookup
 * and photo-fetch cost for rows it's about to discover are duplicates.
 */
export async function isVisitAlreadyImported(
  db: TravellogDb,
  actor: Actor,
  externalRef: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.visits.id })
    .from(schema.visits)
    .where(
      and(
        eq(schema.visits.tenantId, actor.tenantId),
        eq(schema.visits.source, 'import:swarm'),
        eq(schema.visits.externalRef, externalRef),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * `T.21`'s de-dup check for a synced offline check-in — the same
 * `travellog_visits_tenant_source_external_ref_unique` backstop
 * `isVisitAlreadyImported` above already leans on, generalized to a
 * caller-given `source` rather than hardcoding `'import:swarm'`: a resumed
 * `drainQueue()` replaying the same client-minted mutation id (RFC 0078's
 * idempotent-apply contract — `docs/plugin-development.md`'s "Offline
 * writes" section) must be a no-op, not a duplicate visit.
 */
export async function isVisitAlreadySynced(
  db: TravellogDb,
  actor: Actor,
  source: VisitSource,
  externalRef: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.visits.id })
    .from(schema.visits)
    .where(
      and(
        eq(schema.visits.tenantId, actor.tenantId),
        eq(schema.visits.userId, actor.userId),
        eq(schema.visits.source, source),
        eq(schema.visits.externalRef, externalRef),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export interface AddVisitPhotoInput {
  storageKey: string;
  source: 'upload' | 'import';
}

/**
 * Attaches one photo to an already-created visit — used by the importer,
 * which fetches each Swarm photo URL independently (rate-limited, may fail)
 * after the visit itself exists, unlike `createVisit`'s own `photos` param
 * (all-or-nothing, inside the same transaction as the visit insert).
 */
export async function addVisitPhoto(
  db: TravellogDb,
  visitId: string,
  photo: AddVisitPhotoInput,
): Promise<void> {
  const existing = await db
    .select({ position: schema.visitPhotos.position })
    .from(schema.visitPhotos)
    .where(eq(schema.visitPhotos.visitId, visitId));
  const maxPosition = existing.reduce<number | undefined>(
    (max, row) => (max === undefined || row.position > max ? row.position : max),
    undefined,
  );

  await db.insert(schema.visitPhotos).values({
    id: newId(),
    visitId,
    storageKey: photo.storageKey,
    position: positionAfter(maxPosition),
    source: photo.source,
    createdAt: Date.now(),
  });
}
