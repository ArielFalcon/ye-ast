import { isBareName, referencedName, type UnresolvedUse } from "./impact-cuts.ts";
import { sharesRuntime } from "../languages/call-targets.ts";
import { compareText } from "../shared/code-node.ts";

export interface ImportPlace { readonly file: string; readonly line: number }

/** Who depends on one file, as repo-relative paths sorted by code unit; the file itself is never listed. */
export interface ImportedFile {
  file: string;
  places?: readonly ImportPlace[];
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
 * candidate names none of them, so a homonym elsewhere is never a namer. A reference of another runtime names no file.
 */
export function unresolvedNamersOf(file: string, declared: ReadonlySet<string>, qualified: ReadonlySet<string>, references: readonly UnresolvedUse[]): string[] {
  return sortedUnique(unresolvedReferencesOf(file, declared, qualified, references).map((reference) => reference.file));
}

export function unresolvedPlacesOf(file: string, declared: ReadonlySet<string>, qualified: ReadonlySet<string>, references: readonly UnresolvedUse[]): ImportPlace[] {
  const places = unresolvedReferencesOf(file, declared, qualified, references).filter(({ line }) => Number.isInteger(line) && line > 0).map(({ file, line }) => ({ file, line }));
  return [...new Map(places.map((place) => [`${place.file}\0${place.line}`, place])).values()].sort((a, b) => compareText(a.file, b.file) || a.line - b.line);
}

function unresolvedReferencesOf(file: string, declared: ReadonlySet<string>, qualified: ReadonlySet<string>, references: readonly UnresolvedUse[]): UnresolvedUse[] {
  const stem = stemOf(file);
  return references.filter((reference) => reference.file !== file && sharesRuntime(reference.file, file) && namesIt(reference, declared, qualified, stem));
}

function namesIt(reference: UnresolvedUse, declared: ReadonlySet<string>, qualified: ReadonlySet<string>, stem: string): boolean {
  const name = referencedName(reference);
  if (segmentsOf(name).includes(stem)) return true;
  if (isBareName(name)) return declared.has(name);
  return (reference.candidates ?? []).some((candidate) => qualified.has(candidate));
}

/** A set of strings: unique, in code-unit order. */
export function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareText);
}
