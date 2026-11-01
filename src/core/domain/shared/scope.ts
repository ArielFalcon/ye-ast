import { compareText } from "./code-node.ts";
import type { DeclaredScope } from "./fact.ts";

/** The part of the declared scope a caller chooses: globs over repository-relative paths. */
export interface ScopeRequest {
  include?: readonly string[];
  exclude?: readonly string[];
}

export type PathSelection = (path: string) => boolean;

export function sortedGlobs(globs: readonly string[] | undefined): string[] {
  return [...new Set(globs ?? [])].sort(compareText);
}

/** An empty `include` selects every path; an `exclude` always wins. */
export function pathSelection({ include, exclude }: Pick<DeclaredScope, "include" | "exclude">, matches: (path: string, glob: string) => boolean): PathSelection {
  return (path) => (include.length === 0 || include.some((glob) => matches(path, glob))) && !exclude.some((glob) => matches(path, glob));
}

/** A glob no repository path can fail to match because of its spelling: relative, normalized, with `/` separators. */
export function isValidGlob(glob: string): boolean {
  return !glob.includes("\\") && glob.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
