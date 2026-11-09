/** A requested target the snapshot cannot resolve: a symbol, a line range, or the file itself. */
export type UnknownTarget = { symbol: string } | { start: number; end: number } | { wholeFile: true };

export type UnknownSymbolEntry = UnknownTarget & {
  file: string;
  /** Whether no entry of the commit holds a file at `file` at all. */
  absent: boolean;
  /**
   * What could be asked instead, sorted and once each: when `absent`, repository-relative paths of the snapshot (the
   * files declaring a symbol of that name, or the files of that basename for a line range); otherwise dotted
   * containment paths (of the seedable declarations for `callers`, of every declaration for an outline focus). Empty
   * when nothing in the snapshot could be asked instead.
   */
  candidates: readonly string[];
};

/** `file:symbol`, `file:start-end`, or `file`. */
export function unknownTargetKey(entry: UnknownSymbolEntry): string {
  if ("symbol" in entry) return `${entry.file}:${entry.symbol}`;
  if ("wholeFile" in entry) return entry.file;
  return `${entry.file}:${entry.start}-${entry.end}`;
}

/** The sentence after the key: absent, declaring no symbol, or what the file declares. */
export function unknownEntryText(entry: { file: string; candidates: readonly string[]; absent?: boolean }): string {
  if (entry.absent === true) return entry.candidates.length === 0 ? `${entry.file} is not in the snapshot` : `${entry.file} is not in the snapshot; snapshot paths: ${entry.candidates.join(", ")}`;
  return entry.candidates.length === 0 ? `${entry.file} declares no symbol` : `declared in ${entry.file}: ${entry.candidates.join(", ")}`;
}

/** The same sentence for an `unknown-entrypoint` entry. */
export function entrypointCandidateText(entry: { kind: string; name: string; candidates: readonly string[] }): string {
  return entry.candidates.length === 0 ? `the map holds no ${entry.kind}` : `the map's ${entry.kind} names: ${entry.candidates.join(", ")}`;
}
