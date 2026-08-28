import { notFound } from 'next/navigation';
import { PageContainer } from '@sovereignfs/ui';
import { PlannerWorkspace } from '../../../_components/PlannerWorkspace';
import { requireTripOwner, requireUser } from '../../../_lib/authz';
import { getDb } from '../../../_lib/db';
import { listWorkspaceDays, listWorkspaceStops } from '../../../_lib/queries';

/**
 * `T.15`'s Planner workspace shell (screens 2/3) plus `T.16`'s day-by-day
 * itinerary editor (screen 2's populated day list, screen 5's item detail).
 * Replaces the `T.13`-era placeholder that existed purely so "creating a
 * trip lands in Planner for it" had a real destination. `notFound()`, not a
 * generic empty state, for a trip that doesn't exist or isn't the caller's
 * — matches every other resource's "denial reads as not found" convention
 * (`_lib/authz.ts`'s header comment).
 */
export default async function PlannerTripPage({ params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params;
  const actor = await requireUser();
  const db = await getDb();
  const trip = await requireTripOwner(db, tripId, actor);
  if (!trip) notFound();
  const [stops, days] = await Promise.all([
    listWorkspaceStops(db, actor, tripId),
    listWorkspaceDays(db, actor, tripId),
  ]);

  return (
    <PageContainer maxWidth="lg">
      <PlannerWorkspace
        trip={{ id: trip.id, name: trip.name, startDate: trip.startDate, endDate: trip.endDate }}
        initialStops={stops}
        initialDays={days}
      />
    </PageContainer>
  );
}
