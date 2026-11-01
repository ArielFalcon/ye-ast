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
  signal: AbortSignal | undefined;
}

/**
 * Full indexes kept by the content they were built from. A kept index is never modified: a snapshot whose content,
 * engine versions and staging rules match one reuses it, and any other builds a new one. An index that cannot be
 * opened is never used. A fault of kind `cache-unavailable` means the cache itself cannot be used; the caller may
 * build without it.
 */
export interface IndexCache {
  obtain(request: IndexRequest): Promise<Result<IndexedSnapshot, CodeGraphFault>>;
}
