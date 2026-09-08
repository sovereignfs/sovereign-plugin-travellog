'use client';

import { useEffect, useState } from 'react';
import { closestCenter, DndContext, type DragEndEvent } from '@dnd-kit/core';
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripIcon, StepStrip, useReorderSensors, useToast } from '@sovereignfs/ui';
import { reorderStopAction } from '../actions';
import { daysBetweenDateKeys, formatDateRange } from '../_lib/dates';
import { plural } from '../_lib/format';
import type { WorkspaceStop } from '../_lib/queries';
import styles from './PlannerStopStrip.module.css';

function StopChip({
  stop,
  isActive,
  onSelect,
}: {
  stop: WorkspaceStop;
  isActive: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: stop.id,
  });
  const dayCount = daysBetweenDateKeys(stop.arriveDate, stop.departDate) + 1;

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
      }}
      className={[styles.chip, isActive ? styles.chipActive : ''].filter(Boolean).join(' ')}
    >
      {/* Two controls, not one: a plain select button, and a separate drag
          handle carrying dnd-kit's listeners. With both on one `<button>`,
          dnd-kit's keyboard activator swallowed Enter/Space to start a
          drag, so a keyboard user could never *select* a stop. `data-no-dnd`
          keeps a pointer press on the select button from lifting the chip. */}
      <button
        type="button"
        className={styles.select}
        onClick={onSelect}
        aria-pressed={isActive}
        aria-current={isActive ? 'true' : undefined}
        data-no-dnd
      >
        <span className={styles.chipName}>{stop.placeName}</span>
        <span className={styles.chipMeta}>
          {formatDateRange(stop.arriveDate, stop.departDate)} · {plural(dayCount, 'day')}
        </span>
      </button>
      <button
        type="button"
        className={styles.handle}
        aria-label={`Reorder ${stop.placeName}`}
        {...attributes}
        {...listeners}
      >
        <GripIcon className={styles.handleIcon} />
      </button>
    </div>
  );
}

/**
 * `docs/adhoc/web-planner.md` screen 2's stop timeline strip — wires the DS
 * `StepStrip` (purely presentational) up to real drag-reorder through the
 * DS `useReorderSensors` (mouse, long-press touch, keyboard — the
 * hand-rolled `PointerSensor` it replaced never lifted a chip on touch,
 * where the drag became a scroll) and a dedicated handle per chip.
 *
 * Optimistic reorder with rollback: `stops` is a local copy of the `stops`
 * prop (re-synced via the effect below whenever the parent's data changes,
 * e.g. after `router.refresh()`), reordered immediately via `arrayMove` on
 * drop so the chip doesn't visually snap back before the server confirms.
 * On failure, it reverts and shows a toast. On success, `onReordered` lets
 * the caller `router.refresh()`.
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

  const sensors = useReorderSensors();

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
    // (if cosmetic) hydration mismatch.
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
