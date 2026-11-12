import { compareText } from "./code-node.ts";
import type { DeclaredScope } from "./fact.ts";

/** The part of the declared scope a caller chooses: globs over repository-relative paths. */
export interface ScopeRequest {
  include?: readonly string[];
  exclude?: readonly string[];
}

/** Marks one internal workspace walk whose aggregate selection has already been evaluated; never serialized or retained. */
export const WORKSPACE_SCOPE: unique symbol = Symbol("workspace scope already evaluated");

export type PathSelection = (path: string) => boolean;

export function sortedGlobs(globs: readonly string[] | undefined): string[] {
  return [...new Set(globs ?? [])].sort(compareText);
}

/** An empty `include` selects every path; an `exclude` always wins. */
export function pathSelection({ include, exclude }: Pick<DeclaredScope, "include" | "exclude">, matches: (path: string, glob: string) => boolean): PathSelection {
  return (path) => (include.length === 0 || include.some((glob) => matches(path, glob))) && !exclude.some((glob) => matches(path, glob));
}

/**
 * What the export writes: the caller's selection plus the configuration an extractor needs to interpret what it
 * selected, which a narrowing `include` never removes. An `exclude` still leaves a path out of both.
 */
export function exportSelection(
  scope: Pick<DeclaredScope, "include" | "exclude">,
  matches: (path: string, glob: string) => boolean,
  configuration: (path: string) => boolean,
): PathSelection {
  const selected = pathSelection(scope, matches);
  const kept = pathSelection({ include: [], exclude: scope.exclude }, matches);
  return (path) => selected(path) || (configuration(path) && kept(path));
}

/** A glob no repository path can fail to match because of its spelling: relative, normalized, with `/` separators. */
export function isValidGlob(glob: string): boolean {
  return !glob.includes("\\") && glob.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function unmatchedIncludes(scope: Pick<DeclaredScope, "include">, matches: (path: string, glob: string) => boolean, listing: readonly string[]): string[] {
  return sortedGlobs(scope.include.filter((glob) => !listing.some((path) => matches(path, glob))));
}
