import { PageContainer } from '@sovereignfs/ui';
import { PlannerPicker } from '../../_components/PlannerPicker';
import { requireUser } from '../../_lib/authz';
import { getDb } from '../../_lib/db';
import { listTripsForPicker } from '../../_lib/queries';

/**
 * `T.15`'s real Planner entry screen — `docs/adhoc/web-planner.md` screen
 * 1. A Server Component fetching the picker payload directly, same pattern
 * as Trips'/Check-ins' own `page.tsx`.
 */
export default async function PlannerPage() {
  const actor = await requireUser();
  const db = await getDb();
  const trips = await listTripsForPicker(db, actor);

  return (
    <PageContainer maxWidth="lg">
      <PlannerPicker trips={trips} />
    </PageContainer>
  );
}
