/**
 * The `msTimestamp` column reads a driver string back as a number — the
 * Postgres path (`int8` arrives as a digit string from node-postgres) that
 * every timestamp read used to break on. Exercised through Drizzle's own
 * column mapping so the test proves the schema, not a helper.
 */
import { describe, expect, it } from 'vitest';
import * as schema from '../schema';

describe('msTimestamp', () => {
  it('maps a string driver value to a number, and leaves a number alone', () => {
    const column = schema.visits.happenedAt;
    expect(column.mapFromDriverValue('1712345678901')).toBe(1712345678901);
    expect(column.mapFromDriverValue(1712345678901)).toBe(1712345678901);
    expect(column.getSQLType()).toBe('integer');
  });

  it('is used for every timestamp column across the schema', () => {
    const timestampColumns = [
      schema.places.createdAt,
      schema.visits.happenedAt,
      schema.visitPhotos.createdAt,
      schema.trips.updatedAt,
      schema.stops.createdAt,
      schema.tripDays.updatedAt,
      schema.itineraryItems.reminderSentAt,
      schema.attachments.createdAt,
      schema.importJobs.completedAt,
    ];
    for (const column of timestampColumns) {
      expect(column.mapFromDriverValue('42')).toBe(42);
    }
  });
});
