import type { ReactNode } from 'react';
import { sdk } from '@sovereignfs/sdk';
import { ToastProvider } from '@sovereignfs/ui';
import { OfflineSyncBoundary } from './_components/OfflineSyncBoundary';
import { TravellogHeader } from './_components/TravellogHeader';
import styles from './travellog.module.css';

/**
 * Plugin shell for every page. `shell: "minimal"` gives zero platform
 * chrome, so this provides a self-rendered header (way back to Launcher —
 * see `TravellogHeader`'s own doc comment for what it deliberately doesn't
 * have yet) and a `ToastProvider` — under `shell: default` the platform's
 * own `ClientShell` supplies one, but `runtime/app/(minimal)/layout.tsx`
 * (what `shell: minimal` composes into) is deliberately chrome-free and
 * provides none; any toast call throws without this, the same failure
 * Kanban and Docs each hit live the moment they made this same migration.
 * Structure matches both of those plugins' own root `layout.tsx` directly.
 */
export default async function TravellogLayout({ children }: { children: ReactNode }) {
  // Best-effort: the header's brand badge is cosmetic, not core
  // functionality, so a platform-config read failure shouldn't take down
  // the whole plugin.
  const instanceName = await sdk.platform
    .getConfig()
    .then((config) => config.instanceName)
    .catch(() => 'Sovereign');

  return (
    <ToastProvider>
      {/* `id="sv-app-shell"` — the platform's own shell root id, never
          rendered for this plugin's own routes since `shell: minimal`
          composes under `(minimal)`, not `(platform)`, so reusing it here
          can't collide. */}
      <div id="sv-app-shell" className={styles.shell}>
        <TravellogHeader instanceName={instanceName} />
        <div className={styles.body}>{children}</div>
      </div>
      <OfflineSyncBoundary />
    </ToastProvider>
  );
}
