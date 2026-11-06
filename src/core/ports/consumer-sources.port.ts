import type { Hypothesis } from "../domain/contracts/hypothesis.ts";
import type { Cut, FactBase } from "../domain/shared/fact.ts";
import type { Result } from "../domain/shared/result.ts";
import type { Link } from "../domain/topology/link.ts";
import type { CodeGraphReader } from "./code-graph.port.ts";
import type { ConsumerFlowReader } from "./consumer-flow.port.ts";
import type { ConsumerTemplateReader } from "./consumer-template.port.ts";
import type { WorkspaceRequest } from "./workspace-queries.port.ts";
import type { WorkspaceFault } from "./workspace-repos.port.ts";

export type ConsumerSessionRequest = WorkspaceRequest & { hypothesis: Hypothesis };

/** The snapshots of a workspace read once, for the duration of one consequences query. */
export interface ConsumerSession {
  /** The fact envelope of the answer; its config declares the hypothesis. */
  base: FactBase;
  /** The links the workspace join admitted, once per `Link.id`. */
  links: readonly Link[];
  /** What the reading of the snapshots already cut, such as an export budget. */
  cuts: readonly Cut[];
  /** The code graph of a repository of the workspace; absent when it has none. */
  graph(repo: string): CodeGraphReader | undefined;
  flow: ConsumerFlowReader;
  templates: ConsumerTemplateReader;
}

export interface ConsumerSources {
  /** Opens the session, runs `use` and releases what the session held, whether `use` answers or throws. */
  withSession<T>(request: ConsumerSessionRequest, use: (session: ConsumerSession) => Promise<T>): Promise<Result<T, WorkspaceFault>>;
}
