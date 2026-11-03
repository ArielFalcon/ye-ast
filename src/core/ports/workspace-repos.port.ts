import type { Entrypoint } from "../domain/entrypoints/entrypoint.ts";
import type { CallSite } from "../domain/topology/call-site.ts";
import type { WorkspaceRepositoryDeclaration } from "../domain/topology/workspace-manifest.ts";
import type { Evidence, SnapshotRef, Finding, TrustMode } from "../domain/shared/fact.ts";
import type { ScopeRequest } from "../domain/shared/scope.ts";
import type { Result } from "../domain/shared/result.ts";
import type { OutwardKind } from "../domain/topology/outward-name.ts";
import type { LiveFault } from "./live-queries.port.ts";
import type { FixedLayerFault } from "./fixed-layer-store.port.ts";
import type { VcsFault } from "./vcs.port.ts";

/** One repository of a workspace request: where it is read from, and the name its snapshot carries. */
export type WorkspaceRepositoryRequest = WorkspaceRepositoryDeclaration;

/**
 * Where the repositories an answer worked over came from: the request that asked, the manifest the bound repository
 * persists, or nowhere, which leaves the answer about the bound repository alone.
 */
export type WorkspaceSource = "request" | "persisted" | "none";

/** What a workspace request declares beyond the repository it is bound to. */
export interface WorkspaceReposRequest {
  /** Other local repositories the caller declares. */
  repos?: readonly WorkspaceRepositoryRequest[];
  scope?: ScopeRequest;
  /**
   * Reads every repository from its own clone and refreshes no declared remote, as under `untrusted`: the query reaches
   * no network, even for a repository declared `trusted` with a `remote`.
   */
  offline?: boolean;
  signal?: AbortSignal;
}

/** The outward names one repository states, with the places that state them. */
export interface WorkspaceSection {
  names: readonly { name: string; kind: OutwardKind; evidence: readonly Evidence[] }[];
  /** The call sites whose target the snapshot does not decide: each one is a place the answer cannot join. */
  unresolved: readonly Evidence[];
}

/** One repository read for a workspace answer: its snapshot, the entrypoints of that snapshot and its call sites. */
export interface WorkspaceRepository {
  repo: string;
  path: string;
  snapshot: SnapshotRef;
  entrypoints: readonly Finding<Entrypoint>[];
  callSites: readonly CallSite[];
  /** The trust the host declared for this repository; absent when it declared none. */
  declaredTrust?: TrustMode;
}

export type WorkspaceFault = VcsFault | LiveFault | FixedLayerFault | { kind: "duplicate-repository"; detail: string };
