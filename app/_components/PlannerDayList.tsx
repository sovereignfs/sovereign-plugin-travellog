'use client';

import { useState } from 'react';
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
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Badge, Button, useToast } from '@sovereignfs/ui';
import { reorderItineraryItemAction } from '../actions';
import { formatDayHeading } from '../_lib/dates';
import type { WorkspaceDay, WorkspaceItineraryItem } from '../_lib/queries';
import { AddItineraryItemDialog } from './AddItineraryItemDialog';
import styles from './PlannerDayList.module.css';

/** Matches `PlannerStopStrip`'s own constant/rationale: short enough that dnd-kit can still tell a plain click from a drag start. */
const ACTIVATION_DISTANCE_PX = 6;

function ItemRow({
  item,
  isActive,
  onSelect,
}: {
  item: WorkspaceItineraryItem;
  isActive: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });

  return (
    <button
      type="button"
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className={[styles.item, isActive ? styles.itemActive : ''].filter(Boolean).join(' ')}
      onClick={onSelect}
      {...attributes}
      {...listeners}
    >
      {item.plannedTime && <span className={styles.itemTime}>{item.plannedTime}</span>}
      <span className={styles.itemMain}>
        <span className={styles.itemName}>{item.placeName ?? item.title}</span>
        {item.placeCategory && <span className={styles.itemMeta}>{item.placeCategory}</span>}
      </span>
      {/* Only a real commitment gets a badge — an ordinary flexible item
          shows nothing at all, not a muted "Flexible" label
          (`web-planner.md` screen 2's own annotation: the unmarked default
          should read as unremarkable). */}
      {item.isFixed && (
        <Badge variant="mono" uppercase={false} size="sm">
          Fixed
        </Badge>
      )}
    </button>
  );
}

function DayGroup({
  day,
  dayNumber,
  selectedItemId,
  onSelectItem,
  onItemsChange,
}: {
  day: WorkspaceDay;
  dayNumber: number;
  selectedItemId: string | null;
  onSelectItem: (itemId: string) => void;
  onItemsChange: (tripDayId: string, items: WorkspaceItineraryItem[]) => void;
}) {
  const toast = useToast();
  const [addOpen, setAddOpen] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: ACTIVATION_DISTANCE_PX } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = day.items.findIndex((i) => i.id === active.id);
    const newIndex = day.items.findIndex((i) => i.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const previous = day.items;
    onItemsChange(day.id, arrayMove(day.items, oldIndex, newIndex));
    void (async () => {
      const result = await reorderItineraryItemAction(day.id, String(active.id), newIndex);
      if (!result.ok) {
        onItemsChange(day.id, previous);
        toast.show({ title: 'Couldn’t reorder', message: result.error, category: 'error' });
      }
    })();
  }

  return (
    <div className={styles.day}>
      <h2 className={styles.dayHeading}>
        Day {dayNumber} · {formatDayHeading(day.date)}
      </h2>

      {/* One `DndContext` per day, not one shared across the whole list —
          scopes collision detection to this day's own items so a drag can
          never land in a different day (`T.16`'s review checklist: "reorder
          within a day", not across). Explicit `id`, same SSR/hydration
          reason as `PlannerStopStrip`'s own `DndContext`. */}
      <DndContext
        id={`planner-day-${day.id}-dnd`}
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={day.items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          <div className={styles.items}>
            {day.items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                isActive={item.id === selectedItemId}
                onSelect={() => onSelectItem(item.id)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <Button variant="ghost" size="sm" className={styles.addActivity} onClick={() => setAddOpen(true)}>
        + Add activity
      </Button>

      <AddItineraryItemDialog
        tripDayId={day.id}
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={(item) => {
          onItemsChange(day.id, [...day.items, item]);
          onSelectItem(item.id);
        }}
      />
    </div>
  );
}

/**
 * `docs/adhoc/web-planner.md` screen 2's day-by-day section, for whichever
 * stop is currently selected in `PlannerStopStrip` — the caller
 * (`PlannerWorkspace`) is responsible for filtering `days` down to that
 * stop before passing them here.
 */
export function PlannerDayList({
  days,
  selectedItemId,
  onSelectItem,
  onDayItemsChange,
}: {
  days: WorkspaceDay[];
  selectedItemId: string | null;
  onSelectItem: (itemId: string) => void;
  onDayItemsChange: (tripDayId: string, items: WorkspaceItineraryItem[]) => void;
}) {
  return (
    <div className={styles.dayList}>
      {days.map((day, index) => (
        <DayGroup
          key={day.id}
          day={day}
          dayNumber={index + 1}
          selectedItemId={selectedItemId}
          onSelectItem={onSelectItem}
          onItemsChange={onDayItemsChange}
        />
      ))}
    </div>
  );
}
