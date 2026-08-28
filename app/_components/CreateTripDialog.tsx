'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, FormField, Input } from '@sovereignfs/ui';
import { createTripAction } from '../actions';
import styles from './CreateTripDialog.module.css';

/**
 * `docs/adhoc/web-trips.md` screen 4 — name only, no date-range field (a
 * trip's dates are derived from its stops, set in Planner). Same dialog
 * reachable from Trips' "New trip" CTA and (once `T.15` ships) Planner's
 * own — one create-trip action, two entry points.
 *
 * A manual submit handler, not `useActionState` — `actions.ts`'s own header
 * comment documents this file's deliberate, consistent choice of plain
 * typed-object action parameters over the `(prevState, formData)` shape
 * `useActionState` expects, and `createTripAction(name: string)` already
 * matches every other action here. Post-success navigation (`router.push`
 * into the new trip's Planner page) also has no established
 * `useActionState` precedent anywhere in this monorepo — every existing
 * `useActionState` dialog only closes itself on success, never navigates —
 * so a manual handler avoids fighting a hook built for a different flow.
 */
export function CreateTripDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function handleClose(): void {
    if (pending) return;
    setName('');
    setError(null);
    onClose();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await createTripAction(name);
    if (!result.ok) {
      setError(result.error);
      setPending(false);
      return;
    }
    router.push(`/travellog/planner/${result.trip.id}`);
  }

  return (
    <Dialog open={open} onClose={handleClose} size="md" title="New trip">
      <form onSubmit={(e) => void handleSubmit(e)} className={styles.form}>
        {error && (
          <p className={styles.feedbackError} role="status" aria-live="polite">
            {error}
          </p>
        )}
        <FormField label="Name" required>
          {(field) => (
            <Input
              {...field}
              name="name"
              required
              placeholder="e.g. Kyoto & Osaka"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={pending}
            />
          )}
        </FormField>
        <p className={styles.hint}>You’ll add stops, dates, and a day-by-day itinerary next, in Planner.</p>
        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={handleClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            {pending ? 'Creating…' : 'Create & open in Planner'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
