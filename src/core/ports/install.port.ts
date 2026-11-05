import type { TrustMode } from "../domain/shared/fact.ts";
import type { Result } from "../domain/shared/result.ts";
import type { FixedLayerRefresh, FixedLayerRefreshFault } from "./fixed-layer-admin.port.ts";
import type { LocalExcludeFault } from "./local-exclude.port.ts";
import type { TrustRecordFault } from "./trust-record.port.ts";
import type { VcsFault } from "./vcs.port.ts";
import type { WorkspaceManifestFault } from "./workspace-defaults.port.ts";

export interface InstallRequest {
  /** The root of a git repository. */
  repo: string;
  /** The stable name recorded in the fixed layer's snapshot. */
  repoId: string;
  /** The user's declaration; there is no default. */
  trust: TrustMode;
  /** A workspace manifest to persist, as its file states it, and the path it came from for the fault that names it. */
  workspace?: { path: string; text: string };
  signal?: AbortSignal;
}

export interface InstallOutcome {
  trust: TrustMode;
  /** The lines this run added to the repository's local exclude file; empty when it already held them all. */
  excluded: readonly string[];
  layer: FixedLayerRefresh;
  /** The manifest this run persisted and whether the stored bytes already were it; absent without a manifest. */
  workspace?: { outcome: "written" | "unchanged" };
}

export type InstallFault = (VcsFault | TrustRecordFault | LocalExcludeFault | FixedLayerRefreshFault | WorkspaceManifestFault) & {
  /** Whether the trust declaration was already recorded when the install stopped. */
  trustRecorded: boolean;
  stage: "preflight" | "trust" | "exclude" | "workspace" | "layer";
};

export interface BatchInstallRequest {
  launch: { path: string; id: string };
  repositories: readonly { path: string; id: string }[];
  trust: TrustMode;
  workspace?: { path: string; text: string };
  signal?: AbortSignal;
}

export type BatchSelectionFault = { kind: "invalid-selection" | "duplicate-repository-id" | "conflicting-repository-alias"; detail: string };
export interface BatchInstallReport {
  termination?: "aborted" | "unexpected";
  targets: readonly {
    requestedPaths: readonly string[]; id: string; canonicalRoot?: string;
    status: "completed" | "failed" | "not-attempted";
    trust: "recorded" | "not-recorded" | "unknown";
    outcome?: InstallOutcome; stage?: InstallFault["stage"]; fault?: InstallFault | BatchSelectionFault;
  }[];
}

/**
 * `ye-ast init`: the one command that declares trust, edits the local exclude file and writes the fixed layer of a
 * repository. Only the CLI receives it; no transport that faces an agent may.
 */
export interface Install {
  runBatch(request: BatchInstallRequest): Promise<BatchInstallReport>;
  run(request: InstallRequest): Promise<Result<InstallOutcome, InstallFault>>;
}
