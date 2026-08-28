import { notFound } from 'next/navigation';
import { TripModeScreen } from '../../../_components/TripModeScreen';
import { requireTripOwner, requireUser } from '../../../_lib/authz';
import { getDb } from '../../../_lib/db';

/**
 * `T.19` — a top-level route, not nested under `(home)`'s `ThreeColumnLayout`
 * shell, same reasoning `T.7`'s `app/checkin/page.tsx` already documents:
 * `ThreeColumnLayout` has no responsive behavior and is confirmed broken
 * below 768px, which would defeat a screen that's explicitly mobile-only
 * (`CONCEPT.md`'s Planner section: "Trip Mode's entry point lives here,
 * mobile-only"). `[tripId]` here is a completely separate route tree from
 * `(home)/planner/[tripId]/page.tsx` — Next.js route groups are invisible
 * to the URL, so `/planner/[tripId]` (the workspace) and
 * `/planner/[tripId]/mode` (this) coexist without conflict.
 *
 * Only resolves ownership here — `TripModeScreen` (client) is what actually
 * decides whether *today* is active, since that requires the caller's own
 * local instant and timezone, neither of which the server can know.
 */
export default async function TripModePage({ params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params;
  const actor = await requireUser();
  const db = await getDb();
  const trip = await requireTripOwner(db, tripId, actor);
  if (!trip) notFound();

  return <TripModeScreen tripId={trip.id} tripName={trip.name} />;
}
