import type { WarmingFault } from "../core/application/live/live-warming.ts";
import type { ContractConsequencesQueries } from "../core/ports/contract-consequences-queries.port.ts";
import type { DecisionQueries } from "../core/ports/decision-queries.port.ts";
import type { EntrypointQueries } from "../core/ports/entrypoint-queries.port.ts";
import type { ImpactQueries } from "../core/ports/impact-queries.port.ts";
import type { OutlineQueries } from "../core/ports/outline-queries.port.ts";
import type { Redaction } from "../core/ports/redaction.port.ts";
import type { TraceQueries } from "../core/ports/trace-queries.port.ts";
import type { Vcs } from "../core/ports/vcs.port.ts";
import type { WorkspaceImpactQueries } from "../core/ports/workspace-impact-queries.port.ts";
import type { WorkspaceQueries } from "../core/ports/workspace-queries.port.ts";

/** The read query families and the launch priming a composition offers its entrypoints. */
export interface ComposedQueries {
  version: string;
  entrypoints: EntrypointQueries;
  impact: ImpactQueries;
  outline: OutlineQueries;
  trace: TraceQueries;
  workspace: WorkspaceQueries;
  workspaceImpact: WorkspaceImpactQueries;
  /** What changing the contract of an operation, by hypothesis or between two revisions, does to the code that consumes it (RFC-0022, RFC-0023). */
  contractConsequences: ContractConsequencesQueries;
  decisions: DecisionQueries;
  redaction: Redaction;
  /** The name a repository answers to: the directory name of its main worktree, which every linked worktree shares. */
  repositoryName: Vcs["repositoryName"];
  /** Canonical filesystem root of the selected worktree. */
  canonicalRepositoryRoot: Vcs["canonicalRoot"];
  /**
   * Builds the live mirror of `repo` for the default scope when it is `trusted` and has none, then primes the snapshot
   * facts no target narrows, letting any query run first between steps, so the first live query finds both ready.
   * `repoId` is the id the queries name the repository by; the repository's name when absent. Resolves once priming
   * ended, to why the mirror could not be built, or `null`; it never rejects. A trusted
   * repository is also watched until `signal` or the composition's signal is aborted, and each change primes it again
   * ahead of the next query (ADR-0152).
   */
  warmLive(repo: string, signal?: AbortSignal, repoId?: string): Promise<WarmingFault | null>;
}
