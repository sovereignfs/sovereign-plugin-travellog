import { PageContainer, PageHeader } from '@sovereignfs/ui';
import { CheckinsTimeline } from '../../_components/CheckinsTimeline';
import { ImportButton } from '../../_components/ImportButton';
import { requireUser } from '../../_lib/authz';
import { todayDateKey } from '../../_lib/dates';
import { getDb } from '../../_lib/db';
import { getVisitTimelinePage, type VisitTimelineFilter } from '../../_lib/queries';
import styles from './page.module.css';

/**
 * `T.6`'s real Check-ins screen — a Server Component fetching the first
 * timeline page directly (no client round trip for it; `CheckinsTimeline`'s
 * "Load more" fetches subsequent pages via `getVisitTimelinePageAction`).
 * Web is view-only for *creating* per `docs/adhoc/web-checkins.md` — the
 * check-in screen at `/travellog/checkin` does that — but the detail column
 * edits, deletes, and links.
 *
 * `?tripId=` / `?placeId=` narrow the timeline (a trip's "N check-ins"
 * link, a place's "every time you were here") — read here so the first
 * page is already filtered, then owned client-side by `CheckinsTimeline`.
 */
export default async function CheckinsPage({
  searchParams,
}: {
  searchParams: Promise<{ tripId?: string; placeId?: string }>;
}) {
  const params = await searchParams;
  const filter: VisitTimelineFilter = {
    ...(params.tripId ? { tripId: params.tripId } : {}),
    ...(params.placeId ? { placeId: params.placeId } : {}),
  };
  const actor = await requireUser();
  const db = await getDb();
  const page = await getVisitTimelinePage(db, actor, undefined, filter);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <PageContainer maxWidth="full">
          <PageHeader title="Check-ins" action={<ImportButton />} />
        </PageContainer>
      </div>
      <div className={styles.body}>
        <CheckinsTimeline
          key={`${filter.tripId ?? ''}:${filter.placeId ?? ''}`}
          initialItems={page.items}
          initialNextCursor={page.nextCursor}
          initialFilter={filter}
          serverTodayKey={todayDateKey()}
        />
      </div>
    </div>
  );
}
