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
 * Mode" navigates to the Planner workspace here, not a real Trip Mode —
 * that surface is mobile-only and Slice-3-deferred (SPEC.md's Routes
 * section); web has no Trip Mode to open yet, so this is the closest real
 * destination until `T.15`/`T.16` ship.
 *
 * Clicking the card body itself (not the CTA) is deliberately **not**
 * wired to anything — that opens the detail column per CONCEPT.md, which
 * is `T.14`'s deliverable, not this one's.
 */
export function TripCard({ trip }: { trip: TripCardData }) {
  const router = useRouter();
  const isOngoing = trip.status === 'ongoing';

  return (
    <div className={[styles.card, isOngoing ? styles.cardOngoing : ''].filter(Boolean).join(' ')}>
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
        <Button variant="ghost" size="sm" disabled className={styles.cta} title="Coming in T.14">
          {CTA_LABEL[trip.status]} →
        </Button>
      ) : (
        <Button
          variant={isOngoing ? 'primary' : 'ghost'}
          size="sm"
          className={styles.cta}
          onClick={() => router.push(`/travellog/planner/${trip.id}`)}
        >
          {CTA_LABEL[trip.status]} →
        </Button>
      )}
    </div>
  );
}
