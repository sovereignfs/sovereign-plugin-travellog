'use client';

import { useMemo, useState } from 'react';
import { Button, EmptyState, Input } from '@sovereignfs/ui';
import type { TripCard as TripCardData, TripsOverview } from '../_lib/queries';
import type { TripStatus } from '../_lib/trip-status';
import { compareDateKeys } from '../_lib/dates';
import { CreateTripDialog } from './CreateTripDialog';
import { TripCard } from './TripCard';
import styles from './TripsScreen.module.css';

type StatusFilter = 'all' | TripStatus;

const STATUS_GROUP_ORDER: TripStatus[] = ['planning', 'upcoming', 'ongoing', 'completed'];
const STATUS_GROUP_LABEL: Record<TripStatus, string> = {
  planning: 'Planning',
  upcoming: 'Upcoming',
  ongoing: 'Ongoing',
  completed: 'Completed',
};
const STATUS_CHIPS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'planning', label: 'Planning' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'ongoing', label: 'Ongoing' },
  { value: 'completed', label: 'Completed' },
];

/** Within a group: soonest-first for planning/upcoming/ongoing (planning has no dates, so falls back to name); most-recently-completed-first for completed. */
function sortWithinGroup(status: TripStatus, cards: TripCardData[]): TripCardData[] {
  const sorted = [...cards];
  if (status === 'completed') {
    sorted.sort((a, b) => compareDateKeys(b.endDate ?? '', a.endDate ?? ''));
  } else {
    sorted.sort((a, b) => {
      if (a.startDate && b.startDate) return compareDateKeys(a.startDate, b.startDate);
      if (a.startDate) return -1;
      if (b.startDate) return 1;
      return a.name.localeCompare(b.name);
    });
  }
  return sorted;
}

/**
 * `T.13`'s Trips screen body — `docs/adhoc/web-trips.md` screens 1/2/4.
 * Filtering is entirely client-side over one already-fetched page (the
 * wireframe's own call: a personal trip list is small and bounded, unlike
 * check-in history). No card-click-to-detail here — that's `T.14`'s
 * "Detail column (payload 3)" deliverable, not this task's.
 */
export function TripsScreen({ overview, cards }: { overview: TripsOverview; cards: TripCardData[] }) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return cards.filter((card) => {
      if (statusFilter !== 'all' && card.status !== statusFilter) return false;
      if (query && !card.name.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [cards, statusFilter, search]);

  const groups = useMemo(() => {
    return STATUS_GROUP_ORDER.map((status) => ({
      status,
      cards: sortWithinGroup(
        status,
        filtered.filter((c) => c.status === status),
      ),
    })).filter((group) => group.cards.length > 0);
  }, [filtered]);

  const totalTrips =
    overview.tripCounts.planning +
    overview.tripCounts.upcoming +
    overview.tripCounts.ongoing +
    overview.tripCounts.completed;

  if (cards.length === 0) {
    return (
      <>
        <EmptyState
          icon="luggage"
          heading="No trips yet"
          description="Planning a trip? Start here — you can add stops and dates as you go."
          action={<Button onClick={() => setCreateOpen(true)}>Plan your first trip</Button>}
        />
        <CreateTripDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      </>
    );
  }

  return (
    <div className={styles.screen}>
      <div className={styles.header}>
        <Button onClick={() => setCreateOpen(true)}>New trip</Button>
      </div>

      <div className={styles.overview}>
        <div className={styles.tile}>
          <span className={styles.tileValue}>{totalTrips}</span>
          <span className={styles.tileLabel}>trips</span>
        </div>
        <div className={styles.tile}>
          <span className={styles.tileValue}>{overview.uniquePlaceCount}</span>
          <span className={styles.tileLabel}>places visited</span>
        </div>
        <div className={styles.tile}>
          <span className={styles.tileValue}>{overview.uniqueCountryCount}</span>
          <span className={styles.tileLabel}>countries visited</span>
        </div>
        <div className={styles.tile}>
          <span className={styles.tileValue}>{overview.totalCheckins}</span>
          <span className={styles.tileLabel}>check-ins</span>
        </div>
        {overview.nextTrip && (
          <div className={[styles.tile, styles.tileNext].join(' ')}>
            <span className={styles.tileNextLabel}>Next trip</span>
            <span className={styles.tileLabel}>
              {overview.nextTrip.name} in {overview.nextTrip.daysUntil}{' '}
              day{overview.nextTrip.daysUntil === 1 ? '' : 's'}
            </span>
          </div>
        )}
      </div>

      <div className={styles.filters}>
        <div className={styles.chips} role="radiogroup" aria-label="Filter by status">
          {STATUS_CHIPS.map((chip) => (
            <button
              key={chip.value}
              type="button"
              role="radio"
              aria-checked={statusFilter === chip.value}
              className={[styles.chip, statusFilter === chip.value ? styles.chipActive : ''].join(' ')}
              onClick={() => setStatusFilter(chip.value)}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <Input
          type="search"
          placeholder="Search trips…"
          aria-label="Search trips"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={styles.search}
        />
      </div>

      {groups.length === 0 ? (
        <p className={styles.noMatches}>No trips match your filters.</p>
      ) : (
        <div className={styles.groups}>
          {groups.map((group) => (
            <div key={group.status}>
              <div className={styles.groupHeader}>
                <span>{STATUS_GROUP_LABEL[group.status]}</span>
                <span className={styles.groupCount}>{group.cards.length}</span>
              </div>
              <div className={styles.cardGrid}>
                {group.cards.map((card) => (
                  <TripCard key={card.id} trip={card} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <CreateTripDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
