'use client';

import { useEffect, useState, useTransition } from 'react';
import {
  Button,
  ConfirmDialog,
  FormField,
  Icon,
  Input,
  OverlayHeader,
  Select,
  Textarea,
  Toggle,
  useCommitOnEnterOrBlur,
  useToast,
} from '@sovereignfs/ui';
import {
  deleteItineraryItemAction,
  moveItineraryItemAction,
  updateItineraryItemAction,
} from '../actions';
import { formatDayHeading } from '../_lib/dates';
import type { WorkspaceItineraryItem, WorkspaceStop } from '../_lib/queries';
import styles from './PlannerItemDetailPanel.module.css';

/**
 * `docs/adhoc/web-planner.md` screen 5 — reached by clicking an item row in
 * `PlannerDayList`. Place is a read-only summary (set only at creation, via
 * `AddItineraryItemDialog` — this panel never re-resolves a place search);
 * a text-only activity's title, the planned time, the Fixed toggle, and
 * notes are the editable fields, each committing inline (no separate
 * "Save" step, `T.16`'s own states checklist). "Move to" re-homes the item
 * on another day of the same trip — the one cross-day operation the
 * per-day drag lists can't do.
 *
 * Field edits update the caller's `days` state directly via `onChange`
 * rather than `router.refresh()` — `_lib/itinerary-items.ts`'s own header
 * comment says mutating an item never touches the trip's denormalized
 * dates or its day's row. A move is the exception (it changes which day
 * lists the item) and asks the caller to refresh.
 */
