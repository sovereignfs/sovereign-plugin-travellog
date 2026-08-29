/**
 * `T.24` (RFC 0092) — registers this plugin's one classified table
 * (`visits.note`) so the operator's tools (`sv db encrypt-fields` backfill,
 * `sv keys rotate-blind-index`) can walk it from outside the runtime
 * process. Mirrors `example-plugins/example-encrypted`'s own
 * `registerEncryptionTables` exactly, including the idempotency flag —
 * registration persists platform-side, so the flag just avoids re-upserting
 * on every request.
 */
import { sdk } from '@sovereignfs/sdk';
import * as schema from '../_db/schema';

let registered = false;

export async function registerEncryptionTables(): Promise<void> {
  if (registered) return;
  await sdk.crypto.registerTables(schema.visits);
  registered = true;
}
