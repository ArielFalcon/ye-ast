import type { ImpactBudget } from "../domain/impact/impact-fact.ts";
import type { ImpactValue } from "../domain/impact/impact-fact.ts";
import type { CallSite } from "../domain/topology/call-site.ts";
import type { ImpactedLink } from "../domain/topology/link.ts";
import type { Fact, SnapshotRef } from "../domain/shared/fact.ts";
import type { ScopeRequest } from "../domain/shared/scope.ts";
import type { Result } from "../domain/shared/result.ts";
import type { Gateway } from "../domain/topology/link-match.ts";
import type { CallersTarget, ImpactFault } from "./impact-queries.port.ts";
import type { WorkspaceFault, WorkspaceReposRequest, WorkspaceRepositoryRequest } from "./workspace-repos.port.ts";

/** What one repository contributes to a cross-repository answer. */
export interface RepoImpact {
  /** The trigger repository's own walk, or for another repository the walk from its call sites that landed in what the trigger's walk reached. */
  impact?: ImpactValue;
  /** The call sites of this repository that reach an entrypoint the walk reached. */
  callSites: readonly CallSite[];
  /** The call sites that reached a declared service and matched none of its entrypoints. */
  unmatched: readonly CallSite[];
  /** The call sites that name a service no declared repository serves. */
  external: readonly CallSite[];
}

export interface WorkspaceImpactValue {
  workspace: { repos: readonly string[]; gateways: readonly Gateway[]; unserved: readonly string[] };
  repositorySnapshots: readonly { repo: string; snapshot: SnapshotRef }[];
  trigger: { repo: string; mergeBase?: string };
  sections: Readonly<Record<string, Fact<RepoImpact>>>;
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
 * change of the trigger repository, including the call sites of other repositories that land in what the walk reaches,
 * and what those call sites state about services no repository given serves.
 */
export interface WorkspaceImpactQueries {
  callers(request: WorkspaceCallersRequest): Promise<Result<Fact<WorkspaceImpactValue>, ImpactFault | WorkspaceFault>>;
  ofChange(request: WorkspaceOfChangeRequest): Promise<Result<Fact<WorkspaceImpactValue>, ImpactFault | WorkspaceFault>>;
}
