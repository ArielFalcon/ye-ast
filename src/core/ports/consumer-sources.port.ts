import type { Handler, HttpMethod } from "../domain/entrypoints/http-route.ts";
import type { Hypothesis } from "../domain/contracts/hypothesis.ts";
import type { CallSiteReach, Cut, DeclaredConfig, Evidence, FactBase, SnapshotRef } from "../domain/shared/fact.ts";
import type { Result } from "../domain/shared/result.ts";
import type { PlacedCallSite } from "../domain/topology/call-site.ts";
import type { Link } from "../domain/topology/link.ts";
import type { ConsumerFlowReader } from "./consumer-flow.port.ts";
import type { ConsumerTemplateReader } from "./consumer-template.port.ts";
import type { RequestOriginReader } from "./request-origins.port.ts";
import type { WorkspaceRequest } from "./workspace-queries.port.ts";
import type { WorkspaceFault } from "./workspace-repos.port.ts";

/**
 * One place a function depends on the function asked about: what it does there and how sure the code graph is. A caller
 * that depends on it at several places is several occurrences.
 */
export interface ConsumerCaller {
  /** The file of the calling function. */
  file: string;
  /** The first line of the calling function. */
  line: number;
  /** The line of this occurrence, in `resource` when it is written in a template; absent when the graph places none. */
  at?: number;
  resource?: string;
  /** A call, a reference that only names the function, or another dependence (dispatch, injection, import). */
  kind: "call" | "reference" | "other";
  /** `heuristic` for an edge the graph's resolver guessed; `resolved` for everything else. */
  provenance: "resolved" | "heuristic";
  confidence: number;
  /** Whether the occurrence is a call that was not guessed, with no dispatch or replaceable receiver. */
  proven: boolean;
}

export type ConsumerCallers = { kind: "unavailable" } | { kind: "unresolved" } | { kind: "found"; callers: readonly ConsumerCaller[] };

/** What a read of a class member goes through: `this` in the class or a subclass, an instance the framework injects, the component in its own template, or anything else. */
export type MemberReceiver = "this" | "injected" | "template" | "other";

/** One place a class member is read. `line` and `column` (1-based) are in `resource` when the read is written in a template, in `file` otherwise. */
export interface ConsumerMemberOccurrence {
  /** The file of the code that holds the read; for a template, the file of its component. */
  file: string;
  line: number;
  column: number;
  resource?: string;
  receiver: MemberReceiver;
}

export type ConsumerMemberOccurrences = { kind: "unavailable" } | { kind: "unresolved" } | { kind: "found"; occurrences: readonly ConsumerMemberOccurrence[] };

/**
 * A repository's call sites with their places and, where the extraction propagated one, the bodies and the leaf it came
 * through; `not-read` when the session holds no placed sites of the repository, which never stands for "none".
 */
export type ConsumerPlacedSites =
  | {
      kind: "read";
      sites: readonly PlacedCallSite[];
      /** The read's own sources: an origin in any other path is not an owned call of the repository. */
      owned: ReadonlySet<string>;
    }
  | { kind: "not-read" };

/** The answers of a workspace to one hypothesis: what the hypothesis selects, and what the workspace holds whatever the hypothesis. */
export interface ConsumerSession {
  /** The links of the HTTP call sites that one repository serves alone, matched over every repository of the workspace including their own. */
  links: readonly Link[];
  /** The cuts of the frontier walked so far: contradicted records the walk could reach, and the reading's own typed cuts. */
  cutsAfterWalk(): readonly Cut[];
  /** The repositories that serve the operation asked about, with the handler that does. */
  serving: readonly { repo: string; handler: Handler }[];
  /** The HTTP call sites whose destination remains uncertain, with any independently established reach and causal evidence. */
  unresolvedCalls: readonly { repo: string; file: string; line: number; symbol: string; reach?: CallSiteReach; evidence?: readonly Evidence[] }[];
  /** The HTTP call sites that reach a route of the operation in more than one repository, which the join does not pick between. */
  ambiguousCalls: readonly { from: Link["from"]; repos: readonly string[] }[];
  /**
   * Whether the join's ladder, over the routes of the operation asked about and the workspace's gateways, links no call
   * with that reach to it. A known method may exclude incompatible operations without a template.
   */
  excludes(site: CallSiteReach): boolean;
  /** The callers of a function of a repository: the code graph's, with the calls made through injected fields and locals. */
  callers(declaration: { repo: string; file: string; symbol: string; line: number }): ConsumerCallers;
  /** The places a member of a class of a repository is read, with the receiver each goes through. */
  memberOccurrences(member: { repo: string; file: string; owner: string; member: string }): ConsumerMemberOccurrences;
  flow: ConsumerFlowReader;
  templates: ConsumerTemplateReader;
  /** The repository's call sites with their places; `not-read` when the session does not read the repository or has no reader of placed sites. */
  placedSites(repo: string): Promise<ConsumerPlacedSites>;
  /** The reader of request bodies of a repository the session reads; a repository it does not read has none. */
  requestOrigins(repo: string): RequestOriginReader | undefined;
}

/** The operation of the workspace that serves a path a contract declares, as the route of its handler names it. */
export type ServingOperation = { kind: "served"; method: HttpMethod; path: string } | { kind: "ambiguous"; repos: readonly string[] } | { kind: "unserved" };

/** A workspace read once for a set of hypotheses: everything a hypothesis does not change. */
export interface PreparedWorkspace {
  /** The fact envelope of an answer over this workspace; its config declares what was asked. */
  base(asked: Pick<DeclaredConfig, "hypotheses" | "base" | "head">): FactBase;
  /** Each repository the workspace read resolved, with its snapshot, sorted by repository. */
  repositorySnapshots: readonly { repo: string; snapshot: SnapshotRef }[];
  /** What the reading of the snapshots already cut, such as an export budget. */
  cuts: readonly Cut[];
  /** The cuts of each partial section of the read, by repository: what its `section-partial` cut in `cuts` stands for. */
  sectionCuts: Readonly<Record<string, readonly Cut[]>>;
  /** The session of one hypothesis on this workspace; it stays valid until the holder of the workspace releases it. */
  session(hypothesis: Hypothesis): Promise<Result<ConsumerSession, WorkspaceFault>>;
}

/** A prepared workspace that also names the operations a contract declares as the routes of its handlers do. */
export interface ServingWorkspace extends PreparedWorkspace {
  /** Which route serves the operation a contract declares, by the same matching that links a call to a route; no route and several repositories are answers of their own. */
  serving(declared: { method: HttpMethod; path: string }): ServingOperation;
}

export interface ConsumerSources {
  /** Prepares the workspace, runs `use` and releases what it held, whether `use` answers or throws. */
  withWorkspace<T>(request: WorkspaceRequest, use: (workspace: ServingWorkspace) => Promise<T>): Promise<Result<T, WorkspaceFault>>;
}
