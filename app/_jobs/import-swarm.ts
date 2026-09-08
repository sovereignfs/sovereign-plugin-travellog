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
import { sniffRasterImageType } from '../_lib/file-type';
import { plural } from '../_lib/format';
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
/** Covers the whole fetch, headers *and* body — a slow-drip body used to hang the job forever once the headers had arrived. */
const PHOTO_FETCH_TIMEOUT_MS = 15_000;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
/** Persist `cursor`/progress every N checkins rather than every one — bounds write volume on a large export. */
const PROGRESS_PERSIST_EVERY = 5;

/**
 * The only hosts a Swarm export's photo URLs ever point at — Foursquare's
 * image CDN. The URL is assembled from strings inside an *uploaded file*
 * (`swarm-import.ts`'s `extractPhotoUrls`), so without this allowlist the
 * job was a server-side request forger: any `https://` host, following
 * redirects (including to plain `http://`), from inside the instance's
 * network, with the response stored and handed back via a signed URL.
 * Exported so the test can name it rather than a copy of it.
 */
export const ALLOWED_PHOTO_HOST_SUFFIXES = ['.4sqi.net', '.foursquare.com'] as const;

export function isAllowedPhotoUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_PHOTO_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads a response body up to `maxBytes`, aborting the moment the cap is
 * exceeded — the cap is enforced *while* streaming, not after the whole
 * body has already been buffered in the runtime process (jobs run
 * in-process, so an unbounded `arrayBuffer()` was memory the whole
 * instance paid for).
 */
async function readBodyCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('Photo exceeds the maximum size.');
  }
  if (!response.body) return new Uint8Array(await response.arrayBuffer());

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('Photo exceeds the maximum size.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function fetchAndStorePhoto(actor: { userId: string }, photoUrl: string): Promise<string> {
  if (!isAllowedPhotoUrl(photoUrl)) {
    throw new Error('Refusing to fetch a photo from outside Foursquare’s image CDN.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PHOTO_FETCH_TIMEOUT_MS);
  let bytes: Uint8Array;
  try {
    // `redirect: 'error'` — a redirect off the allowlisted host (or down to
    // plain http) must not be followed; the allowlist only ever checked the
    // *initial* URL.
    const response = await fetch(photoUrl, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) {
      throw new Error(`Photo fetch failed with status ${String(response.status)}.`);
    }
    bytes = await readBodyCapped(response, MAX_PHOTO_BYTES);
  } finally {
    clearTimeout(timeout);
  }
  if (bytes.length === 0) throw new Error('Photo response was empty.');

  // The stored content type comes from the bytes, never from the CDN's
  // `content-type` header — an SVG (or anything else) labelled `image/*`
  // would otherwise be served back inline from the runtime origin.
  const contentType = sniffRasterImageType(bytes);
  if (!contentType) throw new Error('Photo response was not a recognised image.');

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

/** Best-effort: the row already records the outcome; a leftover object is a quota leak, not a correctness problem. */
async function deleteUploadedZip(storageKey: string): Promise<void> {
  try {
    await sdk.storage.delete(storageKey);
  } catch (err) {
    console.error(`[travellog] Could not remove the imported export "${storageKey}":`, err);
  }
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
  // the real run already finished — a no-op, not an error. A cancelled row
  // stays cancelled until the user explicitly resumes it (which flips it
  // back to `pending` before re-enqueueing).
  if (job.status === 'completed' || job.status === 'cancelled') return;

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

  // Any failure past this point marks the *plugin's* row `failed` with the
  // real message before re-throwing to the platform's retry logic — the
  // platform only ever updates its own `plugin_jobs` row, so without this
  // a crash mid-loop left the status page showing "running" forever.
  try {
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

        // Cooperative cancellation, checked at the same cadence progress is
        // persisted: the cursor just written is exactly where a later
        // Resume picks up.
        const latest = await getImportJob(db, importJobId);
        if (latest?.status === 'cancelled') return;
      }
    }
  } catch (err) {
    await markImportJobFailed(db, importJobId, err instanceof Error ? err.message : String(err));
    throw err;
  }

  await markImportJobCompleted(db, importJobId);
  // The export ZIP has done its job — up to 50 MB of plugin-wide storage
  // quota per import that used to persist forever (and, being an unowned
  // object, escaped the account-deletion sweep too).
  await deleteUploadedZip(job.storageKey);

  const skippedNote =
    failedPhotos > 0 ? ` (${String(failedPhotos)} photos couldn’t be fetched)` : '';
  await sdk.notifications.send(
    {
      recipientUserId: actor.userId,
      title: 'Swarm import complete',
      body: `Imported ${plural(processedCheckins, 'check-in')}${skippedNote}.`,
      url: '/travellog/checkins',
      category: 'info',
    },
    ctx.headers,
  );
}