export function PlannerItemDetailPanel({
  item,
  days,
  stops,
  onClose,
  onChange,
  onRemoved,
  onMoved,
}: {
  item: WorkspaceItineraryItem;
  days: Array<{ id: string; date: string; stopId: string }>;
  stops: WorkspaceStop[];
  onClose: () => void;
  /** Bubbles a field patch up so the caller's own `days` state stays in sync. */
  onChange: (itemId: string, patch: Partial<WorkspaceItineraryItem>) => void;
  onRemoved: (itemId: string) => void;
  onMoved: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState(item.title ?? '');
  const [plannedTime, setPlannedTime] = useState(item.plannedTime ?? '');
  const [notes, setNotes] = useState(item.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [moveTarget, setMoveTarget] = useState(item.tripDayId);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, startDeleting] = useTransition();

  useEffect(() => {
    setTitle(item.title ?? '');
    setPlannedTime(item.plannedTime ?? '');
    setNotes(item.notes ?? '');
    setMoveTarget(item.tripDayId);
  }, [item.id, item.title, item.plannedTime, item.notes, item.tripDayId]);

  const itemLabel = item.placeName ?? item.title ?? 'Activity';

  async function commit(
    patch: Parameters<typeof updateItineraryItemAction>[1],
    revert: () => void,
  ): Promise<void> {
    setSaving(true);
    const result = await updateItineraryItemAction(item.id, patch);
    setSaving(false);
    if (!result.ok) {
      revert();
      toast.show({ title: 'Couldn’t save', message: result.error, category: 'error' });
      return;
    }
    onChange(item.id, patch as Partial<WorkspaceItineraryItem>);
  }

  function commitTitle(): void {
    const next = title.trim();
    if (!next) {
      setTitle(item.title ?? '');
      return;
    }
    if (next === item.title) return;
    void commit({ title: next }, () => setTitle(item.title ?? ''));
  }
  const titleHandlers = useCommitOnEnterOrBlur(commitTitle);

  function commitPlannedTime(): void {
    const next = plannedTime.trim() || null;
    if (next === (item.plannedTime ?? null)) return;
    // Clearing the time while the item is still marked fixed would leave
    // the server's merged-state validation rejecting the write
    // (`itinerary-items.ts`'s `assertValid`: fixed requires a planned
    // time) — un-fix in the same patch instead of surfacing that as an
    // error the user didn't cause directly.
    const patch: { plannedTime: string | null; isFixed?: boolean } = { plannedTime: next };
    if (!next && item.isFixed) patch.isFixed = false;
    void commit(patch, () => setPlannedTime(item.plannedTime ?? ''));
  }
  // A quick-entry field: Enter commits, and so does blur (iOS's Done key only fires blur).
  const plannedTimeHandlers = useCommitOnEnterOrBlur(commitPlannedTime);

  function commitNotes(): void {
    const next = notes.trim() ? notes : null;
    if (next === (item.notes ?? null)) return;
    void commit({ notes: next }, () => setNotes(item.notes ?? ''));
  }

  async function handleFixedChange(checked: boolean): Promise<void> {
    onChange(item.id, { isFixed: checked });
    const result = await updateItineraryItemAction(item.id, { isFixed: checked });
    if (!result.ok) {
      onChange(item.id, { isFixed: !checked });
      toast.show({ title: 'Couldn’t save', message: result.error, category: 'error' });
    }
  }

  async function handleMove(): Promise<void> {
    if (moveTarget === item.tripDayId) return;
    setSaving(true);
    const result = await moveItineraryItemAction(item.id, moveTarget);
    setSaving(false);
    if (!result.ok) {
      setMoveTarget(item.tripDayId);
      toast.show({ title: 'Couldn’t move', message: result.error, category: 'error' });
      return;
    }
    onMoved();
  }

  const stopNameById = new Map(stops.map((s) => [s.id, s.placeName]));

  return (
    <div className={styles.panel}>
      <OverlayHeader title={itemLabel} onClose={onClose} />
      <div className={styles.body}>
        {item.placeName ? (
          <FormField label="Place">
            {() => (
              <div className={styles.placeSummary}>
                <Icon name="map-pin" size="sm" aria-hidden={true} />
                <span>
                  <span className={styles.placeSummaryName}>{item.placeName}</span>
                  {item.placeCategory && (
                    <span className={styles.placeSummaryMeta}>{item.placeCategory}</span>
                  )}
                </span>
              </div>
            )}
          </FormField>
        ) : (
          <FormField label="Title" required hint="A text-only activity, with no place attached.">
            {(field) => (
              <Input
                {...field}
                value={title}
                disabled={saving}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={titleHandlers.onKeyDown}
                onBlur={titleHandlers.onBlur}
              />
            )}
          </FormField>
        )}

        <FormField label="Planned time">
          {(field) => (
            <Input
              {...field}
              type="time"
              value={plannedTime}
              disabled={saving}
              onChange={(e) => setPlannedTime(e.target.value)}
              onKeyDown={plannedTimeHandlers.onKeyDown}
              onBlur={plannedTimeHandlers.onBlur}
            />
          )}
        </FormField>

        <div className={styles.fixedRow}>
          <div>
            <div className={styles.fixedLabel}>Fixed time</div>
            <div className={styles.fixedHint}>
              A real commitment — keeps this time no matter what
            </div>
          </div>
          {/* Gated on the *committed* `item.plannedTime`, not the local
              `plannedTime` draft — flipping this on before the time field
              has blurred would race the server's own merged-state check
              (still `plannedTime: null` in the DB at that point) and come
              back rejected. */}
          <Toggle
            checked={item.isFixed}
            onChange={(checked) => void handleFixedChange(checked)}
            disabled={!item.plannedTime}
            aria-label="Fixed time"
          />
        </div>

        <FormField label="Notes">
          {(field) => (
            <Textarea
              {...field}
              value={notes}
              disabled={saving}
              placeholder="Add a note"
              onChange={(e) => setNotes(e.target.value)}
              // Notes is a real multi-line field, unlike a quick-entry
              // input — Enter must insert a newline, not commit, so this
              // deliberately doesn't use `useCommitOnEnterOrBlur`.
              onBlur={commitNotes}
            />
          )}
        </FormField>

        {days.length > 1 && (
          <FormField label="Move to another day">
            {(field) => (
              <div className={styles.moveRow}>
                <Select
                  id={field.id}
                  size="sm"
                  value={moveTarget}
                  disabled={saving}
                  onChange={(e) => setMoveTarget(e.target.value)}
                  aria-label="Day"
                >
                  {days.map((day) => (
                    <option key={day.id} value={day.id}>
                      {formatDayHeading(day.date)} · {stopNameById.get(day.stopId) ?? ''}
                    </option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={saving || moveTarget === item.tripDayId}
                  onClick={() => void handleMove()}
                >
                  Move
                </Button>
              </div>
            )}
          </FormField>
        )}

        <Button
          variant="secondary"
          className={styles.removeButton}
          onClick={() => setDeleteOpen(true)}
        >
          Remove
        </Button>
      </div>

      {deleteOpen && (
        <ConfirmDialog
          open
          onClose={() => setDeleteOpen(false)}
          title={`Remove "${itemLabel}"?`}
          message="This can't be undone."
          destructive
          confirmLabel={deleting ? 'Removing…' : 'Remove'}
          pending={deleting}
          onConfirm={() => {
            startDeleting(async () => {
              const result = await deleteItineraryItemAction(item.id);
              if (result.ok) {
                setDeleteOpen(false);
                onRemoved(item.id);
              } else {
                toast.show({ title: 'Couldn’t remove', message: result.error, category: 'error' });
                setDeleteOpen(false);
              }
            });
          }}
        />
      )}
    </div>
  );
}
