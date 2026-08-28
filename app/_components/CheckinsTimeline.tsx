'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button, EmptyState, Icon } from '@sovereignfs/ui';
import { getVisitDetailAction, getVisitTimelinePageAction, type VisitDetailView } from '../actions';
import { groupByDay } from '../_lib/day-grouping';
import type { TimelineVisit, VisitTimelineCursor } from '../_lib/queries';
import { formatLocalTime } from '../_lib/timezone';
import { CheckinDetailPanel } from './CheckinDetailPanel';
import styles from './CheckinsTimeline.module.css';
import { MainDetailSplit } from './MainDetailSplit';

/**
 * The day-grouped, reverse-chronological timeline (SPEC.md's Data fetching
 * contract payload 4) plus click-to-detail (payload 5). Web is view-only —
 * no check-in creation here (`T.7`, mobile). All read-side: nothing here
 * mutates.
 */
export function CheckinsTimeline({
  initialItems,
  initialNextCursor,
}: {
  initialItems: TimelineVisit[];
  initialNextCursor: VisitTimelineCursor | null;
}) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [loadingMore, startLoadMore] = useTransition();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<VisitDetailView | null>(null);
  const [detailLoading, startDetailLoad] = useTransition();

  if (items.length === 0) {
    return (
      <EmptyState
        icon="map-pin"
        heading="Nothing checked in yet"
        description="Check in from your phone as you go, or bring in your history from Swarm to start with years of it already here."
        action={
          <div className={styles.emptyActions}>
            <Button onClick={() => router.push('/travellog/checkins/import')}>Import data</Button>
            <span className={styles.emptyHint}>Or check in from the Sovereign mobile app</span>
          </div>
        }
      />
    );
  }

  function selectVisit(id: string): void {
    setSelectedId(id);
    setDetail(null);
    startDetailLoad(async () => {
      const result = await getVisitDetailAction(id);
      setDetail(result);
    });
  }

  /**
   * Refetches the open detail panel after an unlink (`T.12`) and clears
   * that same row's trip badge in the already-loaded timeline list — a
   * targeted local update rather than reloading the whole page, since this
   * is the one row we know changed.
   */
  function handleUnlinked(): void {
    if (!selectedId) return;
    setItems((prev) => prev.map((item) => (item.id === selectedId ? { ...item, tripId: null } : item)));
    selectVisit(selectedId);
  }

  function loadMore(): void {
    if (!nextCursor) return;
    const cursor = nextCursor;
    startLoadMore(async () => {
      const page = await getVisitTimelinePageAction(cursor);
      setItems((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
    });
  }

  const groups = groupByDay(items, Date.now());

  return (
    <MainDetailSplit
      list={
        <div className={styles.list}>
          {groups.map((group) => (
            <div key={group.dateKey}>
              <div className={styles.dayHeader}>{group.label}</div>
              {group.items.map((item) => (
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
                    <div className={styles.rowName}>{item.placeName}</div>
                    <div className={styles.rowMeta}>
                      {[item.placeCategory, formatLocalTime(item.happenedAt, item.tzIana)]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </span>
                  {/* A generic label, not a trip name — CONCEPT.md's open
                      question 4 (does the timeline show every check-in with
                      an inline badge, or default-scope to unlinked ones?)
                      is still unresolved, and resolving *that* plus adding a
                      real trip-name lookup is a Trips-screen-era concern
                      (T.13+), not T.12's. */}
                  {item.tripId && <span className={styles.tripBadge}>Trip</span>}
                </button>
              ))}
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
      }
      detail={
        selectedId ? (
          <CheckinDetailPanel
            detail={detail}
            loading={detailLoading}
            onClose={() => setSelectedId(null)}
            onUnlinked={handleUnlinked}
          />
        ) : null
      }
    />
  );
}
