'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { Button, EmptyState, Icon, PageContainer } from '@sovereignfs/ui';
import { getVisitDetailAction, getVisitTimelinePageAction, type VisitDetailView } from '../actions';
import { groupByDay } from '../_lib/day-grouping';
import type { TimelineVisit, VisitTimelineCursor, VisitTimelineFilter } from '../_lib/queries';
import { formatLocalTime, zoneAbbreviation } from '../_lib/timezone';
import { useTodayKey, useViewerTimeZone } from '../_lib/use-today-key';
import { CheckinDetailPanel } from './CheckinDetailPanel';
import styles from './CheckinsTimeline.module.css';
import { MainDetailSplit } from './MainDetailSplit';

/**
 * The day-grouped, reverse-chronological timeline (SPEC.md's Data fetching
 * contract payload 4) plus click-to-detail (payload 5). Creating a
 * check-in lives at `/travellog/checkin`; editing, deleting, and linking
 * happen in the detail column.
 *
 * `filter` narrows to one trip and/or one place; it's mirrored into the
 * URL (`?tripId=`/`?placeId=`) so a filtered view is linkable, and the
 * page remounts this component on a URL change (its `key`) so the first
 * page always comes pre-filtered from the server.
 */
export function CheckinsTimeline({
  initialItems,
  initialNextCursor,
  initialFilter,
  serverTodayKey,
}: {
  initialItems: TimelineVisit[];
  initialNextCursor: VisitTimelineCursor | null;
  initialFilter: VisitTimelineFilter;
  serverTodayKey: string;
}) {
  const router = useRouter();
  const todayKey = useTodayKey(serverTodayKey);
  const viewerZone = useViewerTimeZone();
  const [items, setItems] = useState(initialItems);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [loadingMore, startLoadMore] = useTransition();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<VisitDetailView | null>(null);
  const [detailLoading, startDetailLoad] = useTransition();
  // Guards against two quick selections resolving out of order — a slow
  // fetch for row A landing after row B's must never render A's detail
  // under B's selection.
  const latestRequestedId = useRef<string | null>(null);

  const filter = initialFilter;
  const hasFilter = Boolean(filter.tripId || filter.placeId);
  const filterLabel =
    filter.tripId && items[0]?.tripName
      ? `Trip: ${items[0].tripName}`
      : filter.placeId && items[0]?.placeName
        ? `Place: ${items[0].placeName}`
        : hasFilter
          ? 'Filtered'
          : null;

  function applyFilter(next: VisitTimelineFilter): void {
    const params = new URLSearchParams();
    if (next.tripId) params.set('tripId', next.tripId);
    if (next.placeId) params.set('placeId', next.placeId);
    const query = params.toString();
    router.replace(`/travellog/checkins${query ? `?${query}` : ''}`);
  }

  function selectVisit(id: string): void {
    setSelectedId(id);
    setDetail(null);
    latestRequestedId.current = id;
    startDetailLoad(async () => {
      const result = await getVisitDetailAction(id);
      if (latestRequestedId.current === id) setDetail(result);
    });
  }

  function closeDetail(): void {
    setSelectedId(null);
    latestRequestedId.current = null;
  }

  /** A targeted local update for the one row we know changed, then a refetch of the open panel. */
  function handleLinkChanged(tripId: string | null, tripName: string | null): void {
    if (!selectedId) return;
    setItems((prev) =>
      prev.map((item) => (item.id === selectedId ? { ...item, tripId, tripName } : item)),
    );
    selectVisit(selectedId);
  }

  function handleEdited(): void {
    if (!selectedId) return;
    selectVisit(selectedId);
    router.refresh();
  }

  function handleDeleted(): void {
    if (!selectedId) return;
    const id = selectedId;
    setItems((prev) => prev.filter((item) => item.id !== id));
    closeDetail();
    router.refresh();
  }

  function loadMore(): void {
    if (!nextCursor) return;
    const cursor = nextCursor;
    startLoadMore(async () => {
      const page = await getVisitTimelinePageAction(cursor, filter);
      setItems((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
    });
  }

  if (items.length === 0 && !hasFilter) {
    return (
      <EmptyState
        icon="map-pin"
        heading="Nothing checked in yet"
        description="Check in wherever you are, or bring in your history from Swarm to start with years of it already here."
        action={
          <div className={styles.emptyActions}>
            <Link href="/travellog/checkin" className={styles.emptyPrimary}>
              Check in now
            </Link>
            <Link href="/travellog/checkins/import" className={styles.emptyLink}>
              Import from Swarm
            </Link>
          </div>
        }
      />
    );
  }

  const groups = groupByDay(items, todayKey, Number(todayKey.slice(0, 4)));

  return (
    <MainDetailSplit
      detailLabel="Check-in details"
      onCloseDetail={closeDetail}
      list={
        <PageContainer maxWidth="full">
          <div className={styles.list}>
            {hasFilter && (
              <div className={styles.filterBar} role="status">
                <span className={styles.filterChip}>
                  <Icon name="sliders-horizontal" size="sm" aria-hidden={true} />
                  {filterLabel}
                </span>
                <button
                  type="button"
                  className={styles.filterClear}
                  onClick={() => applyFilter({})}
                >
                  Show all check-ins
                </button>
              </div>
            )}
            {items.length === 0 && (
              <p className={styles.noMatches}>No check-ins match this filter yet.</p>
            )}
            {groups.map((group) => (
              <div key={group.dateKey}>
                <div className={styles.dayHeader}>{group.label}</div>
                {group.items.map((item) => {
                  const showZone = viewerZone !== null && viewerZone !== item.tzIana;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={[styles.row, item.id === selectedId ? styles.rowActive : '']
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => selectVisit(item.id)}
                      aria-current={item.id === selectedId ? 'true' : undefined}
                    >
                      <span className={styles.rowGlyph}>
                        <Icon name="map-pin" size="sm" aria-hidden={true} />
                      </span>
                      <span className={styles.rowMain}>
                        <span className={styles.rowName}>{item.placeName}</span>
                        <span className={styles.rowMeta}>
                          {[
                            item.placeCategory,
                            `${formatLocalTime(item.happenedAt, item.tzIana)}${
                              showZone ? ` ${zoneAbbreviation(item.happenedAt, item.tzIana)}` : ''
                            }`,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      {item.tripId && (
                        <span className={styles.tripBadge} title={item.tripName ?? 'Trip'}>
                          <Icon name="luggage" size="sm" aria-hidden={true} />
                          {item.tripName ?? 'Trip'}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
            {nextCursor && (
              <Button
                variant="secondary"
                className={styles.loadMore}
                onClick={loadMore}
                loading={loadingMore}
              >
                Load more
              </Button>
            )}
          </div>
        </PageContainer>
      }
      detail={
        selectedId ? (
          <CheckinDetailPanel
            key={selectedId}
            detail={detail}
            loading={detailLoading}
            viewerZone={viewerZone}
            onClose={closeDetail}
            onLinkChanged={handleLinkChanged}
            onEdited={handleEdited}
            onDeleted={handleDeleted}
            onFilterByPlace={(placeId) => applyFilter({ placeId })}
            onFilterByTrip={(tripId) => applyFilter({ tripId })}
          />
        ) : null
      }
    />
  );
}
