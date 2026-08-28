import { notFound } from 'next/navigation';
import { EmptyState, PageContainer, PageHeader } from '@sovereignfs/ui';
import { requireTripOwner, requireUser } from '../../../_lib/authz';
import { getDb } from '../../../_lib/db';

/**
 * Placeholder — `T.15` replaces this with the real stop timeline strip +
 * day-by-day workspace. Exists now (ahead of `T.15`) purely so `T.13`'s
 * "creating a trip from here lands the user in Planner for it" review
 * checklist has a real, non-404 destination to land on — same "build the
 * hook point now, wire the real thing later" precedent as `T.6`'s Unlink
 * button. `notFound()`, not a generic empty state, for a trip that doesn't
 * exist or isn't the caller's — matches every other resource's "denial
 * reads as not found" convention (`_lib/authz.ts`'s header comment).
 */
export default async function PlannerTripPage({
  params,
}: {
  params: Promise<{ tripId: string }>;
}) {
  const { tripId } = await params;
  const actor = await requireUser();
  const db = await getDb();
  const trip = await requireTripOwner(db, tripId, actor);
  if (!trip) notFound();

  return (
    <PageContainer maxWidth="lg">
      <PageHeader title={trip.name} />
      <EmptyState
        icon="route"
        heading="Trip planning is coming soon"
        description="Add stops, dates, and a day-by-day itinerary here — once T.15 ships."
      />
    </PageContainer>
  );
}
