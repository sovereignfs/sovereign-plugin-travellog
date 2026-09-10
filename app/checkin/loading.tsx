import { PageContainer, Spinner } from '@sovereignfs/ui';
import styles from './loading.module.css';

export default function CheckInLoading() {
  return (
    <PageContainer maxWidth="sm">
      <div className={styles.centered}>
        <Spinner label="Loading check-in…" />
      </div>
    </PageContainer>
  );
}
