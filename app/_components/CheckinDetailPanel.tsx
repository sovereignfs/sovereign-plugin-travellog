'use client';

import { useState } from 'react';
import { Badge, Icon, OverlayHeader, Spinner, useToast } from '@sovereignfs/ui';
import { setVisitTripLinkAction, type VisitDetailView } from '../actions';
import { formatLocalTime, localDateKey } from '../_lib/timezone';
import styles from './CheckinDetailPanel.module.css';

function formatFullDate(dateKey: string): string {
  // `dateKey` is `YYYY-MM-DD` in the visit's own zone — parsed as UTC noon
  // purely to dodge any local-zone rollover in `toLocaleDateString` itself,
  // not to re-derive the zone (already baked into `dateKey`).
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12));
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * `MainDetailSplit`'s detail column content for `T.6`'s Check-ins screen —
 * otherwise read-only (`CONCEPT.md`'s Check-ins section scopes web to
 * viewing plus an unlink action; `updateVisitAction`/`deleteVisitAction`
 * already exist server-side from `T.4` but have no web UI hook — not a gap
 * to fix here, just plumbing built ahead of whichever future task needs
 * it). The trip badge + "Unlink" affordance is wired to `T.12`'s
 * `setVisitTripLinkAction` — `tripId` now actually populates (the auto-link
 * engine), so this branch renders for real check-ins, not just in theory.
 */
export function CheckinDetailPanel({
  detail,
  loading,
  onClose,
  onUnlinked,
}: {
  detail: VisitDetailView | null;
  loading: boolean;
  onClose: () => void;
  /** Called after a successful unlink so the caller can re-fetch this same visit's detail. */
  onUnlinked?: () => void;
}) {
  const toast = useToast();
  const [unlinking, setUnlinking] = useState(false);

  async function handleUnlink(visitId: string): Promise<void> {
    setUnlinking(true);
    try {
      const result = await setVisitTripLinkAction(visitId, null);
      if (!result.ok) {
        toast.show({ title: 'Couldn’t unlink', message: result.error, category: 'error' });
        return;
      }
      onUnlinked?.();
    } finally {
      setUnlinking(false);
    }
  }

  return (
    <div className={styles.panel}>
      <OverlayHeader title={detail?.place.name ?? 'Check-in'} onClose={onClose} />
      <div className={styles.body}>
        {loading && (
          <div className={styles.loading}>
            <Spinner label="Loading check-in…" />
          </div>
        )}
        {!loading && !detail && (
          <p className={styles.missing}>This check-in couldn’t be found — it may have been deleted.</p>
        )}
        {!loading && detail && (
          <>
            {detail.photos.length > 0 && (
              <div className={styles.photoStrip}>
                {detail.photos.map((photo) => (
                  <img key={photo.id} src={photo.url} alt="" className={styles.photo} />
                ))}
              </div>
            )}

            <div className={styles.metaRow}>
              <Icon name="calendar" size="sm" aria-hidden={true} />
              <span>
                {formatFullDate(localDateKey(detail.happenedAt, detail.tzIana))} ·{' '}
                {formatLocalTime(detail.happenedAt, detail.tzIana)}
              </span>
            </div>

            {detail.place.category && (
              <div className={styles.metaRow}>
                <Icon name="map-pin" size="sm" aria-hidden={true} />
                <span>{detail.place.category}</span>
              </div>
            )}

            {detail.placeVisitCount > 1 && (
              <div className={styles.metaRow}>
                <Icon name="history" size="sm" aria-hidden={true} />
                <span>Visited {detail.placeVisitCount} times</span>
              </div>
            )}

            {detail.tripId && (
              <div className={styles.tripRow}>
                <Badge variant="mono" uppercase={false}>
                  Part of a trip
                </Badge>
                <button
                  type="button"
                  className={styles.unlinkButton}
                  disabled={unlinking}
                  onClick={() => void handleUnlink(detail.id)}
                >
                  {unlinking ? 'Unlinking…' : 'Unlink'}
                </button>
              </div>
            )}

            {detail.note && (
              <div className={styles.section}>
                <div className={styles.sectionLabel}>
                  <Icon name="file-text" size="sm" aria-hidden={true} />
                  <span>Note</span>
                </div>
                <p className={styles.note}>{detail.note}</p>
              </div>
            )}

            {detail.companions.length > 0 && (
              <div className={styles.section}>
                <div className={styles.sectionLabel}>
                  <Icon name="users" size="sm" aria-hidden={true} />
                  <span>With</span>
                </div>
                <p className={styles.companions}>{detail.companions.join(', ')}</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
