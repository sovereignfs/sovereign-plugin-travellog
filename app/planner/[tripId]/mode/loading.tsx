import { PageContainer, Spinner } from '@sovereignfs/ui';
import styles from './loading.module.css';

/** The Trip Mode route awaits a DB ownership lookup before rendering — a route that blocks on I/O gets a `loading.tsx` (CLAUDE.md). */
export default function TripModeLoading() {
  return (
    <PageContainer maxWidth="sm">
      <div className={styles.loading}>
        <Spinner label="Loading Trip Mode…" />
      </div>
    </PageContainer>
  );
}
