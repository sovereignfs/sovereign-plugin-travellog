import { PageContainer, PageHeader } from '@sovereignfs/ui';
import { TripsScreen } from '../../_components/TripsScreen';
import { requireUser } from '../../_lib/authz';
import { getDb } from '../../_lib/db';
import { getTripsOverview, listTripCards } from '../../_lib/queries';

/**
 * `T.13`'s real Trips screen — a Server Component fetching both payloads
 * (overview stats, card list) directly, same pattern as Check-ins'
 * `page.tsx`: no client round trip for the initial load, since filtering
 * is entirely client-side over this one fetch (`docs/adhoc/web-trips.md`).
 * Card-click-to-detail is `T.14`'s deliverable, not built here.
 */
export default async function TripsPage() {
  const actor = await requireUser();
  const db = await getDb();
  const [overview, cards] = await Promise.all([getTripsOverview(db, actor), listTripCards(db, actor)]);

  return (
    <PageContainer maxWidth="full">
      <PageHeader title="Trips" />
      <TripsScreen overview={overview} cards={cards} />
    </PageContainer>
  );
}
