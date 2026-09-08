/**
 * Small user-facing text helpers, in one place so pluralisation isn't a
 * ternary at every call site. `Intl.PluralRules` is the seam a future
 * locale switch plugs into; today the whole plugin renders in one locale
 * (`dates.ts`'s `DISPLAY_LOCALE`).
 */
import { DISPLAY_LOCALE } from './dates';

const rules = new Intl.PluralRules(DISPLAY_LOCALE);

/** `plural(1, 'stop')` → `"1 stop"`, `plural(3, 'stop')` → `"3 stops"`; pass an explicit plural form for irregulars. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${String(count)} ${rules.select(count) === 'one' ? singular : pluralForm}`;
}

/** Just the noun, no count — for "day N of M" style sentences that already show the number elsewhere. */
export function pluralNoun(count: number, singular: string, pluralForm = `${singular}s`): string {
  return rules.select(count) === 'one' ? singular : pluralForm;
}
