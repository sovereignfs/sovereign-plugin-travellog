import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../_db/__tests__/test-db';
import { createPlace } from '../places';
import { createVisit } from '../visits';
import { getVisitDetail, getVisitTimelinePage, VISIT_TIMELINE_PAGE_SIZE } from '../queries';

const actor = { tenantId: 'tenant-1', userId: 'user-1' };
const otherUserSameTenant = { tenantId: 'tenant-1', userId: 'user-2' };

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

describe('getVisitTimelinePage', () => {
  it('is reverse-chronological', async () => {
    const earlier = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.UTC(2026, 7, 25),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });
    const later = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.UTC(2026, 7, 27),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });

    const page = await getVisitTimelinePage(t.travellog, actor);
    expect(page.items.map((i) => i.id)).toEqual([later.id, earlier.id]);
  });

  it('has no next cursor when the page is smaller than the page size', async () => {
    await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });

    const page = await getVisitTimelinePage(t.travellog, actor);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it('paginates via a (happenedAt, id) cursor with no gaps or duplicates across pages', async () => {
    // Two visits sharing the exact same millisecond timestamp — the id
    // tie-breaker is what a plain happenedAt-only cursor would get wrong.
    const sameInstant = Date.UTC(2026, 7, 27, 12, 0, 0);
    const created = [];
    for (let i = 0; i < VISIT_TIMELINE_PAGE_SIZE + 5; i++) {
      created.push(
        await createVisit(t.travellog, actor, {
          placeId,
          happenedAt: i < 2 ? sameInstant : sameInstant - i * 1000,
          tzIana: 'Europe/Lisbon',
          tzOffsetMinutes: 60,
          source: 'manual',
        }),
      );
    }

    const firstPage = await getVisitTimelinePage(t.travellog, actor);
    expect(firstPage.items).toHaveLength(VISIT_TIMELINE_PAGE_SIZE);
    const cursor = firstPage.nextCursor;
    if (!cursor) throw new Error('expected a next cursor');

    const secondPage = await getVisitTimelinePage(t.travellog, actor, cursor);
    expect(secondPage.items.length).toBeGreaterThan(0);

    const firstIds = new Set(firstPage.items.map((i) => i.id));
    const overlap = secondPage.items.filter((i) => firstIds.has(i.id));
    expect(overlap).toHaveLength(0);

    const totalSeen = firstPage.items.length + secondPage.items.length;
    expect(totalSeen).toBeLessThanOrEqual(created.length);
  });

  it('only returns the calling user’s own visits, even within the same tenant', async () => {
    await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });
    await createVisit(t.travellog, otherUserSameTenant, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });

    const page = await getVisitTimelinePage(t.travellog, actor);
    expect(page.items).toHaveLength(1);
  });

  it('includes the place name/category and a note excerpt', async () => {
    await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      note: 'A short note',
      source: 'manual',
    });

    const page = await getVisitTimelinePage(t.travellog, actor);
    expect(page.items[0]).toMatchObject({ placeName: 'Belém Tower', noteExcerpt: 'A short note' });
  });

  it('surfaces the first photo by position, not insertion order', async () => {
    await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
      photos: [
        { storageKey: 'first.jpg', source: 'upload' },
        { storageKey: 'second.jpg', source: 'upload' },
      ],
    });

    const page = await getVisitTimelinePage(t.travellog, actor);
    expect(page.items[0]?.firstPhotoStorageKey).toBe('first.jpg');
  });
});

describe('getVisitDetail', () => {
  it('reading someone else’s visit is impossible — same tenant, different user', async () => {
    const theirs = await createVisit(t.travellog, otherUserSameTenant, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });

    expect(await getVisitDetail(t.travellog, actor, theirs.id)).toBeNull();
    expect(await getVisitDetail(t.travellog, otherUserSameTenant, theirs.id)).not.toBeNull();
  });

  it('returns null for a non-existent visit — not an error', async () => {
    expect(await getVisitDetail(t.travellog, actor, 'no-such-visit')).toBeNull();
  });

  it('returns full detail: place, companions, ordered photos', async () => {
    const visit = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      note: 'Full note text',
      companions: ['Tom Kelly'],
      source: 'manual',
      photos: [
        { storageKey: 'a.jpg', source: 'upload' },
        { storageKey: 'b.jpg', source: 'upload' },
      ],
    });

    const detail = await getVisitDetail(t.travellog, actor, visit.id);
    expect(detail).toMatchObject({
      note: 'Full note text',
      companions: ['Tom Kelly'],
      place: { name: 'Belém Tower' },
    });
    expect(detail?.photos.map((p) => p.storageKey)).toEqual(['a.jpg', 'b.jpg']);
  });

  it('placeVisitCount (T.9, CONCEPT.md per-place visit counts) counts every visit the caller logged at that place, including this one', async () => {
    const first = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now() - 1000,
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });
    expect((await getVisitDetail(t.travellog, actor, first.id))?.placeVisitCount).toBe(1);

    const second = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });

    // Both visits at the same place now report the full count, not just "so far."
    expect((await getVisitDetail(t.travellog, actor, first.id))?.placeVisitCount).toBe(2);
    expect((await getVisitDetail(t.travellog, actor, second.id))?.placeVisitCount).toBe(2);
  });

  it('placeVisitCount is scoped to the caller — a same-tenant user’s visits to the same place never count toward another user’s total', async () => {
    const mine = await createVisit(t.travellog, actor, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });
    await createVisit(t.travellog, otherUserSameTenant, {
      placeId,
      happenedAt: Date.now(),
      tzIana: 'Europe/Lisbon',
      tzOffsetMinutes: 60,
      source: 'manual',
    });

    expect((await getVisitDetail(t.travellog, actor, mine.id))?.placeVisitCount).toBe(1);
  });
});
