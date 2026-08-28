import { PageContainer, Spinner } from '@sovereignfs/ui';
import styles from './loading.module.css';

export default function PlannerWorkspaceLoading() {
  return (
    <PageContainer maxWidth="lg">
      <div className={styles.centered}>
        <Spinner label="Loading trip…" />
      </div>
    </PageContainer>
  );
}
