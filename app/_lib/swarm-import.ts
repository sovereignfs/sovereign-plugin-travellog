/**
 * Swarm export parsing and field mapping — isolated from the job handler
 * (`../_jobs/import-swarm.ts`) on purpose. `SPEC.md`'s `T.8` deliverable is
 * explicit that this mapping is the LEAST settled part of the whole task:
 * "the field list is inferred from third-party tooling and the public
 * Foursquare API shape, not from an actual export file" (CONCEPT.md open
 * question 5). Every field read below is defensive (optional-chained,
 * multiple shapes tolerated, `null`/`undefined` handled) so a checkin that
 * doesn't match this guess is skipped, not a thrown error that aborts the
 * whole import — and so that correcting the mapping later, once a real
 * export is inspected, is a change scoped to this one file.
 */
import { strFromU8, unzipSync } from 'fflate';

/**
 * Ceiling on `checkins.json`'s declared uncompressed size, checked
 * per-entry before inflate — same zip-bomb guard `runtime`'s portability
 * bundle reader (`readZip`) uses. A Swarm export is JSON text, not media,
 * so this is generous relative to what a genuine decade-of-checkins export
 * actually needs.
 */
export const MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024;

export interface SwarmCheckinPhoto {
  prefix?: string;
  suffix?: string;
}

export interface SwarmVenueCategory {
  name?: string;
  shortName?: string;
  primary?: boolean;
}

export interface SwarmVenueLocation {
  lat?: number;
  lng?: number;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  /** Foursquare's field name for the ISO country code — not `countryCode`. */
  cc?: string;
  postalCode?: string;
}

export interface SwarmVenue {
  id?: string;
  name?: string;
  location?: SwarmVenueLocation;
  categories?: SwarmVenueCategory[];
}

export interface SwarmCompanion {
  firstName?: string;
  lastName?: string;
}

/** The raw Foursquare-API-shaped checkin object a Swarm export's `checkins.json` is believed to contain. */
export interface SwarmCheckin {
  id?: string;
  /** Epoch SECONDS, not milliseconds — Foursquare/Swarm convention. */
  createdAt?: number;
  /** Minutes offset from UTC, east-positive — matches this plugin's own `tzOffsetMinutes` sign convention. */
  timeZoneOffset?: number;
  shout?: string;
  venue?: SwarmVenue;
  /** Two documented third-party shapes: a bare array, or `{items: [...]}`. */
  photos?: SwarmCheckinPhoto[] | { items?: SwarmCheckinPhoto[] };
  with?: SwarmCompanion[];
}

export class SwarmExportFormatError extends Error {}

/**
 * Unzips the export and returns `checkins.json`'s parsed content, loosely
 * typed — every field is re-validated defensively in `mapSwarmCheckin`,
 * not here. Throws `SwarmExportFormatError` for a corrupt archive, a
 * missing `checkins.json`, or a top-level shape that isn't an array (or
 * `{items: [...]}` — some third-party tooling wraps it).
 */
export function readSwarmCheckins(zipBytes: Uint8Array): SwarmCheckin[] {
  let totalDecompressed = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes, {
      filter(file) {
        totalDecompressed += file.originalSize;
        if (totalDecompressed > MAX_DECOMPRESSED_BYTES) {
          throw new SwarmExportFormatError(
            `Export exceeds the ${String(MAX_DECOMPRESSED_BYTES / (1024 * 1024))}MB decompressed size limit.`,
          );
        }
        return file.name.endsWith('checkins.json');
      },
    });
  } catch (err) {
    if (err instanceof SwarmExportFormatError) throw err;
    throw new SwarmExportFormatError(
      `Couldn't read this file as a ZIP archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const entryName = Object.keys(entries).find((name) => name.endsWith('checkins.json'));
  const entryBytes = entryName ? entries[entryName] : undefined;
  if (!entryBytes) {
    throw new SwarmExportFormatError('This export doesn’t include a checkins.json file.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(entryBytes));
  } catch (err) {
    throw new SwarmExportFormatError(
      `checkins.json isn’t valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { items?: unknown })?.items)
      ? (parsed as { items: unknown[] }).items
      : null;
  if (!items) {
    throw new SwarmExportFormatError(
      'checkins.json isn’t in the expected format (expected an array of check-ins).',
    );
  }
  return items as SwarmCheckin[];
}

