/**
 * `T.8`'s Swarm importer — the `import.swarm` job handler (manifest-declared,
 * `@sovereignfs/sdk`'s `JobHandler` contract). Reads the uploaded export from
 * `sdk.storage`, maps each checkin (`../_lib/swarm-import.ts`), and creates
 * the place/visit/photo rows, resuming from `travellog_import_jobs.cursor`
 * rather than the start of the array.
 *
 * Deliberately thin orchestration — the field mapping lives in
 * `_lib/swarm-import.ts` (pure, DB-free, easiest to correct once a real
 * export is inspected), and the row-level de-dup/creation logic lives in
 * `_lib/visits.ts`/`_lib/places.ts` alongside every other caller of those
 * tables.
 */
import { sdk, type JobContext } from '@sovereignfs/sdk';
import type { TravellogDb } from '../_db/client';
import {
  getImportJob,
  markImportJobCompleted,
  markImportJobFailed,
  markImportJobRunning,
  setImportJobTotals,
  updateImportJobProgress,
  type ImportJobRow,
} from '../_lib/import-jobs';
import { newId } from '../_lib/ids';
import { findOrCreateImportedPlace } from '../_lib/places';
import {
  mapSwarmCheckin,
  readSwarmCheckins,
  SwarmExportFormatError,
  type MappedSwarmCheckin,
} from '../_lib/swarm-import';
import { addVisitPhoto, createVisit, isVisitAlreadyImported } from '../_lib/visits';

/** Politeness delay between photo fetches — a decade of check-ins can mean thousands of requests to the same CDN. */
const PHOTO_FETCH_INTERVAL_MS = 500;
const PHOTO_FETCH_TIMEOUT_MS = 15_000;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
/** Persist `cursor`/progress every N checkins rather than every one — bounds write volume on a large export. */
const PROGRESS_PERSIST_EVERY = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchAndStorePhoto(actor: { userId: string }, photoUrl: string): Promise<string> {
  const url = new URL(photoUrl);
  if (url.protocol !== 'https:') {
    throw new Error(`Refusing to fetch a non-https photo URL.`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PHOTO_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(photoUrl, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`Photo fetch failed with status ${String(response.status)}.`);
  }
  const contentType = response.headers.get('content-type') ?? 'image/jpeg';
  if (!contentType.startsWith('image/')) {
    throw new Error(`Unexpected content type "${contentType}" for a photo URL.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error('Photo response was empty.');
  if (bytes.length > MAX_PHOTO_BYTES) throw new Error('Photo exceeds the maximum size.');

  const object = await sdk.storage.put({
    key: `visits/${actor.userId}/${newId()}`,
    body: bytes,
    contentType,
    ownerUserId: actor.userId,
  });
  return object.key;
}

async function importOneCheckin(
  db: TravellogDb,
  actor: { tenantId: string; userId: string },
  checkin: MappedSwarmCheckin,
): Promise<{ photosImported: number; photosFailed: number }> {
  if (await isVisitAlreadyImported(db, actor, checkin.externalRef)) {
    return { photosImported: 0, photosFailed: 0 };
  }

  const place = await findOrCreateImportedPlace(db, actor, {
    name: checkin.venueName,
    category: checkin.category,
    lat: checkin.lat,
    lng: checkin.lng,
    address: checkin.address,
    city: checkin.city,
    state: checkin.state,
    country: checkin.country,
    countryCode: checkin.countryCode,
    postalCode: checkin.postalCode,
    sourceRef: checkin.venueSourceRef,
  });

  let visit;
  try {
    visit = await createVisit(db, actor, {
      placeId: place.id,
      happenedAt: checkin.happenedAt,
      tzIana: checkin.tzIana,
      tzOffsetMinutes: checkin.tzOffsetMinutes,
      note: checkin.note,
      companions: checkin.companions,
      source: 'import:swarm',
      externalRef: checkin.externalRef,
    });
  } catch (err) {
    // Closes the race the pre-check above can't: a "Resume" click landing
    // while an earlier attempt is still genuinely mid-flight (deliberately
    // allowed — see this job's own doc comment on why re-enqueue isn't
    // dedupeKey-guarded) can have both invocations reach this exact insert
    // for the same checkin. `travellog_visits_tenant_source_external_ref_unique`
    // (T.2) makes the loser's insert fail instead of duplicating a row;
    // treated the same as the pre-check finding it already imported.
    if (/unique constraint/i.test(err instanceof Error ? err.message : String(err))) {
      return { photosImported: 0, photosFailed: 0 };
    }
    throw err;
  }

  let photosImported = 0;
  let photosFailed = 0;
  for (const photoUrl of checkin.photoUrls) {
    await sleep(PHOTO_FETCH_INTERVAL_MS);
    try {
      const storageKey = await fetchAndStorePhoto(actor, photoUrl);
      await addVisitPhoto(db, visit.id, { storageKey, source: 'import' });
      photosImported++;
    } catch (err) {
      photosFailed++;
      console.error(
        `[travellog] Skipped a photo for imported check-in "${checkin.externalRef}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { photosImported, photosFailed };
}

interface ImportSwarmPayload {
  importJobId: string;
}

function isImportSwarmPayload(payload: unknown): payload is ImportSwarmPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { importJobId?: unknown }).importJobId === 'string'
  );
}

