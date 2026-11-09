import { sortedUnique } from "../../domain/impact/importers-fact.ts";
import type { CodeGraphReader } from "../../ports/code-graph.port.ts";
import type { UnknownSymbolEntry } from "../../ports/impact-queries.port.ts";

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

/** The snapshot paths a target could name instead: those declaring its symbol, or those of its basename for a range. */
function candidatesOf(store: CodeGraphReader, listing: readonly string[], entry: RawUnknownEntry): string[] {
  if ("symbol" in entry) return sortedUnique(store.declarationsNamed([entry.symbol]).map(({ file }) => file));
  const name = baseNameOf(entry.file);
  return sortedUnique(listing.filter((file) => baseNameOf(file) === name));
}

function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
