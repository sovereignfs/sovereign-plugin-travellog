'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@sovereignfs/ui';

/**
 * `PageHeader`'s `action` slot needs a click handler (`router.push`, since
 * `Button` always renders a plain `<button>` — no `asChild`/link mode), but
 * the Check-ins page itself is an `async` Server Component and can't call
 * `useRouter`. This is the whole component just to bridge that gap.
 */
export function ImportButton() {
  const router = useRouter();
  return (
    <Button variant="secondary" onClick={() => router.push('/travellog/checkins/import')}>
      Import…
    </Button>
  );
}
