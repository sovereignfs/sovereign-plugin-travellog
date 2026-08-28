/**
 * `T.20`'s review checklist, verified end-to-end against the real handler
 * and a real (ephemeral) database: a reminder fires once per item, not
 * repeatedly; no reminder for un-timed items. `@sovereignfs/sdk` is mocked
 * the same way `import-swarm.test.ts` mocks it. `now` is passed explicitly
 * to the handler on every call (its second, injectable parameter) rather
 * than relying on the real clock — see the handler's own header comment.
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
  notificationsSent: [] as { recipientUserId: string; title: string; body?: string; url?: string }[],
}));

vi.mock('@sovereignfs/sdk', () => ({
  sdk: {
    db: { getClient: vi.fn(async () => harness.dbClient) },
    notifications: {
      send: vi.fn(async (input: { recipientUserId: string; title: string; body?: string; url?: string }) => {
        harness.notificationsSent.push(input);
      }),
    },
  },
}));

import tripModeReminders from '../trip-mode-reminders';

const actor = { tenantId: 'tenant-1', userId: 'user-1' };
// Torre de Belém, Lisbon — a real, unambiguous Europe/Lisbon coordinate pair.
const LISBON = { lat: 38.691586, lng: -9.2159288 };
// 2026-06-10 in Europe/Lisbon (UTC+1 in June) — 11:50 local is 10:50 UTC.
const NOW_UTC_MS = Date.parse('2026-06-10T10:50:00Z');

function fakeCtx() {
  return {
    pluginId: 'fs.sovereign.travellog',
    scheduleId: 'trip-mode-reminders',
    headers: new Headers({ 'x-sovereign-plugin-id': 'fs.sovereign.travellog' }),
  };
}

async function setUpDueTrip(t: Awaited<ReturnType<typeof createTestDb>>, plannedTime: string) {
  const place = await createPlace(t.travellog, actor, { name: 'Torre de Belém', source: 'manual', ...LISBON });
  const trip = await createTrip(t.travellog, actor, 'Lisbon 2026');
  const stop = await createStop(t.travellog, trip.id, {
    placeId: place.id,
    arriveDate: '2026-06-10',
    departDate: '2026-06-10',
  });
  const [day] = await listTripDays(t.travellog, stop.id);
  if (!day) throw new Error('expected a trip day');
  const item = await createItineraryItem(t.travellog, day.id, trip.id, { placeId: place.id, plannedTime });
  return { trip, stop, item };
}

describe('tripModeReminders (T.20)', () => {
  it('sends exactly one reminder for an item due within the lead window, and claims it', async () => {
    const t = await createTestDb();
    harness.dbClient = t.travellog;
    harness.notificationsSent = [];
    try {
      const { trip, item } = await setUpDueTrip(t, '12:00'); // 10 min away at 11:50 local

      await tripModeReminders(fakeCtx(), NOW_UTC_MS);

      expect(harness.notificationsSent).toHaveLength(1);
      expect(harness.notificationsSent[0]).toMatchObject({
        recipientUserId: actor.userId,
        title: 'Torre de Belém in 10 min',
        url: `/travellog/planner/${trip.id}/mode`,
      });

      const [row] = await t.db.select().from(schema.itineraryItems).where(eq(schema.itineraryItems.id, item.id));
      expect(row?.reminderSentAt).toBe(NOW_UTC_MS);
    } finally {
      t.close();
    }
  });

  it('fires once per item, not repeatedly — a second tick sends nothing more', async () => {
    const t = await createTestDb();
    harness.dbClient = t.travellog;
    harness.notificationsSent = [];
    try {
      await setUpDueTrip(t, '12:00');

      await tripModeReminders(fakeCtx(), NOW_UTC_MS);
      await tripModeReminders(fakeCtx(), NOW_UTC_MS + 60_000); // a later tick, one minute on

      expect(harness.notificationsSent).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  it('no reminder for an un-timed item, even when its day is today', async () => {
    const t = await createTestDb();
    harness.dbClient = t.travellog;
    harness.notificationsSent = [];
    try {
      const place = await createPlace(t.travellog, actor, { name: 'Torre de Belém', source: 'manual', ...LISBON });
      const trip = await createTrip(t.travellog, actor, 'Lisbon 2026');
      const stop = await createStop(t.travellog, trip.id, {
        placeId: place.id,
        arriveDate: '2026-06-10',
        departDate: '2026-06-10',
      });
      const [day] = await listTripDays(t.travellog, stop.id);
      if (!day) throw new Error('expected a trip day');
      await createItineraryItem(t.travellog, day.id, trip.id, { title: 'Wander around' }); // no plannedTime

      await tripModeReminders(fakeCtx(), NOW_UTC_MS);

      expect(harness.notificationsSent).toHaveLength(0);
    } finally {
      t.close();
    }
  });

  it('no reminder for an item outside the lead window', async () => {
    const t = await createTestDb();
    harness.dbClient = t.travellog;
    harness.notificationsSent = [];
    try {
      await setUpDueTrip(t, '15:00'); // 3h10m away at 11:50 local — well past a 20-minute lead

      await tripModeReminders(fakeCtx(), NOW_UTC_MS);

      expect(harness.notificationsSent).toHaveLength(0);
    } finally {
      t.close();
    }
  });

  it('skips a stop whose place has no coordinates — never guesses a timezone', async () => {
    const t = await createTestDb();
    harness.dbClient = t.travellog;
    harness.notificationsSent = [];
    try {
      const place = await createPlace(t.travellog, actor, { name: 'Somewhere, no coords', source: 'manual' });
      const trip = await createTrip(t.travellog, actor, 'Undated trip');
      const stop = await createStop(t.travellog, trip.id, {
        placeId: place.id,
        arriveDate: '2026-06-10',
        departDate: '2026-06-10',
      });
      const [day] = await listTripDays(t.travellog, stop.id);
      if (!day) throw new Error('expected a trip day');
      await createItineraryItem(t.travellog, day.id, trip.id, { placeId: place.id, plannedTime: '12:00' });

      await tripModeReminders(fakeCtx(), NOW_UTC_MS);

      expect(harness.notificationsSent).toHaveLength(0);
    } finally {
      t.close();
    }
  });

  it('skips a candidate stop where "today" in its resolved zone falls outside its date range', async () => {
    const t = await createTestDb();
    harness.dbClient = t.travellog;
    harness.notificationsSent = [];
    try {
      // A stop dated only for 2026-06-09 (Lisbon) — the coarse UTC ±1 day
      // prefilter picks it up for a 2026-06-10 "now", but Lisbon's own local
      // date at that instant is 2026-06-10, one day past this stop's range.
      const place = await createPlace(t.travellog, actor, { name: 'Torre de Belém', source: 'manual', ...LISBON });
      const trip = await createTrip(t.travellog, actor, 'Lisbon 2026');
      const stop = await createStop(t.travellog, trip.id, {
        placeId: place.id,
        arriveDate: '2026-06-09',
        departDate: '2026-06-09',
      });
      const [day] = await listTripDays(t.travellog, stop.id);
      if (!day) throw new Error('expected a trip day');
      await createItineraryItem(t.travellog, day.id, trip.id, { placeId: place.id, plannedTime: '12:00' });

      await tripModeReminders(fakeCtx(), NOW_UTC_MS);

      expect(harness.notificationsSent).toHaveLength(0);
    } finally {
      t.close();
    }
  });
});
