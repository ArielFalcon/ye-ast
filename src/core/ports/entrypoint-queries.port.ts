import type { EntrypointMapFact } from "../domain/map/entrypoint-map.ts";
import type { ScopeRequest } from "../domain/shared/scope.ts";
import type { Result } from "../domain/shared/result.ts";
import type { LiveFault, LiveSelector } from "./live-queries.port.ts";
import type { ScopeFault } from "./scope-fault.port.ts";
import type { VcsFault } from "./vcs.port.ts";

export type MapRequest = MapRequestBase & ({ revision: string; live?: undefined } | ({ revision?: undefined } & LiveSelector));

interface MapRequestBase {
  /** Path of the root of the git repository to read. */
  repo: string;
  /** Stable name of the repository in the snapshot of every fact; never a path. */
  repoId: string;
  /** Which paths the fact covers beyond the map's languages and frameworks; every path when absent. */
  scope?: ScopeRequest;
  /** Aborting stops the work, removes the temporary export and answers an `aborted` fault. */
  signal?: AbortSignal;
}

export interface EntrypointQueries {
  /**
   * The map fact of the repository at `revision`, read under `untrusted` from an export of that commit, or of its working
   * tree with `live`, read from ye-ast's mirror of it under `trusted` only and with no index.
   */
  map(request: MapRequest): Promise<Result<EntrypointMapFact, VcsFault | LiveFault | ScopeFault>>;
}
