import { OfflineHomeView } from './_components/OfflineHomeView';

/**
 * `T.21` — this plugin's one offline-capable entry point
 * (`manifest.json`'s `offline: 'offline-first'`;
 * `docs/plugin-development.md`'s "offline" section). Previously an
 * unconditional `redirect('/travellog/checkins')` — that satisfied
 * `runtime/src/__tests__/offline-route-neutrality.test.ts`'s static scan
 * (a `redirect()` call trips none of its four forbidden-identity-access
 * patterns) but not the actual offline contract: the platform only
 * precaches this exact route, so a precached redirect into a per-user SSR
 * page the platform has never cached fails the moment there's no network
 * to follow it with — exactly the gap `SPEC.md`'s own T.21 deliverable
 * flagged for re-checking once this task actually started.
 *
 * A plain, synchronous Server Component — no data fetch, no request-scoped
 * headers, cookies, or session read of any kind, so its SSR output is
 * identical for every user and safe to precache and replay on a shared
 * device. Everything real (cached trip summary, check-in entry point) is
 * `OfflineHomeView`'s job, client-side, matching
 * `plugins/launcher/app/page.tsx`'s own precedent — the only other
 * first-party `offline-first` plugin in this repo.
 */
export default function TravellogRootPage() {
  return <OfflineHomeView />;
}
