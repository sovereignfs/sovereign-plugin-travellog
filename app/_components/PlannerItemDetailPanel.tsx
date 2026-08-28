'use client';

import { useEffect, useState, useTransition } from 'react';
import {
  Button,
  ConfirmDialog,
  FormField,
  Icon,
  Input,
  OverlayHeader,
  Textarea,
  Toggle,
  useToast,
} from '@sovereignfs/ui';
import { deleteItineraryItemAction, updateItineraryItemAction } from '../actions';
import type { WorkspaceItineraryItem } from '../_lib/queries';
import styles from './PlannerItemDetailPanel.module.css';

/**
 * `docs/adhoc/web-planner.md` screen 5 — reached by clicking an item row in
 * `PlannerDayList`. Place is a read-only summary (set only at creation, via
 * `AddItineraryItemDialog` — this panel never re-resolves a place search);
 * planned time, the Fixed toggle, and notes are the editable fields, each
 * committing inline on blur/toggle, matching `TripDetailPanel`'s companions
 * field (no separate "Save" step, `T.16`'s own states checklist).
 *
 * Every field edit updates the caller's `days` state directly via `onChange`
 * rather than `router.refresh()` — `_lib/itinerary-items.ts`'s own header
 * comment says mutating an item never touches the trip's denormalized dates
 * or its day's row, so there's nothing else on the page a refresh would need
 * to catch up on.
 */
export function PlannerItemDetailPanel({
  item,
  onClose,
  onChange,
  onRemoved,
}: {
  item: WorkspaceItineraryItem;
  onClose: () => void;
  /** Bubbles a field patch up so the caller's own `days` state stays in sync. */
  onChange: (itemId: string, patch: Partial<WorkspaceItineraryItem>) => void;
  onRemoved: (itemId: string) => void;
}) {
  const toast = useToast();
  const [plannedTime, setPlannedTime] = useState(item.plannedTime ?? '');
  const [notes, setNotes] = useState(item.notes ?? '');
  const [savingTime, setSavingTime] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, startDeleting] = useTransition();

  useEffect(() => {
    setPlannedTime(item.plannedTime ?? '');
    setNotes(item.notes ?? '');
  }, [item.id, item.plannedTime, item.notes]);

  const itemLabel = item.placeName ?? item.title ?? 'Activity';

  async function commitPlannedTime(): Promise<void> {
    const next = plannedTime.trim() || null;
    if (next === (item.plannedTime ?? null)) return;
    // Clearing the time while the item is still marked fixed would leave
    // the server's merged-state validation rejecting the write
    // (`itinerary-items.ts`'s `assertValid`: fixed requires a planned
    // time) — un-fix in the same patch instead of surfacing that as an
    // error the user didn't cause directly.
    const patch: { plannedTime: string | null; isFixed?: boolean } = { plannedTime: next };
    if (!next && item.isFixed) patch.isFixed = false;

    setSavingTime(true);
    const result = await updateItineraryItemAction(item.id, patch);
    setSavingTime(false);
    if (!result.ok) {
      setPlannedTime(item.plannedTime ?? '');
      toast.show({ title: 'Couldn’t save', message: result.error, category: 'error' });
      return;
    }
    onChange(item.id, patch);
  }

  async function commitNotes(): Promise<void> {
    const next = notes.trim() ? notes : null;
    if (next === (item.notes ?? null)) return;
    setSavingNotes(true);
    const result = await updateItineraryItemAction(item.id, { notes: next });
    setSavingNotes(false);
    if (!result.ok) {
      setNotes(item.notes ?? '');
      toast.show({ title: 'Couldn’t save', message: result.error, category: 'error' });
      return;
    }
    onChange(item.id, { notes: next });
  }

  async function handleFixedChange(checked: boolean): Promise<void> {
    onChange(item.id, { isFixed: checked });
    const result = await updateItineraryItemAction(item.id, { isFixed: checked });
    if (!result.ok) {
      onChange(item.id, { isFixed: !checked });
      toast.show({ title: 'Couldn’t save', message: result.error, category: 'error' });
    }
  }

  return (
    <div className={styles.panel}>
      <OverlayHeader title={itemLabel} onClose={onClose} />
      <div className={styles.body}>
        <FormField label="Place">
          {() => (
            <div className={styles.placeSummary}>
              {item.placeName ? (
                <>
                  <Icon name="map-pin" size="sm" aria-hidden={true} />
                  <span>
                    <span className={styles.placeSummaryName}>{item.placeName}</span>
                    {item.placeCategory && (
                      <span className={styles.placeSummaryMeta}>{item.placeCategory}</span>
                    )}
                  </span>
                </>
              ) : (
                <span className={styles.placeSummaryEmpty}>No place — a text-only activity.</span>
              )}
            </div>
          )}
        </FormField>

        <FormField label="Planned time">
          {(field) => (
            <Input
              {...field}
              type="time"
              value={plannedTime}
              disabled={savingTime}
              onChange={(e) => setPlannedTime(e.target.value)}
              onBlur={() => void commitPlannedTime()}
            />
          )}
        </FormField>

        <div className={styles.fixedRow}>
          <div>
            <div className={styles.fixedLabel}>Fixed time</div>
            <div className={styles.fixedHint}>Keeps this time even if stops get reordered</div>
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
              disabled={savingNotes}
              placeholder="Add a note"
              onChange={(e) => setNotes(e.target.value)}
              // Notes is a real multi-line field, unlike a quick-entry
              // input — Enter must insert a newline, not commit, so this
              // deliberately doesn't use `useCommitOnEnterOrBlur`.
              onBlur={() => void commitNotes()}
            />
          )}
        </FormField>

        <Button variant="secondary" className={styles.removeButton} onClick={() => setDeleteOpen(true)}>
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
