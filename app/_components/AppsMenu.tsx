'use client';

import { useEffect, useState } from 'react';
import { Icon, Popover, Spinner } from '@sovereignfs/ui';
import styles from '../travellog.module.css';

interface AppEntry {
  id: string;
  name: string;
  routePrefix: string;
  iconUrl?: string;
}

type State = { status: 'loading' } | { status: 'error' } | { status: 'loaded'; apps: AppEntry[] };

function monogram(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const [first = '', second = ''] = trimmed.split(/\s+/);
  return (second ? first.charAt(0) + second.charAt(0) : first.slice(0, 2)).toUpperCase();
}

// Module-scoped and shared by every instance mounted this page load (only
// ever one, but matches `runtime`'s own `sidebar-hydration.ts`
// `hydrateSidebarOnce` dedup exactly) so a re-render never re-fires the
// fetch. Reads only `.isAdmin` from the response — `.plugins` is a
// differently-scoped list (sidebar selection/ordering) than what this
// popover's own `GET /api/plugins` fetch below renders.
let adminHydrationPromise: Promise<boolean> | null = null;

function hydrateIsAdminOnce(): Promise<boolean> {
  adminHydrationPromise ??= fetch('/api/plugins/sidebar')
    .then((res) => (res.ok ? res.json() : null))
    .then((data: { isAdmin?: boolean } | null) => data?.isAdmin ?? false)
    .catch(() => false);
  return adminHydrationPromise;
}

/**
 * Apps switcher this plugin's own top bar opens in place of the platform
 * sidebar's Apps grid — `shell: minimal` gets none of the platform's chrome
 * (no sidebar, no Launcher link), so this is the only way to get back to, or
 * jump directly to, another installed app without going through `/launcher`
 * first. A floating popover anchored to its own trigger, not a full centered
 * modal — this is a quick jump-to-another-app switcher, not a page the user
 * reads through. Mirrors Kanban's own `AppsMenu` (`plugins/sovereign-plugin-
 * kanban.local`) structurally, but diverges on `isAdmin`: see below.
 *
 * Fetches the same session-gated, access-policy-filtered route the
 * platform's own Launcher grid renders from (`GET /api/plugins`), rather
 * than hardcoding a list or importing the registry — the SDK boundary rule
 * forbids the latter. Fetched fresh every open, not cached — a lightweight,
 * infrequently-opened surface.
 *
 * Tile links are plain `<a>` tags, not `next/link`'s `Link` — most of these
 * apps live under the platform's own `(platform)` root layout, a different
 * one than this plugin's `(minimal)` root.
 *
 * "Home" and (admin-only) "Console" are two static tiles ahead of the
 * fetched list, not part of `/api/plugins`'s response — neither is a real
 * listable plugin the way the rest of the grid's tiles are. Unlike Kanban
 * (not offline-capable, so its `layout.tsx` can compute `isAdmin` server-side
 * and pass it down as a prop), this plugin is `offline: 'offline-first'` —
 * `app/layout.tsx` renders no per-user identity at all (its own doc comment
 * explains why), so this component hydrates its own admin status
 * client-side on mount via `GET /api/plugins/sidebar` (the same endpoint
 * `runtime`'s own `sidebar-hydration.ts` uses for the identical problem),
 * defaulting to hidden until that resolves.
 */
export function AppsMenu() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ status: 'loading' });
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;
    hydrateIsAdminOnce().then((result) => {
      if (!cancelled) setIsAdmin(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ status: 'loading' });
    fetch('/api/plugins')
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch apps: ${res.status}`);
        return res.json() as Promise<{ plugins: AppEntry[] }>;
      })
      .then((data) => {
        if (!cancelled) setState({ status: 'loaded', apps: data.plugins });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Popover
      align="right"
      width={320}
      open={open}
      onClose={() => setOpen(false)}
      aria-label="Apps"
      trigger={
        <button
          type="button"
          className={styles.headerAppsButton}
          aria-label="Apps"
          aria-haspopup="true"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <img
            src="/plugin-icons/fs.sovereign.launcher.svg"
            alt=""
            className={styles.headerAppsIcon}
          />
        </button>
      }
    >
      <div className={styles.appsPopoverHeader}>Apps</div>
      <div className={styles.appsGrid}>
        <a href="/launcher" className={styles.appTile}>
          <span className={styles.appTileIcon} aria-hidden="true">
            <Icon name="house" size="md" aria-hidden />
          </span>
          <span className={styles.appTileName}>Home</span>
        </a>
        {isAdmin && (
          <a href="/console" className={styles.appTile}>
            <span className={styles.appTileIcon} aria-hidden="true">
              <img
                src="/plugin-icons/fs.sovereign.console.svg"
                alt=""
                className={styles.appTileIconImg}
              />
            </span>
            <span className={styles.appTileName}>Console</span>
          </a>
        )}
        {state.status === 'loaded' &&
          state.apps.map((app) => (
            <a key={app.id} href={app.routePrefix} className={styles.appTile}>
              <span className={styles.appTileIcon} aria-hidden="true">
                {app.iconUrl ? (
                  <img src={app.iconUrl} alt="" className={styles.appTileIconImg} />
                ) : (
                  monogram(app.name)
                )}
              </span>
              <span className={styles.appTileName}>{app.name}</span>
            </a>
          ))}
      </div>
      {state.status === 'loading' && (
        <div className={styles.appsPopoverLoading}>
          <Spinner size="md" label="Loading apps…" />
        </div>
      )}
      {state.status === 'error' && (
        <p className={`${styles.formError} ${styles.appsPopoverError}`}>
          Couldn&apos;t load apps. Try again.
        </p>
      )}
    </Popover>
  );
}
