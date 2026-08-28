import { EmptyState, PageContainer, PageHeader } from '@sovereignfs/ui';

/** Placeholder — T.15 replaces this with the trip picker + stop workspace. */
export default function PlannerPage() {
  return (
    <PageContainer maxWidth="lg">
      <PageHeader title="Planner" />
      <EmptyState
        icon="route"
        heading="Trip planning is coming soon"
        description="Pick a trip to keep planning, or start a new one — once T.15 ships."
      />
    </PageContainer>
  );
}
