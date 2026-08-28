import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../_db/schema';
import { createTestDb, type TestDb } from '../../_db/__tests__/test-db';
import { createPlace } from '../places';
import { addVisitPhoto, createVisit, deleteVisit, isVisitAlreadyImported, updateVisit } from '../visits';

const actor = { tenantId: 'tenant-1', userId: 'user-1' };

/** Narrow a possibly-undefined row (noUncheckedIndexedAccess) with a hard failure. */
function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`expected ${label} to exist`);
  return value;
}

let t: TestDb;
let placeId: string;

beforeEach(async () => {
  t = await createTestDb();
  const place = await createPlace(t.travellog, actor, { name: 'Belém Tower', source: 'manual' });
  placeId = place.id;
});

afterEach(() => {
  t.close();
});

/** Reconstruct the local wall-clock date/time a stored UTC instant represents in a zone. */
function wallClockParts(utcMs: number, tzIana: string): { date: string; time: string } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tzIana,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

describe('createVisit — timezone round-trip (T.4 review checklist)', () => {
  it('a visit created at a given local time reconstructs to the same local time when read back (America/New_York, whole-hour offset)', async () => {
    // 2026-08-27 14:30 America/New_York (EDT, UTC-4 in August) = 2026-08-27T18:30:00Z.
    const happenedAt = Date.UTC(2026, 7, 27, 18, 30, 0);
    const visit = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt,
      tzIana: 'America/New_York',
      tzOffsetMinutes: -240,
      source: 'manual',
    });

    const [row] = await t.db.select().from(schema.visits).where(eq(schema.visits.id, visit.id));
    const found = must(row, 'visit row');
    expect(wallClockParts(found.happenedAt, found.tzIana)).toEqual({
      date: '2026-08-27',
      time: '14:30',
    });
    expect(found.tzOffsetMinutes).toBe(-240);
  });

  it('round-trips a half-hour-offset zone correctly (Asia/Kolkata, UTC+5:30)', async () => {
    // 2026-08-27 09:00 Asia/Kolkata = 2026-08-27T03:30:00Z.
    const happenedAt = Date.UTC(2026, 7, 27, 3, 30, 0);
    const visit = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt,
      tzIana: 'Asia/Kolkata',
      tzOffsetMinutes: 330,
      source: 'manual',
    });

    const [row] = await t.db.select().from(schema.visits).where(eq(schema.visits.id, visit.id));
    const found = must(row, 'visit row');
    expect(wallClockParts(found.happenedAt, found.tzIana)).toEqual({
      date: '2026-08-27',
      time: '09:00',
    });
  });

  it('a visit read back in a different reader timezone still reflects its own stored zone, not the reader’s', async () => {
    const happenedAt = Date.UTC(2026, 7, 27, 18, 30, 0);
    const visit = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt,
      tzIana: 'America/New_York',
      tzOffsetMinutes: -240,
      source: 'manual',
    });

    const [row] = await t.db.select().from(schema.visits).where(eq(schema.visits.id, visit.id));
    const found = must(row, 'visit row');
    // The stored tzIana is what's authoritative — formatting against it must
    // not depend on the machine/reader's own local timezone.
    expect(wallClockParts(found.happenedAt, found.tzIana).time).toBe('14:30');
    // Sanity: the same instant genuinely reads differently in another zone —
    // proves this test isn't accidentally trivially true.
    expect(wallClockParts(found.happenedAt, 'Europe/Lisbon').time).toBe('19:30');
  });
});

describe('createVisit', () => {
  it('stores companions as JSON and creates ordered photos in one transaction', async () => {
    const visit = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      note: 'Great view.',
      companions: ['Tom Kelly', 'Aiko Sato'],
      source: 'manual',
      photos: [
        { storageKey: 'photo-1.jpg', source: 'upload' },
        { storageKey: 'photo-2.jpg', source: 'upload' },
      ],
    });

    expect(visit.companions).toBe(JSON.stringify(['Tom Kelly', 'Aiko Sato']));

    const photos = await t.db
      .select()
      .from(schema.visitPhotos)
      .where(eq(schema.visitPhotos.visitId, visit.id));
    expect(photos).toHaveLength(2);
    expect(must(photos[0], 'first photo').position).toBeLessThan(
      must(photos[1], 'second photo').position,
    );
  });

  it('omitting companions/photos leaves them empty, not erroring', async () => {
    const visit = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'gps',
    });
    expect(visit.companions).toBeNull();
    expect(visit.note).toBeNull();
  });
});

