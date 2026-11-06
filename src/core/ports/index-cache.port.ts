import type { Result } from "../domain/shared/result.ts";
import type { CodeGraphFault, CodeGraphReader, IndexSummary } from "./code-graph.port.ts";

export interface IndexedSnapshot {
  /** The caller closes it. */
  store: CodeGraphReader;
  summary: IndexSummary;
}

export interface IndexRequest {
  /**
   * The content digest of the snapshot ([RFC-0002](../../../docs/architecture/rfc/0002-facts-contract.md) rule 5):
   * two snapshots with equal `content` stage the same files.
   */
  content: string;
  snapshot: string;
  /**
   * Makes `snapshot` hold the files of the snapshot. Called once, and only when an index has to be built, never when a
   * kept index is reused: a snapshot whose content is kept need not be written. A fault fails the obtain with it.
   */
  prepare?: () => Promise<Result<void, CodeGraphFault>>;
  signal: AbortSignal | undefined;
}

/**
 * Full indexes kept by the content they were built from. A kept index is never modified: a snapshot whose content,
 * engine versions and staging rules match one reuses it, and any other builds a new one. An index that cannot be
 * opened is never used. A fault of kind `cache-unavailable` means the cache itself cannot be used; the caller may
 * build without it. Retention removes kept indexes by last use and size, never one an open reader holds.
 */
export interface IndexCache {
  obtain(request: IndexRequest): Promise<Result<IndexedSnapshot, CodeGraphFault>>;
}

/** How long a kept index nobody uses may stay, and the logical bytes the whole cache may occupy ([ADR-0027](../../../docs/architecture/adr/0027-retention-of-immutable-index-entries.md)). */
export interface IndexRetentionPolicy {
  unusedForMs: number;
  maxBytes: number;
}

/** One kept index removed by retention: its logical bytes and the bytes the cache keeps after the removal. */
export interface IndexDiscard {
  entryBytes: number;
  retainedBytes: number;
}
