'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, EmptyState, Input, PageContainer, SegmentedControl } from '@sovereignfs/ui';
import { compareDateKeys, daysBetweenDateKeys } from '../_lib/dates';
import { plural } from '../_lib/format';
import type { TripCard as TripCardData, TripsOverview } from '../_lib/queries';
import { resolveTripStatus, type TripStatus } from '../_lib/trip-status';
import { useTodayKey } from '../_lib/use-today-key';
import { CreateTripDialog } from './CreateTripDialog';
import { MainDetailSplit } from './MainDetailSplit';
import { TripCard } from './TripCard';
import { TripDetailPanel } from './TripDetailPanel';
import styles from './TripsScreen.module.css';

type StatusFilter = 'all' | TripStatus;

const STATUS_GROUP_ORDER: TripStatus[] = ['planning', 'upcoming', 'ongoing', 'completed'];
const STATUS_GROUP_LABEL: Record<TripStatus, string> = {
  planning: 'Planning',
  upcoming: 'Upcoming',
  ongoing: 'Ongoing',
  completed: 'Completed',
};
const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
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
 * The Trips screen body — `docs/adhoc/web-trips.md` screens 1/2/3/4 (`T.13`
 * built 1/2/4; `T.14` adds screen 3, the click-to-detail column). Filtering
 * is entirely client-side over one already-fetched page (the wireframe's
 * own call: a personal trip list is small and bounded, unlike check-in
 * history) — the same fetched `cards` array backs both the grid and the
 * detail column, so selecting a trip needs no second round trip.
 *
 * Status is re-derived here from each card's dates and the viewer's local
 * "today" (`useTodayKey`): the server's UTC guess put a trip that starts
 * today under "Upcoming" until the afternoon for anyone east of UTC.
 * `cards` re-syncs from the server prop after every `router.refresh()`
 * (rename, delete) rather than living only in `useState`'s first value.
 */
export function TripsScreen({
  overview,
  cards: cardsProp,
  serverTodayKey,
}: {
  overview: TripsOverview;
  cards: TripCardData[];
  serverTodayKey: string;
}) {
  const router = useRouter();
  const todayKey = useTodayKey(serverTodayKey);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [cards, setCards] = useState(cardsProp);
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);

  useEffect(() => {
    setCards(cardsProp);
  }, [cardsProp]);

  const localized = useMemo(
    () =>
      cards.map((card) => ({
        ...card,
        status: resolveTripStatus(
          { hasStops: card.stopCount > 0, startDate: card.startDate, endDate: card.endDate },
          todayKey,
        ),
      })),
    [cards, todayKey],
  );

  const selectedTrip = selectedTripId
    ? (localized.find((c) => c.id === selectedTripId) ?? null)
    : null;

  function handleTripChange(
    tripId: string,
    patch: Partial<Pick<TripCardData, 'companions' | 'name'>>,
  ): void {
    setCards((prev) => prev.map((c) => (c.id === tripId ? { ...c, ...patch } : c)));
  }

  function handleTripDeleted(tripId: string): void {
    setCards((prev) => prev.filter((c) => c.id !== tripId));
    setSelectedTripId(null);
    router.refresh();
  }

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return localized.filter((card) => {
      if (statusFilter !== 'all' && card.status !== statusFilter) return false;
      if (query && !card.name.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [localized, statusFilter, search]);

  const groups = useMemo(
    () =>
      STATUS_GROUP_ORDER.map((status) => ({
        status,
        cards: sortWithinGroup(
          status,
          filtered.filter((c) => c.status === status),
        ),
      })).filter((group) => group.cards.length > 0),
    [filtered],
  );

  const nextTrip = useMemo(() => {
    let best: { id: string; name: string; daysUntil: number } | null = null;
    for (const card of localized) {
      if (card.status !== 'upcoming' || !card.startDate) continue;
      const daysUntil = daysBetweenDateKeys(todayKey, card.startDate);
      if (!best || daysUntil < best.daysUntil) best = { id: card.id, name: card.name, daysUntil };
    }
    return best;
  }, [localized, todayKey]);

  const overviewTiles = (
    <div className={styles.overview}>
      <div className={styles.tile}>
        <span className={styles.tileValue}>{localized.length}</span>
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
      {nextTrip && (
        <div className={[styles.tile, styles.tileNext].join(' ')}>
          <span className={styles.tileNextLabel}>Next trip</span>
          <span className={styles.tileLabel}>
            {nextTrip.name}{' '}
            {nextTrip.daysUntil === 0 ? 'starts today' : `in ${plural(nextTrip.daysUntil, 'day')}`}
          </span>
        </div>
      )}
    </div>
  );

  if (cards.length === 0) {
    return (
      <PageContainer maxWidth="full">
        <div className={styles.screen}>
          {overview.totalCheckins > 0 && overviewTiles}
          <EmptyState
            icon="luggage"
            heading="No trips yet"
            description="Planning a trip? Start here — you can add stops and dates as you go."
            action={<Button onClick={() => setCreateOpen(true)}>Plan your first trip</Button>}
          />
        </div>
        <CreateTripDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      </PageContainer>
    );
  }

  function selectTrip(id: string): void {
    setSelectedTripId((prev) => (prev === id ? null : id));
  }

  return (
    <>
      <MainDetailSplit
        detailLabel="Trip details"
        onCloseDetail={() => setSelectedTripId(null)}
        list={
          <PageContainer maxWidth="full">
            <div className={styles.screen}>
              <div className={styles.header}>
                <Button onClick={() => setCreateOpen(true)}>New trip</Button>
              </div>

              {overviewTiles}

              <div className={styles.filters}>
                <SegmentedControl
                  aria-label="Filter by status"
                  size="sm"
                  value={statusFilter}
                  onChange={setStatusFilter}
                  options={STATUS_OPTIONS}
                />
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
                          <TripCard
                            key={card.id}
                            trip={card}
                            todayKey={todayKey}
                            selected={card.id === selectedTripId}
                            onSelect={selectTrip}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </PageContainer>
        }
        detail={
          selectedTrip ? (
            <TripDetailPanel
              key={selectedTrip.id}
              trip={selectedTrip}
              onClose={() => setSelectedTripId(null)}
              onTripChange={handleTripChange}
              onDeleted={handleTripDeleted}
            />
          ) : null
        }
      />
      <CreateTripDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}
