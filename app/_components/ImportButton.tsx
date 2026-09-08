import Link from 'next/link';
import styles from './ImportButton.module.css';

/**
 * `PageHeader`'s `action` slot on the Check-ins page. Real navigation, so a
 * real link (middle-click, copy address, prefetch) styled as the DS
 * secondary button — `Button` has no link mode, and a `router.push` on a
 * `<button>` was the previous stand-in. Not a client component anymore:
 * nothing here needs a hook.
 */
export function ImportButton() {
  return (
    <Link href="/travellog/checkins/import" className={styles.link}>
      Import…
    </Link>
  );
}
