import type { TrustMode } from "../domain/shared/fact.ts";
import type { Result } from "../domain/shared/result.ts";
import type { FixedLayerRefresh, FixedLayerRefreshFault } from "./fixed-layer-admin.port.ts";
import type { LocalExcludeFault } from "./local-exclude.port.ts";
import type { TrustRecordFault } from "./trust-record.port.ts";
import type { VcsFault } from "./vcs.port.ts";

export interface InstallRequest {
  /** The root of a git repository. */
  repo: string;
  /** The stable name recorded in the fixed layer's snapshot. */
  repoId: string;
  /** The user's declaration; there is no default. */
  trust: TrustMode;
  signal?: AbortSignal;
}

export interface InstallOutcome {
  trust: TrustMode;
  /** The lines this run added to the repository's local exclude file; empty when it already held them all. */
  excluded: readonly string[];
  layer: FixedLayerRefresh;
}

export type InstallFault = (VcsFault | TrustRecordFault | LocalExcludeFault | FixedLayerRefreshFault) & {
  /** Whether the trust declaration was already recorded when the install stopped. */
  trustRecorded: boolean;
};

/**
 * `ye-ast install`: the one command that declares trust, edits the local exclude file and writes the fixed layer of a
 * repository. Only the CLI receives it; no transport that faces an agent may.
 */
export interface Install {
  run(request: InstallRequest): Promise<Result<InstallOutcome, InstallFault>>;
}
