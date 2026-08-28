import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  mapSwarmCheckin,
  offsetMinutesToIanaZone,
  readSwarmCheckins,
  SwarmExportFormatError,
  type SwarmCheckin,
} from '../swarm-import';

function zipOf(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    entries[name] = strToU8(content);
  }
  return zipSync(entries);
}

const SAMPLE_CHECKIN: SwarmCheckin = {
  id: 'checkin-1',
  createdAt: 1_700_000_000,
  timeZoneOffset: 60,
  shout: 'Great coffee',
  venue: {
    id: 'venue-1',
    name: 'Corvo Coffee Roasters',
    location: {
      lat: 38.7071,
      lng: -9.1355,
      address: 'Rua Example 1',
      city: 'Lisbon',
      state: undefined,
      country: 'Portugal',
      cc: 'pt',
      postalCode: '1000-001',
    },
    categories: [
      { name: 'Bar', primary: false },
      { name: 'Coffee Shop', shortName: 'Café', primary: true },
    ],
  },
  photos: { items: [{ prefix: 'https://img.example/', suffix: '/1.jpg' }] },
  with: [{ firstName: 'Ana', lastName: 'Silva' }, { firstName: '' }],
};

describe('readSwarmCheckins', () => {
  it('parses a bare-array checkins.json inside a real ZIP', () => {
    const zip = zipOf({ 'checkins.json': JSON.stringify([SAMPLE_CHECKIN]) });
    const checkins = readSwarmCheckins(zip);
    expect(checkins).toHaveLength(1);
    expect(checkins[0]?.id).toBe('checkin-1');
  });

  it('parses an {items: [...]} wrapper shape', () => {
    const zip = zipOf({ 'checkins.json': JSON.stringify({ items: [SAMPLE_CHECKIN] }) });
    expect(readSwarmCheckins(zip)).toHaveLength(1);
  });

  it('finds checkins.json nested inside a folder in the archive', () => {
    const zip = zipOf({ 'export/checkins.json': JSON.stringify([SAMPLE_CHECKIN]) });
    expect(readSwarmCheckins(zip)).toHaveLength(1);
  });

  it('throws SwarmExportFormatError for a non-ZIP file', () => {
    expect(() => readSwarmCheckins(new Uint8Array([1, 2, 3, 4]))).toThrow(SwarmExportFormatError);
  });

  it('throws for a ZIP with no checkins.json', () => {
    const zip = zipOf({ 'other.json': '{}' });
    expect(() => readSwarmCheckins(zip)).toThrow(/checkins\.json/);
  });

  it('throws for malformed JSON', () => {
    const zip = zipOf({ 'checkins.json': '{not json' });
    expect(() => readSwarmCheckins(zip)).toThrow(SwarmExportFormatError);
  });

  it('throws when checkins.json is neither an array nor {items: [...]}', () => {
    const zip = zipOf({ 'checkins.json': JSON.stringify({ foo: 'bar' }) });
    expect(() => readSwarmCheckins(zip)).toThrow(/expected format/);
  });
});

describe('offsetMinutesToIanaZone', () => {
  it('maps a positive whole-hour offset to the sign-inverted Etc/GMT zone', () => {
    expect(offsetMinutesToIanaZone(60)).toBe('Etc/GMT-1');
  });

  it('maps a negative whole-hour offset to the sign-inverted Etc/GMT zone', () => {
    expect(offsetMinutesToIanaZone(-300)).toBe('Etc/GMT+5');
  });

  it('maps zero to UTC', () => {
    expect(offsetMinutesToIanaZone(0)).toBe('UTC');
  });

  it('falls back to UTC for a non-whole-hour offset (e.g. India +5:30)', () => {
    expect(offsetMinutesToIanaZone(330)).toBe('UTC');
  });

  it('falls back to UTC for an out-of-range offset', () => {
    expect(offsetMinutesToIanaZone(20 * 60)).toBe('UTC');
  });

  it('produces a real, Intl-valid IANA zone for every whole-hour offset it maps', () => {
    for (let hours = -12; hours <= 14; hours++) {
      const zone = offsetMinutesToIanaZone(hours * 60);
      expect(() => new Intl.DateTimeFormat(undefined, { timeZone: zone })).not.toThrow();
    }
  });
});

describe('mapSwarmCheckin', () => {
  it('maps a well-formed checkin to place/visit fields', () => {
    const mapped = mapSwarmCheckin(SAMPLE_CHECKIN);
    expect(mapped).toMatchObject({
      externalRef: 'checkin-1',
      happenedAt: 1_700_000_000_000,
      tzIana: 'Etc/GMT-1',
      tzOffsetMinutes: 60,
      note: 'Great coffee',
      companions: ['Ana Silva'],
      photoUrls: ['https://img.example/500x500/1.jpg'],
      venueSourceRef: 'venue-1',
      venueName: 'Corvo Coffee Roasters',
      lat: 38.7071,
      lng: -9.1355,
      city: 'Lisbon',
      countryCode: 'PT',
      category: 'Café',
    });
  });

  it('reads photos from a bare-array shape too', () => {
    const mapped = mapSwarmCheckin({
      ...SAMPLE_CHECKIN,
      photos: [{ prefix: 'https://img.example/', suffix: '/2.jpg' }],
    });
    expect(mapped?.photoUrls).toEqual(['https://img.example/500x500/2.jpg']);
  });

  it('returns null for a checkin missing an id', () => {
    expect(mapSwarmCheckin({ ...SAMPLE_CHECKIN, id: undefined })).toBeNull();
  });

  it('returns null for a checkin missing a venue id', () => {
    expect(
      mapSwarmCheckin({ ...SAMPLE_CHECKIN, venue: { ...SAMPLE_CHECKIN.venue, id: undefined } }),
    ).toBeNull();
  });

  it('returns null for a checkin with no createdAt', () => {
    expect(mapSwarmCheckin({ ...SAMPLE_CHECKIN, createdAt: undefined })).toBeNull();
  });

  it('defaults tzOffsetMinutes to 0 (UTC) when absent, rather than throwing', () => {
    const mapped = mapSwarmCheckin({ ...SAMPLE_CHECKIN, timeZoneOffset: undefined });
    expect(mapped?.tzOffsetMinutes).toBe(0);
    expect(mapped?.tzIana).toBe('UTC');
  });

  it('has no note when shout is absent or blank', () => {
    expect(mapSwarmCheckin({ ...SAMPLE_CHECKIN, shout: undefined })?.note).toBeNull();
    expect(mapSwarmCheckin({ ...SAMPLE_CHECKIN, shout: '   ' })?.note).toBeNull();
  });

  it('drops a companion with no usable name', () => {
    const mapped = mapSwarmCheckin(SAMPLE_CHECKIN);
    expect(mapped?.companions).toEqual(['Ana Silva']);
  });

  it('picks the primary category, falling back to the first when none is marked primary', () => {
    expect(mapSwarmCheckin(SAMPLE_CHECKIN)?.category).toBe('Café');
    const noPrimary = mapSwarmCheckin({
      ...SAMPLE_CHECKIN,
      venue: {
        ...SAMPLE_CHECKIN.venue,
        categories: [{ name: 'Bar' }, { name: 'Coffee Shop' }],
      },
    });
    expect(noPrimary?.category).toBe('Bar');
  });

  it('has no category when the venue lists none', () => {
    expect(
      mapSwarmCheckin({ ...SAMPLE_CHECKIN, venue: { ...SAMPLE_CHECKIN.venue, categories: undefined } })
        ?.category,
    ).toBeNull();
  });
});
