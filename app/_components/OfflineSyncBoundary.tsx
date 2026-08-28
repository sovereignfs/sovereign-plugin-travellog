'use client';

import { useEffect } from 'react';
import { useIsOffline } from '@sovereignfs/ui';
import { drainQueue, type QueuedMutation, type SyncOutcome } from '@sovereignfs/sdk/offline-queue';
import { syncOfflineCheckinAction } from '../actions';
import { OFFLINE_PLUGIN_ID, type QueuedCheckinPayload } from '../_lib/offline-cache';

/**
 * Applies one drain batch of queued mutations sequentially, halting at the
 * first failure — the apply contract `docs/plugin-development.md`'s
 * "Offline writes" section requires of every `sdk.offline-queue` sync
 * endpoint (RFC 0078 §4). Not load-bearing for check-ins specifically
 * (each is an independent create, no cross-mutation ordering dependency),
 * but followed literally anyway: deviating from a documented platform
 * contract for a case that happens not to need the guarantee is a worse
 * trade than just implementing the contract as written, especially being
 * this queue's first real consumer.
 */
async function applyCheckinBatch(batch: QueuedMutation<QueuedCheckinPayload>[]): Promise<SyncOutcome[]> {
  const outcomes: SyncOutcome[] = [];
  for (const mutation of batch) {
    const { placeName: _placeName, ...input } = mutation.payload;
    const result = await syncOfflineCheckinAction(mutation.id, input);
    if (!result.ok) {
      outcomes.push({ id: mutation.id, status: 'failed', error: result.error });
      break;
    }
    outcomes.push({ id: mutation.id, status: 'applied' });
  }
  return outcomes;
}

/**
 * `T.21` — mounted once in `app/layout.tsx`, present on every page this
 * plugin renders, so a check-in queued offline syncs the moment the app is
 * next foregrounded with a connection on *whichever* page that happens to
 * be — not only the check-in screen that created it. `sdk.offline-queue`
 * has no platform-orchestrated background sync (no iOS Safari support for
 * the Background Sync API); a plugin must call `drainQueue()` itself, on
 * mount and on the `window` `'online'` event
 * (`docs/plugin-development.md`'s own recommendation). Renders nothing —
 * this is plumbing, not UI.
 */
export function OfflineSyncBoundary() {
  const isOffline = useIsOffline();

  useEffect(() => {
    if (isOffline) return;
    void drainQueue(OFFLINE_PLUGIN_ID, applyCheckinBatch);
  }, [isOffline]);

  return null;
}
