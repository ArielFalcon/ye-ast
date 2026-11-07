import { isBareName, type UnresolvedUse } from "./impact-cuts.ts";
import { compareText } from "../shared/code-node.ts";

/** Who depends on one file, as repo-relative paths sorted by code unit; the file itself is never listed. */
export interface ImportedFile {
  file: string;
  /** Direct static imports and indexed imports into the file or its declarations, test files included when exported. */
  importers: readonly string[];
  reexporters?: readonly string[];
  dynamicImporters?: readonly string[];
  typeImporters?: readonly string[];
  /** Files with an edge of any kind but containment and a name match into the file or a symbol it declares, test files included. */
  users: readonly string[];
  /**
   * Files holding a reference the index could not resolve that names the file or a symbol it declares, or whose only
   * dependence on it is an edge the index matched by name alone (ADR-0036).
   */
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

/** The segments a reference is made of: a module path, a qualifier, a member. */
function segmentsOf(name: string): string[] {
  return name.split(/[.:#\\/]/);
}

/**
 * The other files with an unresolved reference that names one of the file's declared names, one of its qualified names
 * the index considered, or a segment equal to the file's stem; a qualified reference the index attributed to no
 * candidate names none of them, so a homonym elsewhere is never a namer.
 */
export function unresolvedNamersOf(file: string, declared: ReadonlySet<string>, qualified: ReadonlySet<string>, references: readonly UnresolvedUse[]): string[] {
  const stem = stemOf(file);
  const namers = references.filter((reference) => reference.file !== file && namesIt(reference, declared, qualified, stem));
  return sortedUnique(namers.map((reference) => reference.file));
}

function namesIt(reference: UnresolvedUse, declared: ReadonlySet<string>, qualified: ReadonlySet<string>, stem: string): boolean {
  if (segmentsOf(reference.name).includes(stem)) return true;
  if (isBareName(reference.name)) return declared.has(reference.name);
  return (reference.candidates ?? []).some((candidate) => qualified.has(candidate));
}

/** A set of strings: unique, in code-unit order. */
export function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareText);
}
