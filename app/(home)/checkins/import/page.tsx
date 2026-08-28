import { PageContainer, PageHeader } from '@sovereignfs/ui';
import { ImportStatus } from '../../../_components/ImportStatus';
import { requireUser } from '../../../_lib/authz';
import { getDb } from '../../../_lib/db';
import { getLatestImportJob } from '../../../_lib/import-jobs';

/**
 * `T.8`'s real import screen, replacing `T.6`'s placeholder. Only Swarm
 * today (`CONCEPT.md`'s generic GPX/KML/GeoJSON/CSV importer is a later
 * task) — `docs/adhoc/web-checkins/04-import-swarm.svg` is this page's
 * wireframe.
 */
export default async function CheckinsImportPage() {
  const actor = await requireUser();
  const db = await getDb();
  const job = await getLatestImportJob(db, actor);

  return (
    <PageContainer maxWidth="lg">
      <PageHeader title="Import from Swarm" description="Bring in your existing check-in history from a Swarm data export." />
      <ImportStatus initialJob={job} />
    </PageContainer>
  );
}
