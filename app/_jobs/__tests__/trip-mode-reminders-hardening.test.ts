/**
 * A notification send that throws must not leave the item permanently
 * "reminded" (the claim is released), and must not abandon the rest of the
 * tick's candidates.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import * as schema from '../../_db/schema';
import { createTestDb } from '../../_db/__tests__/test-db';
import { createItineraryItem } from '../../_lib/itinerary-items';
import { createPlace } from '../../_lib/places';
import { createStop, listTripDays } from '../../_lib/stops';
import { createTrip } from '../../_lib/trips';

const harness = vi.hoisted(() => ({
  dbClient: null as unknown,
  sent: [] as string[],
  failFor: new Set<string>(),
}));

vi.mock('@sovereignfs/sdk', () => ({
  sdk: {
    db: { getClient: vi.fn(async () => harness.dbClient) },
    notifications: {
      send: vi.fn(async (input: { recipientUserId: string; title: string }) => {
        if (harness.failFor.has(input.recipientUserId)) throw new Error('push gateway down');
        harness.sent.push(input.title);
      }),
    },
  },
}));

import tripModeReminders from '../trip-mode-reminders';

const LISBON = { lat: 38.691586, lng: -9.2159288 };
const NOW_UTC_MS = Date.parse('2026-06-10T10:50:00Z'); // 11:50 in Lisbon

async function dueItemFor(
  t: Awaited<ReturnType<typeof createTestDb>>,
  userId: string,
  name: string,
) {
  const actor = { tenantId: 'tenant-1', userId };
  const place = await createPlace(t.travellog, actor, { name, source: 'manual', ...LISBON });
  const trip = await createTrip(t.travellog, actor, `${name} trip`);
  const stop = await createStop(t.travellog, trip.id, {
    placeId: place.id,
    arriveDate: '2026-06-10',
    departDate: '2026-06-10',
  });
  const [day] = await listTripDays(t.travellog, stop.id);
  if (!day) throw new Error('expected a day');
  return createItineraryItem(t.travellog, day.id, trip.id, {
    placeId: place.id,
    plannedTime: '12:00',
  });
}

describe('tripModeReminders — send failure isolation', () => {
  it('releases the claim when the send throws, and still reminds the other traveler this tick', async () => {
    const t = await createTestDb();
    harness.dbClient = t.travellog;
    harness.sent = [];
    harness.failFor = new Set(['user-broken']);
    try {
      const broken = await dueItemFor(t, 'user-broken', 'Broken');
      const fine = await dueItemFor(t, 'user-fine', 'Fine');

      await tripModeReminders(
        { pluginId: 'p', scheduleId: 's', headers: new Headers() },
        NOW_UTC_MS,
      );

      expect(harness.sent).toEqual(['Fine in 10 min']);
      const [brokenRow] = await t.db
        .select()
        .from(schema.itineraryItems)
        .where(eq(schema.itineraryItems.id, broken.id));
      expect(brokenRow?.reminderSentAt).toBeNull(); // released — the next tick can retry
      const [fineRow] = await t.db
        .select()
        .from(schema.itineraryItems)
        .where(eq(schema.itineraryItems.id, fine.id));
      expect(fineRow?.reminderSentAt).toBe(NOW_UTC_MS);

      // Gateway back up: the released item is reminded on the next tick, the other is not repeated.
      harness.failFor.clear();
      await tripModeReminders(
        { pluginId: 'p', scheduleId: 's', headers: new Headers() },
        NOW_UTC_MS + 60_000,
      );
      expect(harness.sent).toEqual(['Fine in 10 min', 'Broken in 9 min']);
    } finally {
      t.close();
    }
  });
});
