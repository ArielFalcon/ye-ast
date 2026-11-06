import type { ConsequencesValue } from "../domain/contracts/consequence-fact.ts";
import type { HypothesisInput, HypothesisRefusal } from "../domain/contracts/hypothesis.ts";
import type { Fact } from "../domain/shared/fact.ts";
import type { Result } from "../domain/shared/result.ts";
import type { WorkspaceRequest } from "./workspace-queries.port.ts";
import type { WorkspaceFault } from "./workspace-repos.port.ts";

export interface ConsequencesRequest extends WorkspaceRequest {
  hypothesis: HypothesisInput;
}

export type ConsequencesFault =
  | WorkspaceFault
  | { kind: "invalid-hypothesis"; detail: string; refusal: HypothesisRefusal }
  /** No repository of the workspace serves the operation, so there is no contract to change. */
  | { kind: "unknown-operation"; detail: string; operation: string };

export interface ConsumerQueries {
  /**
   * Follows the response of one operation from each call site that a qualified link joins to it, to the code that uses the
   * changed property, and gives each use a verdict with the chain that proves it. A place where the flow cannot be
   * followed is an `unknown` item with its location and cause; an answer without items is never "safe" on its own.
   */
  consequences(request: ConsequencesRequest): Promise<Result<Fact<ConsequencesValue>, ConsequencesFault>>;
}
