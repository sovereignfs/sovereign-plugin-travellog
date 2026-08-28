import { describe, expect, it } from 'vitest';
import { isValidIanaTimeZone } from '../timezone';

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
