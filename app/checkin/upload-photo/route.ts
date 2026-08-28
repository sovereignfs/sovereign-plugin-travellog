import { NextResponse } from 'next/server';
import { sdk } from '@sovereignfs/sdk';
import { newId } from '../../_lib/ids';

/** A single check-in photo — mirrors `runtime`'s Warden attachment cap (`MAX_ATTACHMENT_BYTES`). */
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/**
 * Photo upload for `T.7`'s check-in confirm step — a Route Handler, not a
 * server action, because a real camera photo (several MB) would hit
 * Next.js's default 1 MB server-action body-size limit. `runtime`'s Warden
 * chat route hit the identical constraint for message attachments and
 * solved it the same way (see that route's own doc comment) — mirrored
 * here rather than raising `experimental.serverActions.bodySizeLimit`
 * platform-wide for one plugin's one upload.
 *
 * The client uploads the photo here first and gets back a `storageKey`,
 * then passes that into `createVisitAction`'s existing `photos` field
 * (unchanged from `T.4` — it already accepts pre-resolved storage keys).
 */
export async function POST(request: Request): Promise<Response> {
  const session = await sdk.auth.requireSession();

  const formData = await request.formData();
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No photo was attached.' }, { status: 400 });
  }
  if (!file.type.startsWith('image/')) {
    return NextResponse.json({ error: 'That file isn’t an image.' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'That photo is empty.' }, { status: 400 });
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return NextResponse.json(
      { error: `Photos are limited to ${Math.floor(MAX_PHOTO_BYTES / (1024 * 1024))} MB.` },
      { status: 400 },
    );
  }

  const object = await sdk.storage.put({
    key: `visits/${session.user.id}/${newId()}`,
    body: file,
    contentType: file.type,
    ownerUserId: session.user.id,
  });

  return NextResponse.json({ storageKey: object.key });
}
