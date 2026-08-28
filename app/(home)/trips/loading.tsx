import { PageContainer, Spinner } from '@sovereignfs/ui';
import styles from './loading.module.css';

export default function TripsLoading() {
  return (
    <PageContainer maxWidth="full">
      <div className={styles.centered}>
        <Spinner label="Loading trips…" />
      </div>
    </PageContainer>
  );
}
