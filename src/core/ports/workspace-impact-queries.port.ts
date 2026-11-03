import type { ImpactBudget } from "../domain/impact/impact-fact.ts";
import type { ImpactValue } from "../domain/impact/impact-fact.ts";
import type { CallSite } from "../domain/topology/call-site.ts";
import type { ImpactedLink } from "../domain/topology/link.ts";
import type { Fact, SnapshotRef } from "../domain/shared/fact.ts";
import type { ScopeRequest } from "../domain/shared/scope.ts";
import type { Result } from "../domain/shared/result.ts";
import type { Gateway, GatewayDeclaration } from "../domain/topology/link-match.ts";
import type { CallersTarget, ImpactFault } from "./impact-queries.port.ts";
import type { WorkspaceFault, WorkspaceReposRequest, WorkspaceRepositoryRequest, WorkspaceSource } from "./workspace-repos.port.ts";
import type { FactRead } from "./workspace-queries.port.ts";

/** What one repository contributes to a cross-repository answer. */
export interface RepoImpact {
  /** The trigger repository's own walk, or for another repository the walk from the call sites the answer admitted there. */
  impact?: ImpactValue;
  /** The call sites of this repository that reach an entrypoint the answer's walks reached. */
  callSites: readonly CallSite[];
  /** The call sites that reached a declared service and matched none of its entrypoints. */
  unmatched: readonly CallSite[];
  /** The call sites that name a service no declared repository serves. */
  external: readonly CallSite[];
}

export interface WorkspaceImpactValue {
  /** `unmatchedGateways`: the declared gateways no call site names, or whose repository was not read; `source`: where `repos` came from. */
  workspace: { repos: readonly string[]; gateways: readonly Gateway[]; unmatchedGateways: readonly GatewayDeclaration[]; unserved: readonly string[]; source: WorkspaceSource };
  repositorySnapshots: readonly { repo: string; snapshot: SnapshotRef }[];
  trigger: { repo: string; mergeBase?: string };
  sections: Readonly<Record<string, Fact<RepoImpact>>>;
  /** Every link the answer admitted, once per `Link.id`, sorted by place: upstream when a walk reached its target, downstream when the change sends it onward. */
  links: readonly ImpactedLink[];
}

export interface WorkspaceImpactBase extends WorkspaceReposRequest {
  repo: WorkspaceRepositoryRequest;
  gateways?: readonly { prefix: string; repo: string }[];
  budget?: ImpactBudget;
}

export interface WorkspaceCallersRequest extends WorkspaceImpactBase {
  targets: readonly CallersTarget[];
}

export interface WorkspaceOfChangeRequest extends WorkspaceImpactBase {
  base: string;
  head: string;
}

/**
 * The same answers the single-repository tools give, composed over a workspace: what reaches the symbols, line ranges or
 * change of the trigger repository, including the call sites of other repositories that land in what a walk reaches,
 * what those call sites state about services no repository given serves, and, for a change, the links it sends onward.
 * The links chain: each one feeds a walk in its own repository, whose reached entrypoints the next join starts from.
 */
export interface WorkspaceImpactQueries {
  callers(request: WorkspaceCallersRequest): Promise<Result<FactRead<WorkspaceImpactValue>, ImpactFault | WorkspaceFault>>;
  ofChange(request: WorkspaceOfChangeRequest): Promise<Result<FactRead<WorkspaceImpactValue>, ImpactFault | WorkspaceFault>>;
}
