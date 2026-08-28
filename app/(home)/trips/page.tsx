import { PageContainer, PageHeader } from '@sovereignfs/ui';
import { TripsScreen } from '../../_components/TripsScreen';
import { requireUser } from '../../_lib/authz';
import { getDb } from '../../_lib/db';
import { getTripsOverview, listTripCards } from '../../_lib/queries';
import styles from './page.module.css';

/**
 * The real Trips screen — a Server Component fetching both payloads
 * (overview stats, card list) directly: no client round trip for the
 * initial load, since filtering is entirely client-side over this one
 * fetch (`docs/adhoc/web-trips.md`). `T.13` built the fixed-header +
 * `PageContainer`-wrapped body shape; `T.14` splits it into a fixed header
 * / independently-scrolling body — same `.page`/`.header`/`.body` technique
 * as Check-ins' `page.tsx` — so `TripsScreen`'s `MainDetailSplit` (its own
 * new detail column) gets real column real estate instead of scrolling the
 * page title along with it.
 */
export default async function TripsPage() {
  const actor = await requireUser();
  const db = await getDb();
  const [overview, cards] = await Promise.all([getTripsOverview(db, actor), listTripCards(db, actor)]);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <PageContainer maxWidth="full">
          <PageHeader title="Trips" />
        </PageContainer>
      </div>
      <div className={styles.body}>
        <TripsScreen overview={overview} cards={cards} />
      </div>
    </div>
  );
}
