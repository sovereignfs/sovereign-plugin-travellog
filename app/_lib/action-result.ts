/**
 * Platform server-action result convention (see the Console plugin's
 * `settings/actions.ts` and the sv-ui-design error-handling rules): actions
 * never throw domain errors at the client — they return a discriminated
 * result the form/caller renders. Same shape as
 * `sovereign-plugin-kanban`'s `_lib/action-result.ts`.
 */
export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

export function ok(message?: string): ActionResult {
  return { ok: true, message };
}

export function fail(error: string): ActionResult {
  return { ok: false, error };
}
