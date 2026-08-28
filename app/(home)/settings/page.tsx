import { EmptyState, PageContainer, PageHeader } from '@sovereignfs/ui';

/** Placeholder — no real settings content scoped yet (see SPEC.md's Routes section). */
export default function SettingsPage() {
  return (
    <PageContainer maxWidth="lg">
      <PageHeader title="Settings" />
      <EmptyState
        icon="settings"
        heading="Nothing to configure yet"
        description="Travellog has no operator- or user-facing settings yet."
      />
    </PageContainer>
  );
}
