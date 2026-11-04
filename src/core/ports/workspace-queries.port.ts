import type { Fact, SnapshotRef } from "../domain/shared/fact.ts";
import type { Result } from "../domain/shared/result.ts";
import type { NameCandidate, RepositoryOutwardName } from "../domain/topology/outward-name.ts";
import type { RemoteFreshness, RepositoryResolution } from "../domain/topology/remote-snapshot.ts";
import type { WorkspaceFault, WorkspaceReposRequest, WorkspaceRepositoryRequest, WorkspaceRepository, WorkspaceSection, WorkspaceSource } from "./workspace-repos.port.ts";

export interface WorkspaceValue {
  workspace: {
    /** The ids of every repository the request named, sorted. */
    repos: readonly string[];
    /** The gateway prefixes the caller declared, sorted by prefix. */
    gateways: readonly { prefix: string; repo: string }[];
    /** Where the repositories above came from; `none` says the answer covers the bound repository alone. */
    source: WorkspaceSource;
  };
  /** One snapshot per repository read, sorted by repository. */
  repositorySnapshots: readonly { repo: string; snapshot: SnapshotRef }[];
  /** One fact per repository: the outward names it states, and its entrypoints when the request read them. */
  sections: Readonly<Record<string, Fact<WorkspaceSection>>>;
  /** The names a local repository serves, with the basis that says why. */
  candidates: readonly NameCandidate[];
  /** The names no repository given serves: the agent's next step. */
  unserved: readonly RepositoryOutwardName[];
  /** The repositories read, for the query families that join over them. */
  repositories: readonly WorkspaceRepository[];
}

/**
 * What a query refreshed before reading, carried beside the fact and never inside it (ADR-0016 decision 4): the sha each
 * refreshed repository pinned, and whether each remote was verified.
 */
export interface WorkspaceRefresh {
  /** One record per repository refreshed, sorted by repository. */
  resolution: readonly RepositoryResolution[];
  /** The freshness of each remote refreshed, sorted by repository then URL. */
  freshness: readonly { repo: string; url: string; freshness: RemoteFreshness }[];
}

/** An answer that carries, beside its fact, what the read refreshed to decide it. */
export interface FactRead<T> {
  fact: Fact<T>;
  /** Original declared clone roots, carried outside deterministic facts. */
  repositoryRoots?: readonly { repo: string; path: string }[];
  /** Internal read locations, which can be mirrors; excluded from deterministic facts. */
  repositorySources?: readonly { repo: string; path: string }[];
  /** Absent when the query refreshed nothing, so an answer without a refresh carries no sidecar. */
  refresh?: WorkspaceRefresh;
}

/** The answer of a workspace read: the fact, and the refreshes that decided what it read. */
export type WorkspaceRead = FactRead<WorkspaceValue>;

export interface WorkspaceRequest extends WorkspaceReposRequest {
  /** The repository the request is bound to: the one whose snapshot anchors the answer. */
  repo: WorkspaceRepositoryRequest;
  /** A gateway prefix the caller declares and the repository it routes to; it overrides an inferred one. */
  gateways?: readonly { prefix: string; repo: string }[];
}

/**
 * What a set of repositories states about each other: the names each one writes outward, the local repository that
 * serves each name with its basis, and the names nothing given serves. Each repository is read under its own trust
 * declaration; under `trusted`, a declared remote is refreshed into ye-ast's mirror and the repository is read there at
 * the pinned sha.
 */
export interface WorkspaceQueries {
  outwardNames(request: WorkspaceRequest): Promise<Result<WorkspaceRead, WorkspaceFault>>;
}
