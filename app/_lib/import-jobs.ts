/**
 * Data layer for `travellog_import_jobs` (`T.8`) — the durable row a
 * Swarm import's progress and resume cursor live in, distinct from the
 * platform's own disposable-per-attempt `plugin_jobs` row (see
 * `../_db/schema.ts`'s `importJobs` doc comment for why the two are
 * separate). `../_jobs/import-swarm.ts` is the only caller of the
 * mutation helpers below; `actions.ts` calls `createImportJob`/`getImportJob`
 * for the upload route and status UI.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { TravellogDb } from '../_db/client';
import * as schema from '../_db/schema';
import type { Actor } from './authz';
import { newId } from './ids';

export type ImportJobRow = typeof schema.importJobs.$inferSelect;
export type ImportJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export async function createImportJob(
  db: TravellogDb,
  actor: Actor,
  storageKey: string,
): Promise<ImportJobRow> {
  const now = Date.now();
  const id = newId();
  await db.insert(schema.importJobs).values({
    id,
    tenantId: actor.tenantId,
    userId: actor.userId,
    status: 'pending',
    storageKey,
    processedCheckins: 0,
    processedPhotos: 0,
    failedPhotos: 0,
    cursor: 0,
    createdAt: now,
    updatedAt: now,
  });
  const row = await getImportJob(db, id);
  if (!row) throw new Error('createImportJob: insert did not return a row');
  return row;
}

export async function getImportJob(db: TravellogDb, id: string): Promise<ImportJobRow | null> {
  const rows = await db.select().from(schema.importJobs).where(eq(schema.importJobs.id, id));
  return rows[0] ?? null;
}

/** The caller's own most recent import — the status page's "resume this" target. Ownership-scoped in its own WHERE clause. */
export async function getLatestImportJob(
  db: TravellogDb,
  actor: Actor,
): Promise<ImportJobRow | null> {
  const rows = await db
    .select()
    .from(schema.importJobs)
    .where(
      and(
        eq(schema.importJobs.tenantId, actor.tenantId),
        eq(schema.importJobs.userId, actor.userId),
      ),
    )
    .orderBy(desc(schema.importJobs.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function setImportJobPlatformJobId(
  db: TravellogDb,
  id: string,
  platformJobId: string,
): Promise<void> {
  await db
    .update(schema.importJobs)
    .set({ platformJobId, updatedAt: Date.now() })
    .where(eq(schema.importJobs.id, id));
}

export async function markImportJobRunning(db: TravellogDb, id: string): Promise<void> {
  await db
    .update(schema.importJobs)
    .set({ status: 'running', errorMessage: null, updatedAt: Date.now() })
    .where(eq(schema.importJobs.id, id));
}

export async function setImportJobTotals(
  db: TravellogDb,
  id: string,
  totals: { totalCheckins: number; totalPhotos: number },
): Promise<void> {
  await db
    .update(schema.importJobs)
    .set({ ...totals, updatedAt: Date.now() })
    .where(eq(schema.importJobs.id, id));
}

export interface ImportJobProgress {
  cursor: number;
  processedCheckins: number;
  processedPhotos: number;
  failedPhotos: number;
}

export async function updateImportJobProgress(
  db: TravellogDb,
  id: string,
  progress: ImportJobProgress,
): Promise<void> {
  await db
    .update(schema.importJobs)
    .set({ ...progress, updatedAt: Date.now() })
    .where(eq(schema.importJobs.id, id));
}

export async function markImportJobCompleted(db: TravellogDb, id: string): Promise<void> {
  const now = Date.now();
  await db
    .update(schema.importJobs)
    .set({ status: 'completed', completedAt: now, updatedAt: now })
    .where(eq(schema.importJobs.id, id));
}

export async function markImportJobFailed(
  db: TravellogDb,
  id: string,
  errorMessage: string,
): Promise<void> {
  await db
    .update(schema.importJobs)
    .set({ status: 'failed', errorMessage, updatedAt: Date.now() })
    .where(eq(schema.importJobs.id, id));
}

/**
 * A user-requested stop. The running handler checks the row's status
 * between check-ins (`../_jobs/import-swarm.ts`) and exits at the next
 * boundary; the row keeps its cursor, so a later "Resume" can pick up
 * exactly where it stopped. Only a `pending`/`running` job can be
 * cancelled — returns whether anything changed.
 */
export async function cancelImportJob(db: TravellogDb, id: string): Promise<boolean> {
  await db
    .update(schema.importJobs)
    .set({ status: 'cancelled', updatedAt: Date.now() })
    .where(
      and(eq(schema.importJobs.id, id), inArray(schema.importJobs.status, ['pending', 'running'])),
    );
  const row = await getImportJob(db, id);
  return row?.status === 'cancelled';
}

/**
 * Account-deletion sweep (`_lib/portability.ts`): removes every import row
 * this user owns and returns the ZIP storage keys they pointed at, so the
 * caller can delete those objects too. Import ZIPs are stored *unowned*
 * (`checkins/import/upload/route.ts` explains why), which means the
 * platform's own `owner_user_id` storage sweep never sees them — this is
 * the only path that ever removes them.
 */
export async function deleteImportJobsForUser(
  db: TravellogDb,
  actor: Actor,
): Promise<{ deleted: number; storageKeys: string[] }> {
  const rows = await db
    .select({ id: schema.importJobs.id, storageKey: schema.importJobs.storageKey })
    .from(schema.importJobs)
    .where(
      and(
        eq(schema.importJobs.tenantId, actor.tenantId),
        eq(schema.importJobs.userId, actor.userId),
      ),
    );
  if (rows.length === 0) return { deleted: 0, storageKeys: [] };
  await db
    .delete(schema.importJobs)
    .where(
      and(
        eq(schema.importJobs.tenantId, actor.tenantId),
        eq(schema.importJobs.userId, actor.userId),
      ),
    );
  return { deleted: rows.length, storageKeys: [...new Set(rows.map((r) => r.storageKey))] };
}

/** The inverse of `cancelImportJob`, for "Resume" on a cancelled row: back to `pending` so the handler runs it again from its cursor. */
export async function reopenImportJob(db: TravellogDb, id: string): Promise<void> {
  await db
    .update(schema.importJobs)
    .set({ status: 'pending', errorMessage: null, updatedAt: Date.now() })
    .where(and(eq(schema.importJobs.id, id), eq(schema.importJobs.status, 'cancelled')));
}
