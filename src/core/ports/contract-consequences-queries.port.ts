import type { ConsequencesValue } from "../domain/contracts/consequence-fact.ts";
import type { HypothesisInput, HypothesisRefusal } from "../domain/contracts/hypothesis.ts";
import type { Fact } from "../domain/shared/fact.ts";
import type { Result } from "../domain/shared/result.ts";
import type { WorkspaceRequest } from "./workspace-queries.port.ts";
import type { WorkspaceFault } from "./workspace-repos.port.ts";

/** One or more written hypotheses, answered together on one workspace. */
export interface HypothesesRequest extends WorkspaceRequest {
  hypotheses: readonly HypothesisInput[];
}

/** A change between two revisions of the bound repository, at its `head`, never live. */
export interface ChangeRequest extends WorkspaceRequest {
  base: string;
  head: string;
}

export type ConsequencesFault =
  | WorkspaceFault
  /** The hypothesis at `index` of the request is refused, so nothing is answered. */
  | { kind: "invalid-hypothesis"; detail: string; index: number; refusal: HypothesisRefusal }
  | { kind: "contradictory-revisions"; detail: string };

export interface ContractConsequencesQueries {
  /**
   * Follows the response of each operation from each call site that a qualified link joins to it, to the code that uses
   * the changed property, and gives each use a verdict with the chain that proves it; a request hypothesis follows the
   * producers of the body instead. Answers come in the order asked. A hypothesis no repository serves is an `unknown`
   * answer, and a place where a flow cannot be followed is an `unknown` finding with its location and cause: an
   * answer without findings is never "safe" on its own.
   */
  ofHypotheses(request: HypothesesRequest): Promise<Result<Fact<ConsequencesValue>, ConsequencesFault>>;
  /**
   * What a change between two revisions did to the response of each operation, from the contract both revisions state,
   * and what depends on it at the head. An operation or place whose shape cannot be stated is a frontier of the
   * derivation, never silence.
   */
  ofChange(request: ChangeRequest): Promise<Result<Fact<ConsequencesValue>, ConsequencesFault>>;
}
