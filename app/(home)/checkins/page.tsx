import { PageContainer, PageHeader } from '@sovereignfs/ui';
import { CheckinsTimeline } from '../../_components/CheckinsTimeline';
import { ImportButton } from '../../_components/ImportButton';
import { requireUser } from '../../_lib/authz';
import { getDb } from '../../_lib/db';
import { getVisitTimelinePage } from '../../_lib/queries';
import styles from './page.module.css';

/**
 * `T.6`'s real Check-ins screen — a Server Component fetching the first
 * timeline page directly (no client round trip for it; `CheckinsTimeline`'s
 * "Load more" fetches subsequent pages via `getVisitTimelinePageAction`).
 * Web is view-only per `docs/adhoc/web-checkins.md` — no check-in creation
 * here, only browsing and import (`T.8`).
 */
export default async function CheckinsPage() {
  const actor = await requireUser();
  const db = await getDb();
  const page = await getVisitTimelinePage(db, actor);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <PageContainer maxWidth="full">
          <PageHeader title="Check-ins" action={<ImportButton />} />
        </PageContainer>
      </div>
      <div className={styles.body}>
        <CheckinsTimeline initialItems={page.items} initialNextCursor={page.nextCursor} />
      </div>
    </div>
  );
}
