import { profileOf, TYPESCRIPT_PROFILE } from "../languages/profiles.ts";

/**
 * Whether the uses of a declaration of `path` are read from the sources that write its name: the languages whose index
 * records no edge for a read of a value (`E.Member`, `typeof X`, a name passed as an argument or written in a file's
 * top-level statements), so the importing file's `imports` edge is the only trace of the use.
 */
export function readsWrittenUses(path: string): boolean {
  return profileOf(path) === TYPESCRIPT_PROFILE;
}

/** The keywords after which a name is the one a declaration declares, not a use of another declaration of that name. */
export const DECLARING_KEYWORDS: ReadonlySet<string> = new Set(["function", "class", "enum", "interface", "type", "namespace", "module", "const", "let", "var"]);
