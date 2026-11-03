/**
 * git's full object id: SHA-1's 40 hex characters, or SHA-256's 64, in either case, because git resolves an upper-case
 * spelling of either. The one definition: a module that judges a commit id imports this, never a pattern of its own.
 */
const FULL_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

/** Whether a value is a full commit or object id of either of git's object formats. */
export function isFullObjectId(value: string): boolean {
  return FULL_OBJECT_ID.test(value);
}
