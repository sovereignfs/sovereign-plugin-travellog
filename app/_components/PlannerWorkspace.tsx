'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, ConfirmDialog, EmptyState, Icon, useToast } from '@sovereignfs/ui';
import { deleteStopAction } from '../actions';
import { compareDateKeys, formatDateRange } from '../_lib/dates';
import { plural } from '../_lib/format';
import type { WorkspaceDay, WorkspaceItineraryItem, WorkspaceStop } from '../_lib/queries';
import { useTodayKey } from '../_lib/use-today-key';
import { MainDetailSplit } from './MainDetailSplit';
import { PlannerDayList } from './PlannerDayList';
import { PlannerItemDetailPanel } from './PlannerItemDetailPanel';
import { PlannerStopStrip } from './PlannerStopStrip';
import { StopDialog, type StopDialogMode } from './StopDialog';
import styles from './PlannerWorkspace.module.css';

interface WorkspaceTrip {
  id: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
}

/**
 * `docs/adhoc/web-planner.md` screens 2 (`T.15` built the shell; `T.16`
 * fills in the day-by-day list) and 3 (no stops yet). Owns `activeStopId`
 * (local state, no navigation — "selecting a stop determines which stop's
 * days render below," `T.15`'s own deliverable), `days` (every day across
 * the *whole* trip, fetched once — switching stops is a client-side
 * filter, never a second round trip), and `selectedItemId` (which item's
 * detail column is open).
 *
 * `days` is local state because item add/reorder/edit/remove update it
 * directly, but it **re-syncs from the server prop** whenever that changes
 * (`useEffect` below): a stop add/edit/delete regenerates `trip_days` on
 * the server and `router.refresh()`es, and without the resync the freshly
 * added stop rendered with an empty day list until a hard reload.
 *
 * One `StopDialog` instance covers both adding (the empty-state prompt and
 * the strip's trailing chip) and editing the active stop; deleting a stop
 * is confirmed here. "Start Trip Mode" shows only while today falls inside
 * the trip's dates — outside them it only ever led to the "isn't active
 * right now" empty state.
 */
