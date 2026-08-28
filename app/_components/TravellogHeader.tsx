import Link from 'next/link';
import styles from '../travellog.module.css';

/**
 * Web-only top bar, rendered on every plugin page via the root layout.
 * `shell: minimal` gives the plugin zero platform chrome, so this replaces
 * what the platform's own header would have provided: a way back to
 * Launcher. Mirrors the left half of `sovereign-plugin-docs`'s
 * `DocsHeader` / `sovereign-plugin-kanban`'s `KanbanHeader` (identical to
 * each other 1:1) — same compact 48px bar, same brand-badge-links-to-
 * Launcher pattern.
 *
 * Deliberately missing the right half those two have (an `AppsMenu`
 * popover + an account-menu avatar) — a real, tracked gap, not an
 * oversight. See `SPEC.md`'s `T.5a`: that's genuinely separate scope
 * (session/directory data, a DS-primitive account-menu rebuild) that
 * doesn't block anything in the Slice 1/2 build order, so it's deferred
 * rather than built ad hoc here. No `'use client'` yet either — this has
 * no interactivity of its own; `T.5a` will likely need to add it once a
 * menu trigger does.
 */
export function TravellogHeader({ instanceName }: { instanceName: string }) {
  const brandInitial = instanceName.charAt(0).toUpperCase() || 'S';

  return (
    <header className={styles.header}>
      <div className={styles.headerLeft}>
        <Link
          href="/launcher"
          className={styles.headerBrandBadge}
          aria-label={`${instanceName} Launcher`}
        >
          {brandInitial}
        </Link>
        <Link href="/travellog" className={styles.headerBrand}>
          <img
            src="/plugin-icons/fs.sovereign.travellog.svg"
            alt=""
            className={styles.headerBrandIcon}
          />
          <span className={styles.headerBrandName}>Travellog</span>
        </Link>
      </div>
    </header>
  );
}
