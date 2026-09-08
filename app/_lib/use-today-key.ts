'use client';

import { useEffect, useState } from 'react';
import { localDateKey } from './timezone';

/**
 * The viewer's own local calendar date (`YYYY-MM-DD`), hydration-safe.
 * Server-rendered output starts from `serverTodayKey` (the server's UTC
 * date, the only "today" a Server Component can know) and corrects to the
 * browser's local date in an effect after mount. The two differ for a few
 * hours a day for everyone outside UTC — long enough that trip status,
 * "next trip in N days", and the timeline's Today/Yesterday labels were
 * all wrong every evening for viewers west of UTC when they used the UTC
 * key alone. The correction is a plain state update, never a navigation
 * fork (CLAUDE.md's viewport rule applies in spirit: fork rendered
 * content, not routes).
 */
export function useTodayKey(serverTodayKey: string): string {
  const [todayKey, setTodayKey] = useState(serverTodayKey);
  useEffect(() => {
    setTodayKey(localDateKey(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone));
  }, []);
  return todayKey;
}

/** The viewer's IANA zone once hydrated; `null` during SSR and the first client render. */
export function useViewerTimeZone(): string | null {
  const [zone, setZone] = useState<string | null>(null);
  useEffect(() => {
    setZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);
  return zone;
}
