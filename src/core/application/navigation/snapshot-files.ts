import { sortedUnique } from "../../domain/impact/importers-fact.ts";
import type { CodeGraphReader } from "../../ports/code-graph.port.ts";
import type { UnknownSymbolEntry } from "../../ports/impact-queries.port.ts";
import type { CommitExport } from "../../ports/vcs.port.ts";

/** An unknown target before the snapshot decides whether its file is there. */
export type RawUnknownEntry = ({ symbol: string } | { start: number; end: number }) & { file: string; candidates: readonly string[] };

/** What the snapshot listing says about the files a request names. */
export interface SnapshotFiles {
  /** Whether the snapshot holds a file at this path. */
  holds(file: string): boolean;
  /** `entries` with presence decided; an absent file lists the snapshot paths that could be asked instead. */
  describe(entries: readonly RawUnknownEntry[]): UnknownSymbolEntry[];
}

/** The files of a snapshot listing, so a request naming a path it does not hold says so instead of declaring nothing. */
export function snapshotFiles(store: CodeGraphReader, listing: readonly string[]): SnapshotFiles {
  const files = new Set(listing);
  const holds = (file: string): boolean => files.has(file);
  return {
    holds,
    describe: (entries) =>
      entries.map((entry) => (holds(entry.file) ? { ...entry, absent: false } : { ...entry, absent: true, candidates: candidatesOf(store, listing, entry) })),
  };
}

/** The snapshot paths a target could name instead: those declaring its symbol's own name, or those of its basename for a range. */
function candidatesOf(store: CodeGraphReader, listing: readonly string[], entry: RawUnknownEntry): string[] {
  if ("symbol" in entry) return sortedUnique(store.declarationsNamed([entry.symbol.slice(entry.symbol.lastIndexOf(".") + 1)]).map(({ file }) => file));
  const name = baseNameOf(entry.file);
  return sortedUnique(listing.filter((file) => baseNameOf(file) === name));
}

function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Every path the commit holds: the files the export accepted and the ones it skipped, in the export's order; `undefined`
 * when a budget stopped the export, since nothing at or after the stop is listed.
 */
export function heldPaths(exported: CommitExport): readonly string[] | undefined {
  return exported.stopped === undefined ? [...exported.files, ...exported.skipped].map(({ path }) => path) : undefined;
}

/**
 * The snapshot paths that could be `file` instead, first non-empty step winning: the same basename (a moved file), the
 * same directory with stem affinity (`label-update` ↔ `label-update.component`), the whole same-extension directory.
 * Steps 1 and 2 keep the requested extension; a path with none restricts nothing there and offers no third step.
 */
export function wholeFileCandidates(file: string, listing: readonly string[]): readonly string[] {
  const basename = baseNameOf(file);
  const directory = directoryOf(file);
  const extension = extensionOf(file);
  const sameExtension = (path: string): boolean => extension === "" || extensionOf(path) === extension;
  const here = listing.filter((path) => directoryOf(path) === directory);
  const steps = [
    () => listing.filter((path) => baseNameOf(path) === basename && sameExtension(path)),
    () => here.filter((path) => sameExtension(path) && stemAffine(stemOf(file), stemOf(path))),
    () => (extension === "" ? [] : here.filter((path) => extensionOf(path) === extension)),
  ];
  for (const step of steps) {
    const found = step();
    if (found.length > 0) return sortedUnique(found);
  }
  return [];
}

/** The decided `unknown-symbol` entries for the requested files no listing path holds, in request order. */
export function absentFileEntries(requested: readonly string[], listing: readonly string[]): UnknownSymbolEntry[] {
  const held = new Set(listing);
  return requested.filter((file) => !held.has(file)).map((file): UnknownSymbolEntry => ({ file, wholeFile: true, absent: true, candidates: wholeFileCandidates(file, listing) }));
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** The text after the last dot of the basename; empty when the basename has none. */
function extensionOf(path: string): string {
  const name = baseNameOf(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1);
}

function stemOf(path: string): string {
  const name = baseNameOf(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

function stemAffine(left: string, right: string): boolean {
  return left === right || right.startsWith(`${left}.`) || left.startsWith(`${right}.`);
}
