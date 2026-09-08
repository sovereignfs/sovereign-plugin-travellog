import Link from 'next/link';
import { Badge } from '@sovereignfs/ui';
import { daysBetweenDateKeys, formatDateRange } from '../_lib/dates';
import { plural } from '../_lib/format';
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

function metaLine(trip: TripCardData, todayKey: string): string {
  const stopsText = `${plural(trip.stopCount, 'stop')}`;
  if (trip.status === 'planning' || !trip.startDate || !trip.endDate) {
    return `Dates not set yet · ${stopsText} planned`;
  }

  const dateRange = formatDateRange(trip.startDate, trip.endDate);

  if (trip.status === 'ongoing') {
    const totalDays = daysBetweenDateKeys(trip.startDate, trip.endDate) + 1;
    const currentDay = Math.min(
      Math.max(daysBetweenDateKeys(trip.startDate, todayKey) + 1, 1),
      totalDays,
    );
    return `${dateRange} · day ${String(currentDay)} of ${String(totalDays)} · ${stopsText}`;
  }

  const dayCount = daysBetweenDateKeys(trip.startDate, trip.endDate) + 1;
  return `${dateRange} · ${plural(dayCount, 'day')} · ${stopsText}`;
}

/**
 * `docs/adhoc/web-trips.md`: the Ongoing card gets a filled CTA — "it's the
 * one action a user in the middle of a trip actually wants" — every other
 * status a plain text link, deliberately less visually loud. "Open Trip
 * Mode" navigates to the real Trip Mode screen (`T.19`,
 * `/travellog/planner/[tripId]/mode`) — not gated to mobile here the way
 * Planner's own entry point is: that screen renders at any width.
 *
 * Structure: the select target is a real `<button>` and the CTA a sibling
 * `<Link>` — never an interactive control nested inside a `role="button"`
 * (invalid ARIA; screen readers announced one control). The CTA is real
 * navigation, so it's a link (middle-click, copy address) styled as the
 * DS button rather than a `router.push` on a `<Button>`. Completed's CTA
 * ("View trip") opens the detail column, the closest destination that
 * exists while the full single-page trip view stays deferred (CONCEPT.md).
 */
export function TripCard({
  trip,
  todayKey,
  selected,
  onSelect,
}: {
  trip: TripCardData;
  todayKey: string;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const isOngoing = trip.status === 'ongoing';
  const href = isOngoing ? `/travellog/planner/${trip.id}/mode` : `/travellog/planner/${trip.id}`;

  return (
    <div
      className={[
        styles.card,
        isOngoing ? styles.cardOngoing : '',
        selected ? styles.cardSelected : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <button
        type="button"
        className={styles.selectTarget}
        aria-pressed={selected}
        aria-label={`${trip.name} — ${selected ? 'hide' : 'show'} details`}
        onClick={() => onSelect(trip.id)}
      >
        {/* Plain `mono` for every status, including Ongoing — the design
            system is deliberately monochrome (CLAUDE.md); the CTA's
            filled-vs-ghost split is the wireframe's stated primary signal. */}
        <Badge variant="mono" uppercase={false}>
          {STATUS_LABEL[trip.status]}
        </Badge>
        <h3 className={styles.name}>{trip.name}</h3>
        {trip.destinationSummary && <p className={styles.destination}>{trip.destinationSummary}</p>}
        <p className={styles.meta}>{metaLine(trip, todayKey)}</p>
        {trip.checkinCount > 0 && (
          <p className={styles.meta}>{plural(trip.checkinCount, 'check-in')} on this trip</p>
        )}
      </button>
      {trip.status === 'completed' ? (
        <button type="button" className={styles.ctaGhost} onClick={() => onSelect(trip.id)}>
          {CTA_LABEL[trip.status]} →
        </button>
      ) : (
        <Link href={href} className={isOngoing ? styles.ctaPrimary : styles.ctaGhost}>
          {CTA_LABEL[trip.status]} →
        </Link>
      )}
    </div>
  );
}