describe('updateVisit', () => {
  it('updates note and companions, leaving other fields untouched', async () => {
    const visit = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });

    const updated = await updateVisit(t.travellog, visit.id, {
      note: 'Updated note',
      companions: ['Tom Kelly'],
    });

    expect(updated.note).toBe('Updated note');
    expect(updated.companions).toBe(JSON.stringify(['Tom Kelly']));
    expect(updated.placeId).toBe(placeId);
    expect(updated.happenedAt).toBe(visit.happenedAt);
  });

  it('an empty companions array clears the field back to null', async () => {
    const visit = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      companions: ['Tom Kelly'],
      source: 'manual',
    });

    const updated = await updateVisit(t.travellog, visit.id, { companions: [] });
    expect(updated.companions).toBeNull();
  });
});

describe('deleteVisit', () => {
  it('cascades its photos', async () => {
    const visit = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
      photos: [{ storageKey: 'photo-1.jpg', source: 'upload' }],
    });

    await deleteVisit(t.travellog, visit.id);

    expect(await t.db.select().from(schema.visits).where(eq(schema.visits.id, visit.id))).toHaveLength(0);
    expect(
      await t.db.select().from(schema.visitPhotos).where(eq(schema.visitPhotos.visitId, visit.id)),
    ).toHaveLength(0);
  });
});

describe('isVisitAlreadyImported (T.8)', () => {
  it('is false before an import, true after', async () => {
    expect(await isVisitAlreadyImported(t.travellog, actor, 'swarm-checkin-1')).toBe(false);

    await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'UTC',
      tzOffsetMinutes: 0,
      source: 'import:swarm',
      externalRef: 'swarm-checkin-1',
    });

    expect(await isVisitAlreadyImported(t.travellog, actor, 'swarm-checkin-1')).toBe(true);
  });

  it('does not match a manual/gps visit — externalRef is null, source differs', async () => {
    await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'UTC',
      tzOffsetMinutes: 0,
      source: 'manual',
    });
    expect(await isVisitAlreadyImported(t.travellog, actor, 'swarm-checkin-1')).toBe(false);
  });

  it('scopes to the tenant — another tenant importing the same externalRef does not count', async () => {
    await createVisit(t.travellog, { tenantId: 'tenant-2', userId: 'user-2' }, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'UTC',
      tzOffsetMinutes: 0,
      source: 'import:swarm',
      externalRef: 'swarm-checkin-1',
    });
    expect(await isVisitAlreadyImported(t.travellog, actor, 'swarm-checkin-1')).toBe(false);
  });
});

describe('addVisitPhoto (T.8)', () => {
  it('appends a photo with an increasing position, starting from an empty visit', async () => {
    const visit = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'UTC',
      tzOffsetMinutes: 0,
      source: 'import:swarm',
      externalRef: 'swarm-checkin-2',
    });

    await addVisitPhoto(t.travellog, visit.id, { storageKey: 'a.jpg', source: 'import' });
    await addVisitPhoto(t.travellog, visit.id, { storageKey: 'b.jpg', source: 'import' });

    const photos = await t.db
      .select()
      .from(schema.visitPhotos)
      .where(eq(schema.visitPhotos.visitId, visit.id))
      .orderBy(schema.visitPhotos.position);
    expect(photos.map((p) => p.storageKey)).toEqual(['a.jpg', 'b.jpg']);
    expect(must(photos[0], 'first').position).toBeLessThan(must(photos[1], 'second').position);
  });

  it('appends after photos already created alongside the visit', async () => {
    const visit = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'UTC',
      tzOffsetMinutes: 0,
      source: 'import:swarm',
      externalRef: 'swarm-checkin-3',
      photos: [{ storageKey: 'existing.jpg', source: 'upload' }],
    });

    await addVisitPhoto(t.travellog, visit.id, { storageKey: 'new.jpg', source: 'import' });

    const photos = await t.db
      .select()
      .from(schema.visitPhotos)
      .where(eq(schema.visitPhotos.visitId, visit.id))
      .orderBy(schema.visitPhotos.position);
    expect(photos.map((p) => p.storageKey)).toEqual(['existing.jpg', 'new.jpg']);
  });
});
