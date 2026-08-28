import { NextResponse } from 'next/server';
import { sdk } from '@sovereignfs/sdk';
import { requireTripDayOwner, requireTripOwner, requireUser } from '../../../../_lib/authz';
import { getDb } from '../../../../_lib/db';
import { newId } from '../../../../_lib/ids';

/**
 * A receipt, booking confirmation, or accommodation record routinely
 * exceeds Next's 1 MB server-action body cap — a Route Handler, not a
 * server action, same precedent as `T.7`'s photo upload and `T.8`'s ZIP
 * upload (both docs explain the cap; not re-derived here). The client
 * uploads here first and gets back a `storageKey`, then calls
 * `createAttachmentAction` (`../../../../actions.ts`) with it to create the
 * actual `travellog_attachments` row — this route only writes bytes to
 * `sdk.storage`, never the DB, so ownership is checked here against
 * whichever target (`tripId` or `tripDayId`) the form supplies, and
 * `createAttachmentAction` checks it again independently once the row is
 * about to be created (never trust a client-supplied id twice removed from
 * its own check).
 */
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  const actor = await requireUser();

  const formData = await request.formData();
  const file = formData.get('file');
  const tripId = formData.get('tripId');
  const tripDayId = formData.get('tripDayId');

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file was uploaded.' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'That file is empty.' }, { status: 400 });
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return NextResponse.json(
      { error: `Attachments are limited to ${String(Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024)))} MB.` },
      { status: 400 },
    );
  }

  const hasTripId = typeof tripId === 'string' && tripId.length > 0;
  const hasTripDayId = typeof tripDayId === 'string' && tripDayId.length > 0;
  if (hasTripId === hasTripDayId) {
    return NextResponse.json(
      { error: 'An attachment must be tied to a trip or a specific day.' },
      { status: 400 },
    );
  }

  const db = await getDb();
  if (hasTripId) {
    const trip = await requireTripOwner(db, tripId as string, actor);
    if (!trip) return NextResponse.json({ error: 'Trip not found.' }, { status: 404 });
  } else {
    const day = await requireTripDayOwner(db, tripDayId as string, actor);
    if (!day) return NextResponse.json({ error: 'Day not found.' }, { status: 404 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const object = await sdk.storage.put({
    key: `attachments/${actor.userId}/${newId()}`,
    body: bytes,
    contentType: file.type || 'application/octet-stream',
    ownerUserId: actor.userId,
  });

  return NextResponse.json({ storageKey: object.key });
}
