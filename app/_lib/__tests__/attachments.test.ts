import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../_db/__tests__/test-db';
import { createTrip } from '../trips';
import {
  createAttachment,
  deleteAttachment,
  InvalidAttachmentTargetError,
  validateAttachmentTarget,
} from '../attachments';

describe('validateAttachmentTarget (T.10 review checklist)', () => {
  it('accepts a trip-level attachment', () => {
    expect(() => validateAttachmentTarget({ tripId: 'trip-1', tripDayId: null })).not.toThrow();
  });

  it('accepts a day-level attachment', () => {
    expect(() => validateAttachmentTarget({ tripId: null, tripDayId: 'day-1' })).not.toThrow();
  });

  it('rejects neither set', () => {
    expect(() => validateAttachmentTarget({ tripId: null, tripDayId: null })).toThrow(
      InvalidAttachmentTargetError,
    );
  });

  it('rejects neither set — undefined counts the same as null', () => {
    expect(() => validateAttachmentTarget({})).toThrow(InvalidAttachmentTargetError);
  });

  it('rejects both set', () => {
    expect(() => validateAttachmentTarget({ tripId: 'trip-1', tripDayId: 'day-1' })).toThrow(
      InvalidAttachmentTargetError,
    );
  });
});

const actor = { tenantId: 'tenant-1', userId: 'user-1' };

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});

afterEach(() => {
  t.close();
});

describe('createAttachment', () => {
  it('creates a trip-level attachment', async () => {
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    const attachment = await createAttachment(t.travellog, actor, {
      tripId: trip.id,
      kind: 'booking',
      title: 'Flight confirmation',
      storageKey: 'attachments/flight.pdf',
    });
    expect(attachment.tripId).toBe(trip.id);
    expect(attachment.tripDayId).toBeNull();
    expect(attachment.createdBy).toBe(actor.userId);
  });

  it('rejects a target with neither tripId nor tripDayId, writing nothing', async () => {
    await expect(
      createAttachment(t.travellog, actor, {
        kind: 'receipt',
        title: 'Dinner',
        storageKey: 'attachments/dinner.pdf',
      }),
    ).rejects.toThrow(InvalidAttachmentTargetError);
  });
});

describe('deleteAttachment', () => {
  it('removes the row and returns it (so the caller can delete the storage object too)', async () => {
    const trip = await createTrip(t.travellog, actor, 'Portugal 2026');
    const attachment = await createAttachment(t.travellog, actor, {
      tripId: trip.id,
      kind: 'receipt',
      title: 'Hotel receipt',
      storageKey: 'attachments/hotel.pdf',
    });

    const deleted = await deleteAttachment(t.travellog, attachment.id);
    expect(deleted?.storageKey).toBe('attachments/hotel.pdf');
    expect(await deleteAttachment(t.travellog, attachment.id)).toBeNull();
  });

  it('returns null for a non-existent attachment instead of throwing', async () => {
    expect(await deleteAttachment(t.travellog, 'no-such-attachment')).toBeNull();
  });
});
