import { describe, expect, it } from 'vitest';
import { isValidIanaTimeZone, localTimeOfDay } from '../timezone';

describe('isValidIanaTimeZone', () => {
  it('accepts real IANA zones, including a half-hour-offset one', () => {
    expect(isValidIanaTimeZone('America/New_York')).toBe(true);
    expect(isValidIanaTimeZone('Europe/Lisbon')).toBe(true);
    expect(isValidIanaTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidIanaTimeZone('UTC')).toBe(true);
  });

  it('rejects garbage input without throwing', () => {
    expect(isValidIanaTimeZone('')).toBe(false);
    expect(isValidIanaTimeZone('   ')).toBe(false);
    expect(isValidIanaTimeZone('Not/A_Zone')).toBe(false);
    expect(isValidIanaTimeZone('America/NewYork')).toBe(false); // real zone uses an underscore
  });
});

describe('localTimeOfDay (T.18)', () => {
  it('formats as zero-padded 24-hour "HH:mm", never 12-hour or AM/PM', () => {
    expect(localTimeOfDay(Date.parse('2026-06-15T08:05:00Z'), 'UTC')).toBe('08:05');
    expect(localTimeOfDay(Date.parse('2026-06-15T00:00:00Z'), 'UTC')).toBe('00:00');
    expect(localTimeOfDay(Date.parse('2026-06-15T23:59:00Z'), 'UTC')).toBe('23:59');
  });

  it('reflects the given zone’s offset, not UTC', () => {
    // Europe/Lisbon is UTC+1 in June (WEST).
    expect(localTimeOfDay(Date.parse('2026-06-15T08:05:00Z'), 'Europe/Lisbon')).toBe('09:05');
    // Pacific/Kiritimati is UTC+14 year-round.
    expect(localTimeOfDay(Date.parse('2026-06-15T00:05:00Z'), 'Pacific/Kiritimati')).toBe('14:05');
  });

  it('two "HH:mm" strings from the same local day compare lexicographically as chronological order', () => {
    const earlier = localTimeOfDay(Date.parse('2026-06-15T08:00:00Z'), 'UTC');
    const later = localTimeOfDay(Date.parse('2026-06-15T13:00:00Z'), 'UTC');
    expect(earlier < later).toBe(true);
  });
});
