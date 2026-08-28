'use client';

import { Button, PageContainer, Typography } from '@sovereignfs/ui';
import styles from './travellog.module.css';

/** Plugin-scoped unexpected-error boundary (never the bare platform 500). */
export default function TravellogError({ reset }: { error: Error; reset: () => void }) {
  return (
    <PageContainer maxWidth="md">
      <div className={styles.centered}>
        <Typography variant="h2" as="h1">
          Something went wrong
        </Typography>
        <Typography variant="body">
          Travellog hit an unexpected problem. Your trips and check-ins are safe.
        </Typography>
        <Button variant="secondary" onClick={reset}>
          Try again
        </Button>
      </div>
    </PageContainer>
  );
}
