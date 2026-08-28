import { sdk } from '@sovereignfs/sdk';
import type { TravellogDb } from '../_db/client';

/** This plugin's isolated database, typed for the travellog schema. */
export async function getDb(): Promise<TravellogDb> {
  return (await sdk.db.getClient()) as TravellogDb;
}
