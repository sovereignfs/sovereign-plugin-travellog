'use client';

import { useEffect, useState } from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  SortableContext,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { StepStrip, useToast } from '@sovereignfs/ui';
import { reorderStopAction } from '../actions';
import { daysBetweenDateKeys, formatDateRange } from '../_lib/dates';
import type { WorkspaceStop } from '../_lib/queries';
import styles from './PlannerStopStrip.module.css';

/** Matches `sovereign-plugin-kanban`'s own constant/rationale (`_lib/dndSensors.ts`): short enough that dnd-kit can still tell a plain click from a drag start, so selecting a stop by clicking still works normally. */
const ACTIVATION_DISTANCE_PX = 6;

function StopChip({
  stop,
  isActive,
  onSelect,
}: {
  stop: WorkspaceStop;
  isActive: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: stop.id });
  const dayCount = daysBetweenDateKeys(stop.arriveDate, stop.departDate) + 1;

  return (
    <button
      type="button"
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className={[styles.chip, isActive ? styles.chipActive : ''].filter(Boolean).join(' ')}
      onClick={onSelect}
      {...attributes}
      {...listeners}
    >
      <div className={styles.chipName}>{stop.placeName}</div>
      <div className={styles.chipMeta}>
        {formatDateRange(stop.arriveDate, stop.departDate)} · {dayCount} day{dayCount === 1 ? '' : 's'}
      </div>
    </button>
  );
}

/**
 * `docs/adhoc/web-planner.md` screen 2's stop timeline strip — wires the DS
 * `StepStrip` (purely presentational) up to real drag-reorder, the same
 * distance-activated, handle-less `dnd-kit` pattern as
 * `sovereign-plugin-kanban`'s card drag (`CardTile.tsx`): the whole chip is
 * both the click-to-select target and the drag surface, via `useSortable`'s
 * `attributes`/`listeners` spread directly onto it.
 *
 * Optimistic reorder with rollback: `stops` is a local copy of the `stops`
 * prop (re-synced via the effect below whenever the parent's data changes,
 * e.g. after `router.refresh()`), reordered immediately via `arrayMove` on
 * drop so the chip doesn't visually snap back before the server confirms.
 * On failure, it reverts and shows a toast — matches `TripDetailPanel`'s
 * companions-edit error handling (`T.14`). On success, `onReordered` lets
 * the caller `router.refresh()` — a reorder can change *which* stop is
 * first/last by position, and `_lib/stops.ts`'s `recomputeTripDatesAndAutoLinks`
 * runs on every stop mutation including this one, so the trip's own
 * displayed date range (rendered by the parent's header, not this
 * component) can go stale without it.
 */
export function PlannerStopStrip({
  tripId,
  stops: stopsProp,
  activeStopId,
  onSelectStop,
  onAddStop,
  onReordered,
}: {
  tripId: string;
  stops: WorkspaceStop[];
  activeStopId: string | null;
  onSelectStop: (stopId: string) => void;
  onAddStop: () => void;
  onReordered: () => void;
}) {
  const toast = useToast();
  const [stops, setStops] = useState(stopsProp);

  useEffect(() => {
    setStops(stopsProp);
  }, [stopsProp]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: ACTIVATION_DISTANCE_PX } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = stops.findIndex((s) => s.id === active.id);
    const newIndex = stops.findIndex((s) => s.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const previous = stops;
    setStops(arrayMove(stops, oldIndex, newIndex));
    void (async () => {
      const result = await reorderStopAction(tripId, String(active.id), newIndex);
      if (!result.ok) {
        setStops(previous);
        toast.show({ title: 'Couldn’t reorder stops', message: result.error, category: 'error' });
        return;
      }
      onReordered();
    })();
  }

  return (
    // Explicit `id`, matching `sovereign-plugin-kanban`'s own `DndContext`
    // — without one, dnd-kit's internal `aria-describedby` id comes from a
    // global mount-order counter, which SSR (always starting fresh at 0)
    // and the client (already incremented by any other DndContext mounted
    // earlier in the page's lifetime) can disagree on, producing a real
    // (if cosmetic) hydration mismatch. Caught live via the dev error
    // overlay, not by any check — confirmed by reading the actual React
    // warning text before touching anything.
    <DndContext
      id="planner-stop-strip-dnd"
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={stops.map((s) => s.id)} strategy={horizontalListSortingStrategy}>
        <StepStrip
          items={stops}
          activeId={activeStopId}
          aria-label="Trip stops"
          onAdd={onAddStop}
          addLabel="Add a stop"
          renderItem={(stop, { isActive }) => (
            <StopChip stop={stop} isActive={isActive} onSelect={() => onSelectStop(stop.id)} />
          )}
        />
      </SortableContext>
    </DndContext>
  );
}
