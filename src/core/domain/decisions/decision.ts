import type { Evidence } from "../shared/fact.ts";
import type { OutwardKind } from "../topology/outward-name.ts";

/** The closed list of gaps the code cannot fill (RFC-0014): one kind per question a fact does not answer. */
export type DecisionKind = "membership" | "repository" | "library" | "gateway" | "revision" | "remote" | "trust";

/** The fact that makes an option valid; a kind's rule ranks only the bases it reads. */
export type DecisionBasis = "exact-name" | "artifact" | "remote" | "route-overlap" | "default-branch" | "origin";

/** One value the workspace can verify for a decision, with the places that make it valid. */
export interface DecisionOption {
  /** A repository id, a prefix, a path, a URL, a branch or a trust mode, as the kind's rule states it. */
  value: string;
  basis?: DecisionBasis;
  evidence: readonly Evidence[];
  recommended: boolean;
}

/** One gap: its subject, every option the workspace can verify, and whether the kind's rule recommends one. */
export interface Decision {
  /** `${kind}:${subject}`, stable for the same gap. */
  id: string;
  kind: DecisionKind;
  subject: string;
  /** The places that motivated the gap; empty when no place states it. */
  evidence: readonly Evidence[];
  /** The outward kinds a `repository` subject is written with, sorted; absent when the subject is no outward name. */
  outwardKinds?: readonly OutwardKind[];
  options: readonly DecisionOption[];
  /** Whether an answer may be a value no fact states, marked as free text instead of offered as an option. */
  allowsFreeText: boolean;
  /** Whether an absent answer blocks the answer the gap weakens. */
  required: boolean;
}

/** Every gap of a workspace, sorted by id; a fact adds the snapshots and a driving adapter the prose. */
export interface DecisionSet {
  decisions: readonly Decision[];
}

export function decisionId(kind: DecisionKind, subject: string, scope?: string): string {
  return `${kind}:${scope === undefined ? "" : `${scope}:`}${subject}`;
}
