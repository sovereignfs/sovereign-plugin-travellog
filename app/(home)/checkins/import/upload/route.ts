import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { sdk } from '@sovereignfs/sdk';
import { requireUser } from '../../../../_lib/authz';
import { getDb } from '../../../../_lib/db';
import { newId } from '../../../../_lib/ids';
import { createImportJob, setImportJobPlatformJobId } from '../../../../_lib/import-jobs';
import { readSwarmCheckins, SwarmExportFormatError } from '../../../../_lib/swarm-import';

/**
 * Caps the *compressed* upload — `_lib/swarm-import.ts`'s own
 * `MAX_DECOMPRESSED_BYTES` separately guards the inflated size once the job
 * handler actually reads it. A Route Handler, not a server action, for the
 * same reason as `T.7`'s photo upload: a multi-year export ZIP routinely
 * exceeds Next's 1 MB default server-action body cap.
 */
const MAX_EXPORT_BYTES = 200 * 1024 * 1024;

function looksLikeZip(file: File): boolean {
  return (
    file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed' ||
    file.name.toLowerCase().endsWith('.zip')
  );
}

export async function POST(request: Request): Promise<Response> {
  const actor = await requireUser();

  const formData = await request.formData();
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No export file was uploaded.' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'That file is empty.' }, { status: 400 });
  }
  if (file.size > MAX_EXPORT_BYTES) {
    return NextResponse.json(
      { error: `Exports are limited to ${String(Math.floor(MAX_EXPORT_BYTES / (1024 * 1024)))} MB.` },
      { status: 400 },
    );
  }
  if (!looksLikeZip(file)) {
    return NextResponse.json({ error: 'That doesn’t look like a ZIP file.' }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    // Fails fast, synchronously, before any job starts — reuses the exact
    // parse the job handler itself runs, so there's no separate "quick
    // check" that could drift from what actually gets imported.
    readSwarmCheckins(bytes);
  } catch (err) {
    if (err instanceof SwarmExportFormatError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  // Deliberately no ownerUserId — a real bug found live, not a stylistic
  // choice. The object is read back from `import-swarm.ts`'s job handler,
  // which has no ambient user identity (`JobContext` carries a plugin id,
  // never a user id). An *owned* object's read-side check
  // (`packages/db`'s `canAccessStorageObject`) requires `context.userId` to
  // match the object's `ownerUserId`; a background job's `userId` always
  // resolves to `null` (no equivalent of `pluginId`'s
  // `getBackgroundPluginContext()` fallback exists for user identity), so
  // an owned upload here would be permanently unreadable by the only code
  // that ever reads it — confirmed live: the job failed with "no longer
  // available in storage" even though the row and bytes were both
  // genuinely present, traced via a raw table dump proving the SQL match
  // itself was fine and the ownership check was the actual filter.
  // Leaving it unowned is safe for *access control* — this plugin's own
  // `requireUser()` + `travellog_import_jobs.userId` scoping
  // (`getLatestImportJobAction`) is what actually gates who can ever learn
  // this key, the same as every other per-user resource here.
  // Known, accepted tradeoff: an unowned object is invisible to
  // `hardDeleteUserStorageObjects` (RFC 0033's cross-plugin
  // owner_user_id sweep on account deletion) — it will NOT be
  // automatically swept. Deferred to `T.23` (Sovereign portability hooks):
  // a real `sdk.portability.provideDelete` handler for this plugin will
  // need to delete by key from this plugin's own rows regardless (the
  // generic sweep was never going to be the primary mechanism for a
  // well-behaved isolated plugin — it's a backstop for plugins that don't
  // implement `provideDelete` at all), so this isn't a new category of
  // gap, just one more key that handler will need to enumerate.
  const object = await sdk.storage.put({
    key: `imports/${actor.userId}/${newId()}.zip`,
    body: bytes,
    contentType: 'application/zip',
  });

  const db = await getDb();
  const job = await createImportJob(db, actor, object.key);

  // sdk.jobs.enqueue resolves plugin/user identity only from an explicit
  // Headers argument (packages/sdk/src/jobs.ts) — it never reads
  // next/headers() itself, so this route (a real request) must pass its own.
  // No dedupeKey (see actions.ts's resumeImportAction doc comment for why).
  const requestHeaders = await headers();
  const jobRef = await sdk.jobs.enqueue(
    { type: 'import.swarm', payload: { importJobId: job.id } },
    requestHeaders,
  );
  await setImportJobPlatformJobId(db, job.id, jobRef.id);

  return NextResponse.json({ importJobId: job.id });
}
