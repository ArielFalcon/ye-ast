import type { Result } from "../domain/shared/result.ts";
import type { MapRequest } from "./entrypoint-queries.port.ts";
import type { FixedLayerFault } from "./fixed-layer-store.port.ts";
import type { AtRevision, LiveFault } from "./live-queries.port.ts";
import type { VcsFault } from "./vcs.port.ts";

/** The request of the map the layer is computed from, at a revision: the layer is never written from a live tree. It is written under `repo`. */
export type FixedLayerRefreshRequest = AtRevision<MapRequest>;

export type FixedLayerRefresh =
  /** `files` were written, in the order they were. */
  | { outcome: "written"; files: readonly string[] }
  /** The stored fact has the `inputs` and the producer of the current one and the digest exists, so nothing was written. */
  | { outcome: "unchanged"; files: readonly string[] }
  /** The fact cannot be stored (RFC-0002 rule 3): a deadline cut it, or its index was unavailable. */
  | { outcome: "not-written"; reason: "deadline" | "index-unavailable" };

export type FixedLayerRefreshFault = VcsFault | LiveFault | FixedLayerFault;

/**
 * Writes the fixed layer of a repository: the only write ye-ast makes to a repository's folder, and only to
 * `.ye-ast/`. A host reaches it through the library and `ye-ast init`. No entrypoint that faces an agent (the MCP
 * server, the query protocol) may import it or receive it; composition hands it to the install command alone.
 */
export interface FixedLayerAdmin {
  refresh(request: FixedLayerRefreshRequest): Promise<Result<FixedLayerRefresh, FixedLayerRefreshFault>>;
}