export function PlannerWorkspace({
  trip,
  initialStops: stops,
  initialDays,
  serverTodayKey,
}: {
  trip: WorkspaceTrip;
  initialStops: WorkspaceStop[];
  initialDays: WorkspaceDay[];
  serverTodayKey: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const todayKey = useTodayKey(serverTodayKey);
  const [activeStopId, setActiveStopId] = useState<string | null>(stops[0]?.id ?? null);
  const [stopDialog, setStopDialog] = useState<StopDialogMode | null>(null);
  const [days, setDays] = useState(initialDays);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [deleteStopOpen, setDeleteStopOpen] = useState(false);
  const [deletingStop, startDeletingStop] = useTransition();

  useEffect(() => {
    setDays(initialDays);
  }, [initialDays]);

  // The active stop may have been deleted (or never existed yet) — fall back to the first.
  useEffect(() => {
    if (activeStopId && stops.some((s) => s.id === activeStopId)) return;
    setActiveStopId(stops[0]?.id ?? null);
  }, [stops, activeStopId]);

  const activeStop = stops.find((s) => s.id === activeStopId) ?? null;
  const lastStop = stops[stops.length - 1] ?? null;

  function handleStopSaved(stopId: string): void {
    setActiveStopId(stopId);
    setSelectedItemId(null);
    router.refresh();
  }

  function selectStop(stopId: string): void {
    setActiveStopId(stopId);
    // A different stop's days were never shown together with this
    // selection — clearing it here (rather than leaving a stale item's
    // detail column open over the new stop's day list) is what `T.16`'s
    // review checklist means by "no stale data flash" on switch.
    setSelectedItemId(null);
  }

  function replaceDayItems(tripDayId: string, items: WorkspaceItineraryItem[]): void {
    setDays((prev) => prev.map((d) => (d.id === tripDayId ? { ...d, items } : d)));
  }

  function handleItemChange(itemId: string, patch: Partial<WorkspaceItineraryItem>): void {
    setDays((prev) =>
      prev.map((d) => ({
        ...d,
        items: d.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
      })),
    );
  }

  function handleItemRemoved(itemId: string): void {
    setDays((prev) =>
      prev.map((d) => ({ ...d, items: d.items.filter((item) => item.id !== itemId) })),
    );
    setSelectedItemId(null);
  }

  function handleItemMoved(): void {
    setSelectedItemId(null);
    router.refresh();
  }

  const daysForActiveStop = days.filter((d) => d.stopId === activeStopId);
  const selectedItem = selectedItemId
    ? (days.flatMap((d) => d.items).find((item) => item.id === selectedItemId) ?? null)
    : null;

  const tripIsOngoing =
    trip.startDate !== null &&
    trip.endDate !== null &&
    compareDateKeys(trip.startDate, todayKey) <= 0 &&
    compareDateKeys(todayKey, trip.endDate) <= 0;

  const metaLine =
    stops.length === 0
      ? 'No stops yet · dates not set'
      : `${plural(stops.length, 'stop')}${
          trip.startDate && trip.endDate
            ? ` · ${formatDateRange(trip.startDate, trip.endDate)}`
            : ''
        }`;

  return (
    <>
      <MainDetailSplit
        detailLabel="Activity details"
        onCloseDetail={() => setSelectedItemId(null)}
        list={
          <div className={styles.workspace}>
            <div className={styles.header}>
              <Link href="/travellog/planner" className={styles.backLink}>
                ← Planner
              </Link>
              <h1 className={styles.title}>{trip.name}</h1>
              <p className={styles.meta}>{metaLine}</p>
              {tripIsOngoing && (
                <Link href={`/travellog/planner/${trip.id}/mode`} className={styles.startTripMode}>
                  Start Trip Mode →
                </Link>
              )}
            </div>

            {stops.length === 0 ? (
              <EmptyState
                icon="route"
                heading="Add your first stop"
                description="A place, plus when you'll arrive and leave. This trip's overall dates are set from your stops, not the other way around."
                action={
                  <Button onClick={() => setStopDialog({ kind: 'add' })}>+ Add a stop</Button>
                }
              />
            ) : (
              <>
                <PlannerStopStrip
                  tripId={trip.id}
                  stops={stops}
                  activeStopId={activeStopId}
                  onSelectStop={selectStop}
                  onAddStop={() =>
                    setStopDialog({ kind: 'add', defaultArriveKey: lastStop?.departDate ?? null })
                  }
                  onReordered={() => router.refresh()}
                />
                {activeStop && (
                  <div className={styles.stopToolbar}>
                    <span className={styles.stopToolbarLabel}>
                      {activeStop.placeName} ·{' '}
                      {formatDateRange(activeStop.arriveDate, activeStop.departDate)}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setStopDialog({ kind: 'edit', stop: activeStop })}
                    >
                      <Icon name="pencil" size="sm" aria-hidden={true} />
                      Edit stop
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleteStopOpen(true)}>
                      <Icon name="trash-2" size="sm" aria-hidden={true} />
                      Remove stop
                    </Button>
                  </div>
                )}
                <PlannerDayList
                  days={daysForActiveStop}
                  selectedItemId={selectedItemId}
                  onSelectItem={setSelectedItemId}
                  onDayItemsChange={replaceDayItems}
                />
              </>
            )}
          </div>
        }
        detail={
          selectedItem ? (
            <PlannerItemDetailPanel
              key={selectedItem.id}
              item={selectedItem}
              days={days.map((d) => ({ id: d.id, date: d.date, stopId: d.stopId }))}
              stops={stops}
              onClose={() => setSelectedItemId(null)}
              onChange={handleItemChange}
              onRemoved={handleItemRemoved}
              onMoved={handleItemMoved}
            />
          ) : null
        }
      />
      <StopDialog
        tripId={trip.id}
        mode={stopDialog ?? { kind: 'add' }}
        open={stopDialog !== null}
        onClose={() => setStopDialog(null)}
        onSaved={handleStopSaved}
      />
      {deleteStopOpen && activeStop && (
        <ConfirmDialog
          open
          onClose={() => setDeleteStopOpen(false)}
          title={`Remove the stop at ${activeStop.placeName}?`}
          message="Its days go with it. A day that still has activities blocks this — remove those first."
          destructive
          confirmLabel={deletingStop ? 'Removing…' : 'Remove stop'}
          pending={deletingStop}
          onConfirm={() => {
            startDeletingStop(async () => {
              const result = await deleteStopAction(trip.id, activeStop.id);
              setDeleteStopOpen(false);
              if (result.ok) {
                setSelectedItemId(null);
                router.refresh();
              } else {
                toast.show({
                  title: 'Couldn’t remove the stop',
                  message: result.error,
                  category: 'error',
                });
              }
            });
          }}
        />
      )}
    </>
  );
}
