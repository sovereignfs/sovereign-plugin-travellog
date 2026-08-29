/**
 * Shared fake `sdk.crypto.seal`/`open` for tests (`T.24`, RFC 0092). Every
 * test file that exercises `_lib/visits.ts`/`queries.ts`/`portability.ts`
 * needs `sdk.crypto` mocked — those modules now call it directly (see
 * `crypto.ts`'s own header comment on why: `_lib` previously had zero
 * `@sovereignfs/sdk` dependency, so a bare `vi.mock('@sovereignfs/sdk', ...)`
 * with no `crypto` key leaves `sdk.crypto` `undefined`).
 *
 * Not a no-op passthrough deliberately: a passthrough can't distinguish
 * "seal() was called" from "seal() was forgotten" — both leave the value
 * unchanged, so a regression that drops a real `seal()` call would pass
 * silently. This wraps values in the *real* passthrough envelope format
 * (`svf0:`, from `packages/sdk/src/types.ts`'s `FIELD_PASSTHROUGH_PREFIX` —
 * copied as a literal here rather than imported, since importing it from
 * `@sovereignfs/sdk` in a file that also mocks that same specifier would
 * pull the mock instead of the real module), so a test can assert a
 * written row's classified column is *not* the raw plaintext, and that
 * `open()` correctly round-trips it back. Column classification is read via
 * the real `getFieldColumns` (`@sovereignfs/sdk/drizzle` — a separate
 * specifier from the mocked `@sovereignfs/sdk` barrel, so this import is
 * never itself mocked), so this stays correct if travellog classifies more
 * columns later.
 */
import { getFieldColumns } from '@sovereignfs/sdk/drizzle';

const FAKE_ENVELOPE_PREFIX = 'svf0:';

type Row = Record<string, unknown>;

function sealRow(table: object, row: Row): Row {
  const fields = getFieldColumns(table);
  const sealed: Row = { ...row };
  for (const field of fields) {
    if (field.meta.kind !== 'encrypted') continue;
    const value = row[field.key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.startsWith(FAKE_ENVELOPE_PREFIX)) continue; // idempotent
    sealed[field.key] = `${FAKE_ENVELOPE_PREFIX}${String(value)}`;
  }
  return sealed;
}

function openRow(table: object, row: Row): Row {
  const fields = getFieldColumns(table);
  const opened: Row = { ...row };
  for (const field of fields) {
    if (field.meta.kind !== 'encrypted') continue;
    const value = row[field.key];
    if (typeof value === 'string' && value.startsWith(FAKE_ENVELOPE_PREFIX)) {
      opened[field.key] = value.slice(FAKE_ENVELOPE_PREFIX.length);
    }
  }
  return opened;
}

export async function fakeSeal(table: object, rows: Row | Row[]): Promise<Row | Row[]> {
  return Array.isArray(rows) ? rows.map((r) => sealRow(table, r)) : sealRow(table, rows);
}

export async function fakeOpen(table: object, rows: Row | Row[]): Promise<Row | Row[]> {
  return Array.isArray(rows) ? rows.map((r) => openRow(table, r)) : openRow(table, rows);
}

export async function fakeRegisterTables(): Promise<void> {
  // No-op — the real registerTables() just persists metadata for operator
  // CLI tools, nothing a unit test needs to observe.
}
