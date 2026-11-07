import type { ChangeEntry } from "../domain/contracts/change.ts";
import type { ConsequencesValue } from "../domain/contracts/consequence-fact.ts";
import type { DerivationFrontier, RetiredValue } from "../domain/contracts/shape-derivation.ts";
import type { Cut, Evidence, Fact, UnknownReason } from "../domain/shared/fact.ts";
import type { Result } from "../domain/shared/result.ts";
import type { ConsequencesFault } from "./contract-consequences-queries.port.ts";
import type { WorkspaceRequest } from "./workspace-queries.port.ts";
import type { WorkspaceFault } from "./workspace-repos.port.ts";

export type ContractChangeFault = WorkspaceFault | { kind: "contradictory-revisions"; detail: string };

export interface ContractChangeRequest {
  /** The workspace the consequences are answered on, bound to the head of the change: its bound repository names no other revision than `head`, and is not read live. */
  workspace: WorkspaceRequest;
  base: string;
  head: string;
}

/** One property of one operation's response that the change altered, with what following it found. */
export interface DerivedConsequences {
  operation: string;
  property: string;
  change: ChangeEntry | readonly ChangeEntry[];
  /** Where the operation sits in the contract at each revision. */
  places: { base: Evidence; head: Evidence };
  consequences: Result<Fact<ConsequencesValue>, ConsequencesFault>;
}

/** A guarantee the head gives that the base did not: listed with its place and not followed. */
export interface GainedGuaranteeItem {
  operation: string;
  property: string;
  retired: RetiredValue;
  places: { base: Evidence; head: Evidence };
}

/** A place the change could not be derived at, so nothing at or below it is decided. */
export interface ChangeFrontier {
  kind: DerivationFrontier["kind"] | "ambiguous-operation" | "unserved-operation" | "unreadable-contract";
  operation?: string;
  property?: string;
  side?: "base" | "head";
  reason?: UnknownReason;
  detail?: string;
  evidence: readonly Evidence[];
}

export interface ContractChangeValue {
  base: string;
  head: string;
  /** The commits `base` and `head` named when the change was read; the consequences are answered on the head one. */
  snapshots: { base: string; head: string };
  derived: readonly DerivedConsequences[];
  gained: readonly GainedGuaranteeItem[];
  frontiers: readonly ChangeFrontier[];
  /** Operations only one revision declares, by name: they derive no hypothesis. */
  operations: { added: readonly string[]; removed: readonly string[] };
  /** What reading the sources of either revision left out: nothing at or below a cut is decided. */
  cuts: readonly Cut[];
}

export interface ContractChangeQueries {
  /**
   * What a change between two revisions did to the response of each operation, from the contract both revisions state,
   * and what depends on it at the head. An operation or place whose shape cannot be stated is a frontier, never silence.
   */
  consequencesOfChange(request: ContractChangeRequest): Promise<Result<ContractChangeValue, ContractChangeFault>>;
}
