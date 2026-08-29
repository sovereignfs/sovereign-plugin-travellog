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

/**
 * Apps switcher this plugin's own top bar opens in place of the platform
 * sidebar's Apps grid — `shell: minimal` gets none of the platform's chrome
 * (no sidebar, no Launcher link), so this is the only way to get back to, or
 * jump directly to, another installed app without going through `/launcher`
 * first. A floating popover anchored to its own trigger, not a full centered
 * modal — this is a quick jump-to-another-app switcher, not a page the user
 * reads through. Mirrors Kanban's own `AppsMenu` (`plugins/sovereign-plugin-
 * kanban.local`) verbatim — same data source, same layout.
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
 * listable plugin the way the rest of the grid's tiles are. `isAdmin` is
 * computed server-side in `layout.tsx` (`sdk.auth.hasCapability`) and
 * threaded down through `TravellogHeader`.
 */
export function AppsMenu({ isAdmin }: { isAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ status: 'loading' });

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
