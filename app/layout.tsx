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
 *
 * Deliberately reads no per-user identity of any kind — no SDK session
 * lookup or capability check, unconditionally, not even behind a branch:
 * this layout wraps every route under this plugin, including
 * `app/page.tsx` — the one `offline: 'offline-first'` entry point
 * (`manifest.json`) a service worker precaches and may later replay to a
 * *different* user on a shared device (RFC 0074/0078). Whatever this file's
 * own source text names, `runtime/src/__tests__/offline-route-neutrality
 * .test.ts` flags regardless of surrounding conditionals — it's a static
 * text scan (`findForbiddenIdentityAccess`), not a control-flow analysis, so
 * "only read it when the route isn't the offline one" doesn't help, and
 * even naming the read APIs verbatim in a comment like this one would trip
 * the same regex the source code does. The account menu's name/email/avatar
 * and the apps switcher's admin-gated Console tile both now hydrate
 * client-side instead — see `TravellogAccountMenu`'s and `AppsMenu`'s own
 * doc comments, mirroring `runtime/app/(platform)/_components/AccountMenu
 * .tsx`'s hydration pattern and `sidebar-hydration.ts`'s equivalent.
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

  // Best-effort: the header's brand badge is cosmetic, not core
  // functionality, so a platform-config read failure shouldn't take down the
  // whole plugin. Instance-wide, not per-user — safe to render in the
  // offline-cached shell.
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
