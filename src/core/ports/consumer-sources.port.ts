import type { Handler } from "../domain/entrypoints/http-route.ts";
import type { Hypothesis } from "../domain/contracts/hypothesis.ts";
import type { Cut, FactBase } from "../domain/shared/fact.ts";
import type { Result } from "../domain/shared/result.ts";
import type { Link } from "../domain/topology/link.ts";
import type { ConsumerFlowReader } from "./consumer-flow.port.ts";
import type { ConsumerTemplateReader } from "./consumer-template.port.ts";
import type { WorkspaceRequest } from "./workspace-queries.port.ts";
import type { WorkspaceFault } from "./workspace-repos.port.ts";

export type ConsumerSessionRequest = WorkspaceRequest & { hypothesis: Hypothesis };

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

/** The snapshots of a workspace read once, for the duration of one consequences query. */
export interface ConsumerSession {
  /** The fact envelope of the answer; its config declares the hypothesis. */
  base: FactBase;
  /** The links of the HTTP call sites that one repository serves alone, matched over every repository of the workspace including their own. */
  links: readonly Link[];
  /** The repositories that serve the operation asked about, with the handler that does. */
  serving: readonly { repo: string; handler: Handler }[];
  /** The HTTP call sites of the workspace whose target no read could evaluate: any of them may call the operation. */
  unresolvedCalls: readonly { repo: string; file: string; line: number; symbol: string }[];
  /** The HTTP call sites that reach a route of the operation in more than one repository, which the join does not pick between. */
  ambiguousCalls: readonly { from: Link["from"]; repos: readonly string[] }[];
  /** What the reading of the snapshots already cut, such as an export budget. */
  cuts: readonly Cut[];
  /** The callers of a function of a repository: the code graph's, with the calls made through injected fields and locals. */
  callers(declaration: { repo: string; file: string; symbol: string; line: number }): ConsumerCallers;
  flow: ConsumerFlowReader;
  templates: ConsumerTemplateReader;
}

export interface ConsumerSources {
  /** Opens the session, runs `use` and releases what the session held, whether `use` answers or throws. */
  withSession<T>(request: ConsumerSessionRequest, use: (session: ConsumerSession) => Promise<T>): Promise<Result<T, WorkspaceFault>>;
}
