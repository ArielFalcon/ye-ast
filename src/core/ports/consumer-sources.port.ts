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

/** A function that calls the function asked about, and how sure the code graph is of the call. */
export interface ConsumerCaller {
  /** The file of the calling function. */
  file: string;
  /** The first line of the calling function. */
  line: number;
  /** The lines of the calls, in `resource` when the call is written in a template; empty when the graph places none. */
  lines: readonly number[];
  resource?: string;
  /** Whether the dependence is a call the graph resolved; a reference, a dispatch or a heuristic edge is not. */
  proven: boolean;
}

export type ConsumerCallers = { kind: "unavailable" } | { kind: "unresolved" } | { kind: "found"; callers: readonly ConsumerCaller[] };

/** The snapshots of a workspace read once, for the duration of one consequences query. */
export interface ConsumerSession {
  /** The fact envelope of the answer; its config declares the hypothesis. */
  base: FactBase;
  /** The links the workspace join admitted, once per `Link.id`, and those a repository's own calls make to its own routes. */
  links: readonly Link[];
  /** The repositories that serve the operation asked about, with the handler that does. */
  serving: readonly { repo: string; handler: Handler }[];
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
