import type { Fact, SnapshotRef } from "../domain/shared/fact.ts";
import type { Result } from "../domain/shared/result.ts";
import type { NameCandidate, OutwardName } from "../domain/topology/outward-name.ts";
import type { WorkspaceFault, WorkspaceReposRequest, WorkspaceRepositoryRequest, WorkspaceRepository, WorkspaceSection } from "./workspace-repos.port.ts";

export interface WorkspaceValue {
  workspace: {
    /** The ids of every repository read, sorted. */
    repos: readonly string[];
    /** The gateway prefixes the caller declared, sorted by prefix. */
    gateways: readonly { prefix: string; repo: string }[];
  };
  /** One snapshot per repository read, sorted by repository. */
  repositorySnapshots: readonly { repo: string; snapshot: SnapshotRef }[];
  /** One fact per repository: the outward names it states, and its entrypoints when the request read them. */
  sections: Readonly<Record<string, Fact<WorkspaceSection>>>;
  /** The names a local repository serves, with the basis that says why. */
  candidates: readonly NameCandidate[];
  /** The names no repository given serves: the agent's next step. */
  unserved: readonly OutwardName[];
  /** The repositories read, for the query families that join over them. */
  repositories: readonly WorkspaceRepository[];
}

export interface WorkspaceRequest extends WorkspaceReposRequest {
  /** The repository the request is bound to: the one whose snapshot anchors the answer. */
  repo: WorkspaceRepositoryRequest;
  /** A gateway prefix the caller declares and the repository it routes to; it overrides an inferred one. */
  gateways?: readonly { prefix: string; repo: string }[];
}

/**
 * What a set of local repositories states about each other: the names each one writes outward, the local repository that
 * serves each name with its basis, and the names nothing given serves. Read without a network request, each repository
 * under its own trust declaration.
 */
export interface WorkspaceQueries {
  outwardNames(request: WorkspaceRequest): Promise<Result<Fact<WorkspaceValue>, WorkspaceFault>>;
}
