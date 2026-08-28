import type { ReactNode } from 'react';
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
 * Reused by Check-ins (`T.6`) and will be reused by Trips (`T.14`) and
 * Planner's item detail (`T.16`) — the identical constraint applies to
 * every screen under `(home)`.
 */
export function MainDetailSplit({
  list,
  detail,
  detailWidth = 360,
}: {
  list: ReactNode;
  detail: ReactNode | null;
  detailWidth?: number;
}) {
  return (
    <div className={styles.split}>
      <div className={styles.list}>{list}</div>
      {detail && (
        <div className={styles.detail} style={{ width: detailWidth }}>
          {detail}
        </div>
      )}
    </div>
  );
}
