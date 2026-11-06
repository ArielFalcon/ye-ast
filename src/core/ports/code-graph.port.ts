import type { Result } from "../domain/shared/result.ts";

/** The directory of the engine's store, written inside the directory the caller hands over; never read from a snapshot. */
export const INDEX_STORE_DIRECTORY = ".ye-ast-graph";

export interface CodeGraphFault {
  kind:
    | "platform-package-missing"
    | "stage-failed"
    | "index-failed"
    | "store-unreadable"
    | "unsupported-store"
    | "cache-unavailable"
    | "aborted";
  detail: string;
}

/** The engines that built a store: the codegraph release and the versions of its schema and extraction. */
export interface StoreVersions {
  codegraph: string;
  schema: number;
  extraction: number;
}

export interface IndexSummary {
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  /**
   * The staged snapshot files, as paths relative to the snapshot sorted by code unit, whose language the engine
   * supports and that the built store holds no file record for. The engine drops them by its own rules, for example
   * a directory named `out`, `target` or `vendor` anywhere in the path, and counts none of them as skipped. A
   * non-empty list means the index does not describe the snapshot. A file under an entry the stage leaves out
   * (`.git`, `.codegraph`, `.ye-ast`, `.ye-ast-graph`) is never staged and never listed.
   */
  filesNotIndexed: readonly string[];
  versions: StoreVersions;
}

declare const graphNodeId: unique symbol;

/**
 * Names a symbol or route inside one store, so a walk can ask for the neighbours of what it reached. It is a handle,
 * never a fact: it is not stable across codegraph versions and never reaches a fact or any output.
 */
export type GraphNodeId = string & { readonly [graphNodeId]: true };

/** `kind` and `language` use codegraph's vocabulary (`function`, `method`, `route`, `typescript`, ...). */
export interface GraphSymbol {
  id: GraphNodeId;
  kind: string;
  name: string;
  qualifiedName: string;
  file: string;
  language: string;
  startLine: number;
  endLine: number;
}

export interface GraphEdge {
  source: GraphNodeId;
  target: GraphNodeId;
  kind: string;
  line: number | null;
  column: number | null;
  /**
   * The score a resolver gave the edge, 0-1. `null` is "no score", never a default: an edge whose provenance is not
   * `heuristic` and has no score is certain; a `heuristic` edge without one is not.
   */
  confidence: number | null;
  provenance: "tree-sitter" | "scip" | "heuristic" | null;
  /** The synthesizer that added the edge, for example `interface-impl`; `null` for an edge extraction found. */
  synthesizedBy: string | null;
}

export interface GraphUnresolvedReference {
  from: GraphNodeId;
  name: string;
  kind: string;
  file: string;
  line: number;
  column: number;
  candidates: readonly string[];
}

/**
 * Read-only queries over a store. Every list is sorted, so the same store gives the same output. Paths are relative to
 * the indexed snapshot. A query on a store that fails while it is read rejects.
 */
export interface CodeGraphReader {
  readonly versions: StoreVersions;
  /** Symbols declared in `files`, by file, start line, end line and qualified name. */
  symbolsInFiles(files: readonly string[]): readonly GraphSymbol[];
  /** The symbols `ids` name, in the same order as `symbolsInFiles`; an id the store does not know is absent. */
  symbolsByIds(ids: readonly GraphNodeId[]): readonly GraphSymbol[];
  /** Every symbol whose name is exactly one of `names` (overloads, members and top level), in the order of `symbolsInFiles`. */
  declarationsNamed(names: readonly string[]): readonly GraphSymbol[];
  /** Edges pointing at `targets`, optionally only of `kinds`, by target, kind, line, column and source. */
  incomingEdges(targets: readonly GraphNodeId[], kinds?: readonly string[]): readonly GraphEdge[];
  /** Edges leaving `sources`, optionally only of `kinds`, by source, kind, line, column and target. */
  outgoingEdges(sources: readonly GraphNodeId[], kinds?: readonly string[]): readonly GraphEdge[];
  /** References from `files` that never resolved to a symbol, by file, line, column and name. */
  unresolvedReferences(files: readonly string[]): readonly GraphUnresolvedReference[];
  close(): void;
}

export interface CodeGraph {
  /**
   * Indexes `snapshot` into a store under `store`, a directory outside `snapshot` that is absent or empty, and leaves
   * `snapshot` untouched. Nothing in the snapshot configures or seeds the index: not a `codegraph.json`, a
   * `.gitignore`, nor a `.codegraph/`, `.ye-ast/` or `.ye-ast-graph/` directory, wherever they sit. A snapshot that
   * holds an entry other than a regular file or a directory is `stage-failed`, and one with no file the engine can
   * read is `unsupported-store`, since its index carries no version stamp. On a fault `store` holds an unspecified
   * part of the work and the caller discards it. Indexing runs in a child process; an aborted `signal` stops it.
   */
  index(snapshot: string, store: string, signal?: AbortSignal): Promise<Result<IndexSummary, CodeGraphFault>>;
  /**
   * Indexes `mirror` in full in place and keeps its files: `mirror` holds only regular files and directories ye-ast
   * copied, and the store is written inside it, so `open(mirror)` reads it. The same entries as `index` never configure
   * or seed it. A previous store inside `mirror` is replaced. Runs in a child process; an aborted `signal` stops it.
   */
  buildMirror(mirror: string, signal?: AbortSignal): Promise<Result<IndexSummary, CodeGraphFault>>;
  /**
   * Brings the store `buildMirror` wrote up to date for `paths`, the mirror-relative paths ye-ast added, changed or
   * deleted since, with the engine's incremental update; never called with no path. `filesNotIndexed` is recomputed
   * over every file of `mirror`, and `filesFailed` lists the paths the update could not read. Runs in a child
   * process; an aborted `signal` stops it.
   */
  syncMirror(mirror: string, paths: readonly string[], signal?: AbortSignal): Promise<Result<MirrorSyncSummary, CodeGraphFault>>;
  /** Opens a store this adapter built, read-only, after checking it against the supported versions. */
  open(store: string): Result<CodeGraphReader, CodeGraphFault>;
}

export interface MirrorSyncSummary extends IndexSummary {
  filesFailed: readonly string[];
}
