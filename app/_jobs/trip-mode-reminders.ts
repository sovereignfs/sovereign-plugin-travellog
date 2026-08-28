/**
 * `T.20` — "Your next stop is in 20 minutes." Manifest-declared `schedules`
 * handler (RFC 0046 Phase 1), ticking every minute. Deliberately thin
 * orchestration, same charter as `./import-swarm.ts`'s own header comment:
 * the real logic — which stops are candidates, what "today" and "next"
 * mean for one — already lives in `_lib/trip-mode.ts`, reused as-is from
 * `T.18`/`T.19`; this file's only job is wiring that up to a timezone
 * source and a notification send.
 *
 * The lead time is a plain constant, not a manifest `env` var, despite
 * `NOMINATIM_BASE_URL`'s precedent for exactly that pattern elsewhere in
 * this plugin — `sdk.env.get()` calls `next/headers()` with no fallback for
 * a background invocation, so it throws outright from a `schedules`
 * handler instead of returning `null` (the same bug class `sdk.storage.*`
 * had before this session's earlier platform fix; flagged as a follow-up,
 * not fixed here — see the platform repo). Declaring an env var that
 * silently can never be read would be worse than not offering one.
 */
import { sdk, type ScheduleContext } from '@sovereignfs/sdk';
import type { TravellogDb } from '../_db/client';
import { resolveTimezoneFromCoords } from '../_lib/geo-timezone';
import { claimReminderForItem } from '../_lib/itinerary-items';
import { formatCountdown, listReminderCandidateStops, resolveTripModeToday } from '../_lib/trip-mode';

const REMINDER_LEAD_MINUTES = 20;

/**
 * `now` defaults to `Date.now()` — an injectable parameter rather than
 * reading the clock internally, same discipline `_lib/trip-mode.ts`'s own
 * header established for `resolveTripModeToday`, and what makes this
 * handler deterministically testable. Still satisfies the real
 * `ScheduleHandler` contract (`(ctx: ScheduleContext) => Promise<void>`):
 * the platform's scheduler calls this with one argument, so `now` always
 * falls back to the real clock in production.
 */
export default async function tripModeReminders(ctx: ScheduleContext, now: number = Date.now()): Promise<void> {
  const db = (await sdk.db.getClient()) as TravellogDb;

  const candidates = await listReminderCandidateStops(db, now);

  for (const stop of candidates) {
    const tzIana = resolveTimezoneFromCoords(stop.placeLat, stop.placeLng);
    if (!tzIana) continue; // No coordinates to derive a zone from — never guess (this file's own header).

    const today = await resolveTripModeToday(db, stop.stopId, now, tzIana);
    if (!today?.nextItem || today.countdownMinutes === null) continue;
    if (today.countdownMinutes > REMINDER_LEAD_MINUTES) continue;

    const claimed = await claimReminderForItem(db, today.nextItem.id, now);
    if (!claimed) continue; // Already reminded (this tick or an earlier one) — fire once per item, not once per tick.

    const itemName = today.nextItem.placeName ?? today.nextItem.title ?? 'your next stop';
    await sdk.notifications.send(
      {
        recipientUserId: stop.tripOwnerId,
        title: `${itemName} in ${formatCountdown(today.countdownMinutes)}`,
        body: today.nextItem.plannedTime ? `Planned for ${today.nextItem.plannedTime}.` : undefined,
        url: `/travellog/planner/${stop.tripId}/mode`,
        category: 'info',
      },
      ctx.headers,
    );
  }
}