/**
 * A whole-hour UTC offset has a precise, DST-free IANA equivalent in the
 * `Etc/GMT` family — note the inverted sign (POSIX convention: `Etc/GMT-5`
 * is UTC+5). Swarm's export carries only a numeric offset, never a zone
 * name, so this is the closest a check-in's local wall-clock time can be
 * displayed correctly without inventing a city. Falls back to `'UTC'` for
 * a non-whole-hour offset (e.g. India, Nepal) — `Etc/GMT` has no half- or
 * quarter-hour members — which is a known, accepted simplification: the
 * check-in's day-grouping and displayed time will be UTC's, not the
 * genuine local time, for the (globally rare) checkins from those zones.
 */
export function offsetMinutesToIanaZone(offsetMinutes: number): string {
  if (!Number.isFinite(offsetMinutes) || offsetMinutes % 60 !== 0) return 'UTC';
  const hours = offsetMinutes / 60;
  if (hours === 0) return 'UTC';
  if (hours < -12 || hours > 14) return 'UTC';
  const sign = hours > 0 ? '-' : '+';
  return `Etc/GMT${sign}${Math.abs(hours)}`;
}

function extractPhotoUrls(photos: SwarmCheckin['photos']): string[] {
  const items = Array.isArray(photos) ? photos : Array.isArray(photos?.items) ? photos.items : [];
  return items
    .filter((p): p is Required<SwarmCheckinPhoto> => Boolean(p?.prefix && p?.suffix))
    .map((p) => `${p.prefix}500x500${p.suffix}`);
}

function extractCompanions(withUsers: SwarmCheckin['with']): string[] {
  if (!Array.isArray(withUsers)) return [];
  return withUsers
    .map((u) => [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim())
    .filter((name) => name.length > 0);
}

function extractCategory(categories: SwarmVenueCategory[] | undefined): string | null {
  if (!Array.isArray(categories) || categories.length === 0) return null;
  const primary = categories.find((c) => c?.primary) ?? categories[0];
  return primary?.shortName ?? primary?.name ?? null;
}

export interface MappedSwarmCheckin {
  externalRef: string;
  /** Unix ms, UTC. */
  happenedAt: number;
  tzIana: string;
  tzOffsetMinutes: number;
  note: string | null;
  companions: string[];
  photoUrls: string[];
  venueSourceRef: string;
  venueName: string;
  lat: number | null;
  lng: number | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  countryCode: string | null;
  postalCode: string | null;
  category: string | null;
}

/**
 * `null` for a checkin missing the fields this import genuinely can't do
 * without (an id, a timestamp, and a venue with its own id/name) — skipped
 * by the job handler (logged, counted, never aborts the import), the same
 * "expected failure, not exceptional" posture as a 404'd photo.
 */
export function mapSwarmCheckin(raw: SwarmCheckin): MappedSwarmCheckin | null {
  const externalRef = raw.id;
  const createdAt = raw.createdAt;
  const venueSourceRef = raw.venue?.id;
  const venueName = raw.venue?.name;
  if (
    typeof externalRef !== 'string' ||
    externalRef.length === 0 ||
    typeof createdAt !== 'number' ||
    !Number.isFinite(createdAt) ||
    typeof venueSourceRef !== 'string' ||
    venueSourceRef.length === 0 ||
    typeof venueName !== 'string' ||
    venueName.length === 0
  ) {
    return null;
  }

  const tzOffsetMinutes =
    typeof raw.timeZoneOffset === 'number' && Number.isFinite(raw.timeZoneOffset)
      ? raw.timeZoneOffset
      : 0;
  const location = raw.venue?.location;

  return {
    externalRef,
    happenedAt: createdAt * 1000,
    tzIana: offsetMinutesToIanaZone(tzOffsetMinutes),
    tzOffsetMinutes,
    note: typeof raw.shout === 'string' && raw.shout.trim().length > 0 ? raw.shout.trim() : null,
    companions: extractCompanions(raw.with),
    photoUrls: extractPhotoUrls(raw.photos),
    venueSourceRef,
    venueName,
    lat: typeof location?.lat === 'number' ? location.lat : null,
    lng: typeof location?.lng === 'number' ? location.lng : null,
    address: location?.address ?? null,
    city: location?.city ?? null,
    state: location?.state ?? null,
    country: location?.country ?? null,
    countryCode: location?.cc ? location.cc.toUpperCase() : null,
    postalCode: location?.postalCode ?? null,
    category: extractCategory(raw.venue?.categories),
  };
}
