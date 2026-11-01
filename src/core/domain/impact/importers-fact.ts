import { nameTail, type UnresolvedUse } from "./impact-cuts.ts";

/** Who depends on one file, as repo-relative paths sorted by code unit; the file itself is never listed. */
export interface ImportedFile {
  file: string;
  /** Files with an `imports` edge into the file or a symbol it declares, test files included. */
  importers: readonly string[];
  /** Files with an edge of any kind but containment into the file or a symbol it declares, test files included. */
  users: readonly string[];
  /** Files holding a reference the index could not resolve that names the file or a symbol it declares. */
  unresolvedNamers: readonly string[];
}

export interface ImportersValue {
  files: readonly ImportedFile[];
}

/** The nodes a file holds that are not something it declares: the file itself and its import and export statements. */
export const NOT_DECLARED_KINDS: readonly string[] = ["file", "import", "export"];

/** The file name without its last extension; a module is named by a path that ends with it. */
function stemOf(file: string): string {
  const name = file.slice(file.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * The other files with an unresolved reference whose name, or the tail of it, is one of the file's declared names, or
 * whose name holds the file's stem.
 */
export function unresolvedNamersOf(file: string, declared: ReadonlySet<string>, references: readonly UnresolvedUse[]): string[] {
  const stem = stemOf(file);
  const namers = references.filter((reference) => reference.file !== file && (reference.name.includes(stem) || declared.has(reference.name) || declared.has(nameTail(reference.name))));
  return sortedUnique(namers.map((reference) => reference.file));
}

export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
