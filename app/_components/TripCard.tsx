import { useRouter } from 'next/navigation';
import { Badge, Button } from '@sovereignfs/ui';
import { daysBetweenDateKeys, formatDateRange, todayDateKey } from '../_lib/dates';
import type { TripCard as TripCardData } from '../_lib/queries';
import styles from './TripCard.module.css';

const STATUS_LABEL: Record<TripCardData['status'], string> = {
  planning: 'Planning',
  upcoming: 'Upcoming',
  ongoing: 'Ongoing',
  completed: 'Completed',
};

/** "Continue planning" / "View itinerary" / "Open Trip Mode" / "View trip" — CONCEPT.md's Trips section. */
const CTA_LABEL: Record<TripCardData['status'], string> = {
  planning: 'Continue planning',
  upcoming: 'View itinerary',
  ongoing: 'Open Trip Mode',
  completed: 'View trip',
};

function metaLine(trip: TripCardData): string {
  if (trip.status === 'planning' || !trip.startDate || !trip.endDate) {
    return `Dates not set yet · ${String(trip.stopCount)} stop${trip.stopCount === 1 ? '' : 's'} planned`;
  }

  const dateRange = formatDateRange(trip.startDate, trip.endDate);
  const stopsText = `${String(trip.stopCount)} stop${trip.stopCount === 1 ? '' : 's'}`;

  if (trip.status === 'ongoing') {
    const totalDays = daysBetweenDateKeys(trip.startDate, trip.endDate) + 1;
    const currentDay = Math.min(
      Math.max(daysBetweenDateKeys(trip.startDate, todayDateKey()) + 1, 1),
      totalDays,
    );
    return `${dateRange} · day ${String(currentDay)} of ${String(totalDays)} · ${stopsText}`;
  }

  const dayCount = daysBetweenDateKeys(trip.startDate, trip.endDate) + 1;
  return `${dateRange} · ${String(dayCount)} day${dayCount === 1 ? '' : 's'} · ${stopsText}`;
}

/**
 * `docs/adhoc/web-trips.md`: the Ongoing card gets a filled CTA button
 * (`variant="primary"`, the default) — "it's the one action a user in the
 * middle of a trip actually wants" — every other status uses a plain text
 * link (`variant="ghost"`), deliberately less visually loud. "Open Trip
 * Mode" navigates to the real Trip Mode screen (`T.19`,
 * `/travellog/planner/[tripId]/mode`) — not gated to mobile here the way
 * Planner's own "Start Trip Mode" entry point is (`T.19`): that screen
 * renders correctly at any width (confirmed live during `T.19`'s own
 * verification), just without a dedicated design pass yet, and
 * `CONCEPT.md`'s Trips section names no separate desktop destination for
 * an ongoing trip's CTA to fall back to. `T.22` found this still pointed
 * at the plain Planner workspace — a real Trip Mode route didn't exist
 * when this shipped in `T.14`/`T.17`.
 *
 * Clicking the card body opens `T.14`'s detail column (`onSelect`) — the
 * CTA button is a nested, independently-clickable control, so its own click
 * handler stops propagation rather than also selecting the card underneath
 * it. Completed's CTA ("View trip") also just opens the detail column: the
 * full single-page trip view it more literally implies stays deferred
 * (CONCEPT.md), and the detail column is the closest real destination that
 * exists now — no longer `disabled`, since `T.14` (this task) is what its
 * old "Coming in T.14" placeholder was waiting for.
 */
export function TripCard({
  trip,
  selected,
  onSelect,
}: {
  trip: TripCardData;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const router = useRouter();
  const isOngoing = trip.status === 'ongoing';

  return (
    <div
      className={[styles.card, isOngoing ? styles.cardOngoing : '', selected ? styles.cardSelected : '']
        .filter(Boolean)
        .join(' ')}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(trip.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(trip.id);
        }
      }}
    >
      {/* Plain `mono` for every status, including Ongoing — the design
          system is deliberately monochrome (CLAUDE.md), and `Badge` has no
          "inverted/filled" variant to match the wireframe's illustrative
          dark-badge treatment for Ongoing. The CTA button's filled-vs-ghost
          split (below) is the wireframe's own stated primary signal for
          Ongoing's distinctiveness, not the badge. */}
      <Badge variant="mono" uppercase={false}>
        {STATUS_LABEL[trip.status]}
      </Badge>
      <h3 className={styles.name}>{trip.name}</h3>
      <p className={styles.meta}>{metaLine(trip)}</p>
      {trip.status === 'completed' ? (
        <Button
          variant="ghost"
          size="sm"
          className={styles.cta}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(trip.id);
          }}
        >
          {CTA_LABEL[trip.status]} →
        </Button>
      ) : (
        <Button
          variant={isOngoing ? 'primary' : 'ghost'}
          size="sm"
          className={styles.cta}
          onClick={(e) => {
            e.stopPropagation();
            router.push(
              isOngoing ? `/travellog/planner/${trip.id}/mode` : `/travellog/planner/${trip.id}`,
            );
          }}
        >
          {CTA_LABEL[trip.status]} →
        </Button>
      )}
    </div>
  );
}
