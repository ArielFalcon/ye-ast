import type { DeclaredConfig, DeclaredScope, Fact, ReadProvenance, SnapshotRef, UnknownReason } from "../shared/fact.ts";
import type { WorkspaceReplayContext } from "../topology/workspace-replay.ts";

/** Who holds cuts: a read recorded under a section holds none, its section's cuts say them once. */
export type CutOwner = { kind: "fact" } | { kind: "entrypoints" } | { kind: "section"; repo: string };
/** Whose read a record or a coverage entry is, as the public surface names it. */
export type PublicReadOwner = CutOwner | { kind: "read"; repo: string; index: number };
export type Analysis = { status: "complete" } | { status: "partial" } | { status: "unknown"; reason: UnknownReason };

export function analysis(fact: ReadProvenance): Analysis {
  return fact.status === "unknown" ? { status: "unknown", reason: fact.reason } : { status: fact.status };
}

/**
 * The normalized context an `mcp-r1` identity digests beside the public fact: the selected repository, the fact's
 * snapshot, declared scope and config, and for a workspace read its replay context and effective offline policy; impact
 * adds its merge base. Recovery and composition source identity share this one definition.
 */
export type RecoveryContext = {
  repo: string; snapshot: SnapshotRef; declaredScope: DeclaredScope; declaredConfig: DeclaredConfig;
  replay?: WorkspaceReplayContext | undefined; offline?: boolean; mergeBase?: string;
};
export function recoveryContext(fact: Fact<unknown>, selected: string, crossing?: { replay: WorkspaceReplayContext | undefined; offline: boolean | undefined }, mergeBase?: string): RecoveryContext {
  return {
    repo: selected, snapshot: fact.snapshot, declaredScope: fact.inputs.declaredScope, declaredConfig: fact.inputs.declaredConfig,
    ...(crossing === undefined ? {} : { replay: crossing.replay, offline: crossing.offline === true || fact.inputs.trust === "untrusted" }),
    ...(mergeBase === undefined ? {} : { mergeBase }),
  };
}
