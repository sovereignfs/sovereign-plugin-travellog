import { EmptyState, PageContainer, PageHeader } from '@sovereignfs/ui';

/** Placeholder — T.13 replaces this with the overview stats + status-grouped cards. */
export default function TripsPage() {
  return (
    <PageContainer maxWidth="lg">
      <PageHeader title="Trips" />
      <EmptyState
        icon="luggage"
        heading="Trip planning is coming soon"
        description="Browse and manage your trips here once T.13 ships."
      />
    </PageContainer>
  );
}
