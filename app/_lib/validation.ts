/**
 * Input validation shared by `../actions.ts` and the route handlers. A
 * server action is a public POST endpoint dispatched by action id — its
 * TypeScript parameter types are documentation, not enforcement, so every
 * value that reaches a write is re-checked here at runtime. Each check is a
 * pure predicate/normalizer returning a value the caller turns into a
 * `fail(...)` — nothing here throws.
 */
import { isValidDateKey } from './dates';

export const MAX_NAME_LENGTH = 200;
export const MAX_TITLE_LENGTH = 200;
export const MAX_NOTE_LENGTH = 5_000;
export const MAX_COMPANIONS = 50;
export const MAX_COMPANION_LENGTH = 100;
export const MAX_PHOTOS_PER_VISIT = 10;
/** A check-in is a record of something that happened — allow a day of clock skew, never the far future. */
export const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
/**
 * Earliest instant a live/backdated check-in may carry. Anything before
 * 1971 is a unit mix-up (a seconds value like `1_700_000_000` lands in
 * January 1970 when read as ms), not real history — Swarm imports bypass
 * this action-layer check entirely and carry their own converted instants.
 */
export const MIN_HAPPENED_AT_MS = Date.UTC(1971, 0, 1);

const PLANNED_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `"HH:mm"`, zero-padded, 24-hour — the only shape `plannedTime` string comparisons are correct for. */
export function isValidPlannedTime(value: unknown): value is string {
  return typeof value === 'string' && PLANNED_TIME_PATTERN.test(value);
}

export function isValidHappenedAt(value: unknown, now: number = Date.now()): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_HAPPENED_AT_MS &&
    value <= now + MAX_FUTURE_SKEW_MS
  );
}

/** A UTC offset in minutes, east-positive, within the real-world ±14h span. */
export function isValidTzOffsetMinutes(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= -14 * 60 && value <= 14 * 60
  );
}

export function isValidLatitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

/** A non-negative integer index (a reorder target) — `NaN`, floats, and negatives all fail. */
export function isValidIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

export function isOptionalString(
  value: unknown,
  maxLength: number,
): value is string | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.length <= maxLength)
  );
}

/**
 * A companions list: an array of trimmed, non-empty, de-duplicated names —
 * `null` when the input isn't that shape (a caller treats `null` as invalid
 * input, distinct from an empty array, which is a valid "nobody").
 */
export function normalizeCompanions(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > MAX_COMPANION_LENGTH) return null;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out.length > MAX_COMPANIONS ? null : out;
}

export function isValidDateKeyInput(value: unknown): value is string {
  return typeof value === 'string' && isValidDateKey(value);
}

/**
 * `sdk.storage` keys this plugin mints for a user are always
 * `<area>/<userId>/<nanoid>` (`upload-photo/route.ts`,
 * `attachments/upload/route.ts`). An action that accepts a client-supplied
 * key (`createVisitAction`'s `photos[]`, `createAttachmentAction`) must only
 * ever accept one from the caller's own area — otherwise any key a user
 * learns (another user's import ZIP, say) could be attached to their own
 * row and then signed for download or deleted through this plugin's own
 * `getSignedUrl`/`delete` calls.
 */
export function isOwnStorageKey(
  key: unknown,
  area: 'visits' | 'attachments',
  userId: string,
): key is string {
  if (typeof key !== 'string') return false;
  const prefix = `${area}/${userId}/`;
  if (!key.startsWith(prefix)) return false;
  const rest = key.slice(prefix.length);
  return rest.length > 0 && rest.length <= 64 && /^[A-Za-z0-9_-]+$/.test(rest);
}

export function isOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): value is T[number] {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}