async function readAndMapCheckins(job: ImportJobRow): Promise<MappedSwarmCheckin[]> {
  const object = await sdk.storage.get(job.storageKey);
  if (!object) {
    throw new SwarmExportFormatError('The uploaded export is no longer available in storage.');
  }
  const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
  const raw = readSwarmCheckins(bytes);
  return raw.map(mapSwarmCheckin).filter((c): c is MappedSwarmCheckin => c !== null);
}

export default async function handleImportSwarm(ctx: JobContext, payload: unknown): Promise<void> {
  if (!isImportSwarmPayload(payload)) {
    throw new Error('import.swarm job payload is missing importJobId.');
  }
  const { importJobId } = payload;

  const db = (await sdk.db.getClient()) as TravellogDb;
  const job = await getImportJob(db, importJobId);
  if (!job) {
    throw new Error(`Import job "${importJobId}" not found.`);
  }
  // A stray duplicate enqueue (e.g. a double-clicked Resume) landing after
  // the real run already finished — a no-op, not an error.
  if (job.status === 'completed') return;

  await markImportJobRunning(db, importJobId);

  let checkins: MappedSwarmCheckin[];
  try {
    checkins = await readAndMapCheckins(job);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markImportJobFailed(db, importJobId, message);
    throw err;
  }

  if (job.totalCheckins === null) {
    const totalPhotos = checkins.reduce((sum, c) => sum + c.photoUrls.length, 0);
    await setImportJobTotals(db, importJobId, { totalCheckins: checkins.length, totalPhotos });
  }

  const actor = { tenantId: job.tenantId, userId: job.userId };
  let processedCheckins = job.processedCheckins;
  let processedPhotos = job.processedPhotos;
  let failedPhotos = job.failedPhotos;

  for (let i = job.cursor; i < checkins.length; i++) {
    const checkin = checkins[i];
    if (!checkin) continue;

    const result = await importOneCheckin(db, actor, checkin);
    processedCheckins++;
    processedPhotos += result.photosImported;
    failedPhotos += result.photosFailed;

    const isLast = i === checkins.length - 1;
    if (processedCheckins % PROGRESS_PERSIST_EVERY === 0 || isLast) {
      await updateImportJobProgress(db, importJobId, {
        cursor: i + 1,
        processedCheckins,
        processedPhotos,
        failedPhotos,
      });
      const total = Math.max(checkins.length, 1);
      await ctx.reportProgress(
        Math.round((processedCheckins / total) * 100),
        `${String(processedCheckins)}/${String(checkins.length)} check-ins`,
      );
    }
  }

  await markImportJobCompleted(db, importJobId);

  const skippedNote = failedPhotos > 0 ? ` (${String(failedPhotos)} photos couldn’t be fetched)` : '';
  await sdk.notifications.send(
    {
      recipientUserId: actor.userId,
      title: 'Swarm import complete',
      body: `Imported ${String(processedCheckins)} check-in${processedCheckins === 1 ? '' : 's'}${skippedNote}.`,
      url: '/travellog/checkins',
      category: 'info',
    },
    ctx.headers,
  );
}
