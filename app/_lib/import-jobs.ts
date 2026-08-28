/**
 * Data layer for `travellog_import_jobs` (`T.8`) — the durable row a
 * Swarm import's progress and resume cursor live in, distinct from the
 * platform's own disposable-per-attempt `plugin_jobs` row (see
 * `../_db/schema.ts`'s `importJobs` doc comment for why the two are
 * separate). `../_jobs/import-swarm.ts` is the only caller of the
 * mutation helpers below; `actions.ts` calls `createImportJob`/`getImportJob`
 * for the upload route and status UI.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { TravellogDb } from '../_db/client';
import * as schema from '../_db/schema';
import type { Actor } from './authz';
import { newId } from './ids';

export type ImportJobRow = typeof schema.importJobs.$inferSelect;
export type ImportJobStatus = 'pending' | 'running' | 'completed' | 'failed';

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
export async function getLatestImportJob(db: TravellogDb, actor: Actor): Promise<ImportJobRow | null> {
  const rows = await db
    .select()
    .from(schema.importJobs)
    .where(and(eq(schema.importJobs.tenantId, actor.tenantId), eq(schema.importJobs.userId, actor.userId)))
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

export async function markImportJobFailed(db: TravellogDb, id: string, errorMessage: string): Promise<void> {
  await db
    .update(schema.importJobs)
    .set({ status: 'failed', errorMessage, updatedAt: Date.now() })
    .where(eq(schema.importJobs.id, id));
}
