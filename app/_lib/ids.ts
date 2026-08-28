import { nanoid } from 'nanoid';

/** New entity id — url-safe, generated app-side (ids are text columns). */
export function newId(): string {
  return nanoid();
}
