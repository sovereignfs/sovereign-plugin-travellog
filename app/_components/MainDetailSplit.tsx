'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Sheet, useIsMobile } from '@sovereignfs/ui';
import styles from './MainDetailSplit.module.css';

/**
 * A list+detail split scoped WITHIN a single `ThreeColumnLayout` "main"
 * slot — not the real `ThreeColumnLayout` component nested recursively
 * (that doesn't compose meaningfully), but the same visual language (a
 * fixed-width right pane, its own scroll, a left border), because
 * `(home)/layout.tsx` already owns the *one* `ThreeColumnLayout` instance
 * for this whole route group (sidebar + this page's entire `{children}`
 * as exactly two children) to keep the sidebar persistently mounted
 * across route navigation (verified live in `T.5`).
 *
 * A page nested under that layout cannot contribute a genuine third
 * sibling to that specific `ThreeColumnLayout` instance — confirmed
 * empirically while building `T.6`, not assumed: a Fragment returned as
 * the layout's `{children}` is **not** flattened by `ThreeColumnLayout`'s
 * own `Children.toArray(children)` into separate slots. The whole
 * Fragment counts as one opaque "main" child, so its own children just
 * stack in normal document flow instead of forming a real third column.
 *
 * Below the mobile breakpoint the detail pane becomes a DS `Sheet` over
 * the list instead of a second fixed-width column squeezed into a phone —
 * a rendered-content fork (`useIsMobile`), never a navigation one. The
 * detail region is a labelled `complementary` landmark and takes focus
 * when it opens, so a keyboard/screen-reader user lands in the thing they
 * just selected rather than staying on the list row.
 *
 * Reused by Check-ins (`T.6`), Trips (`T.14`) and Planner's item detail
 * (`T.16`) — the identical constraint applies to every screen under `(home)`.
 */
export function MainDetailSplit({
  list,
  detail,
  detailWidth = 360,
  detailLabel = 'Details',
  onCloseDetail,
}: {
  list: ReactNode;
  detail: ReactNode | null;
  detailWidth?: number;
  /** Accessible name for the detail landmark / sheet. */
  detailLabel?: string;
  /** Closes the detail (Esc / the sheet's close button on mobile). */
  onCloseDetail?: () => void;
}) {
  const isMobile = useIsMobile();
  const detailRef = useRef<HTMLDivElement>(null);
  const hasDetail = detail !== null && detail !== undefined;

  useEffect(() => {
    if (hasDetail && !isMobile) detailRef.current?.focus();
  }, [hasDetail, isMobile]);

  // Esc closes the desktop detail column while focus is anywhere inside it
  // — registered on the element directly (not as a JSX listener on a
  // non-interactive landmark) so the a11y lint rule's intent holds: the
  // region itself isn't a control, the key just mirrors the Sheet's Esc.
  useEffect(() => {
    const node = detailRef.current;
    if (!node || !hasDetail || isMobile || !onCloseDetail) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCloseDetail();
    };
    node.addEventListener('keydown', onKeyDown);
    return () => node.removeEventListener('keydown', onKeyDown);
  }, [hasDetail, isMobile, onCloseDetail]);

  return (
    <div className={styles.split}>
      <div className={styles.list}>{list}</div>
      {hasDetail && !isMobile && (
        <div
          ref={detailRef}
          className={styles.detail}
          style={{ width: detailWidth }}
          role="complementary"
          aria-label={detailLabel}
          tabIndex={-1}
        >
          {detail}
        </div>
      )}
      {isMobile && (
        <Sheet open={hasDetail} onClose={() => onCloseDetail?.()} aria-label={detailLabel}>
          {detail}
        </Sheet>
      )}
    </div>
  );
}
