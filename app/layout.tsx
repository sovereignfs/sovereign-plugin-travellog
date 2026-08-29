import type { ReactNode } from 'react';
import { sdk } from '@sovereignfs/sdk';
import { ToastProvider } from '@sovereignfs/ui';
import { OfflineSyncBoundary } from './_components/OfflineSyncBoundary';
import { TravellogHeader } from './_components/TravellogHeader';
import { registerEncryptionTables } from './_lib/crypto';
import { registerPortabilityHandlers } from './_lib/portability';
import styles from './travellog.module.css';

/**
 * Plugin shell for every page. `shell: "minimal"` gives zero platform
 * chrome, so this provides a self-rendered header (way back to Launcher,
 * apps switcher, account menu — see `TravellogHeader`'s own doc comment)
 * and a `ToastProvider` — under `shell: default` the platform's own
 * `ClientShell` supplies one, but `runtime/app/(minimal)/layout.tsx` (what
 * `shell: minimal` composes into) is deliberately chrome-free and provides
 * none; any toast call throws without this, the same failure Kanban and
 * Docs each hit live the moment they made this same migration. Structure
 * matches both of those plugins' own root `layout.tsx` directly.
 */
export default async function TravellogLayout({ children }: { children: ReactNode }) {
  // In-process and reset on restart — the platform SDK requires
  // re-registering from a request-scoped plugin route, so this runs on
  // every request. Best-effort: a registration failure must not block the
  // plugin's own UI (matches sovereign-plugin-docs' identical pattern).
  try {
    await registerPortabilityHandlers();
    await registerEncryptionTables();
  } catch {
    // Portability and field-encryption table registration are both
    // best-effort platform integrations.
  }

  const [session, instanceName] = await Promise.all([
    sdk.auth.getSession(),
    // Best-effort: the header's brand badge is cosmetic, not core
    // functionality, so a platform-config read failure shouldn't take down
    // the whole plugin.
    sdk.platform
      .getConfig()
      .then((config) => config.instanceName)
      .catch(() => 'Sovereign'),
  ]);

  // Platform-role admin check, same capability (`console:access`) and same
  // pattern (`hasCapability` against the session) the platform shell's own
  // `AdminConsoleIcon` uses to gate its Console link — gates the "Console"
  // tile `AppsMenu` adds to its Apps switcher (`T.5a`). Computed here, not in
  // `AppsMenu` itself, because that component is a client component with no
  // server-side session access of its own.
  const isAdmin = sdk.auth.hasCapability(session, 'console:access');

  return (
    <ToastProvider>
      {/* `id="sv-app-shell"` — the platform's own shell root id, never
          rendered for this plugin's own routes since `shell: minimal`
          composes under `(minimal)`, not `(platform)`, so reusing it here
          can't collide. */}
      <div id="sv-app-shell" className={styles.shell}>
        <TravellogHeader
          user={{
            name: session?.user.name ?? null,
            email: session?.user.email ?? '',
            image: session?.user.image ?? null,
          }}
          instanceName={instanceName}
          isAdmin={isAdmin}
        />
        <div className={styles.body}>{children}</div>
      </div>
      <OfflineSyncBoundary />
    </ToastProvider>
  );
}
