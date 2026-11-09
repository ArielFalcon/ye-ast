import type { Decision } from "../domain/decisions/decision.ts";
import type { SnapshotRef } from "../domain/shared/fact.ts";
import type { Result } from "../domain/shared/result.ts";
import type { UnresolvedCallSite } from "../domain/topology/call-site.ts";
import type { WorkspaceFault, WorkspaceSource } from "./workspace-repos.port.ts";
import type { FactRead, WorkspaceRequest } from "./workspace-queries.port.ts";

/** The workspace the decision set is derived from: the bound repository, the clones passed and the gateways declared. */
export type DecisionsRequest = Omit<WorkspaceRequest, "replay">;

/** The gaps of one workspace read, each with every option it can verify, and the snapshot of every repository read. */
export interface DecisionValue {
  decisions: readonly Decision[];
  repositories: readonly { repo: string; snapshot: SnapshotRef }[];
  /** Where the repositories this set was derived from came from; `none` says it read the bound repository alone. */
  source: WorkspaceSource;
  /** The call sites the workspace sections list as undecided, by repository then place: undecided items, never cuts (ADR-0042 decision 6). */
  unresolved: readonly (UnresolvedCallSite & { repo: string })[];
}

/**
 * The read-only question "what does this workspace not state, and which options can I verify?": the clones that serve a
 * name, the clones that name nothing, the outward names no repository given serves, the prefixes that route nowhere and
 * the repositories without a trust record. The harness renders the set and the user answers it; nothing here writes.
 */
export interface DecisionQueries {
  decisions(request: DecisionsRequest): Promise<Result<FactRead<DecisionValue>, WorkspaceFault>>;
}
