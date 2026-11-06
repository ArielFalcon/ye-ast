import type { Finding } from "../shared/fact.ts";
import type { ChangeKind } from "./hypothesis.ts";
import type { Hop } from "./consumer-flow.ts";
import type { UseOperation, Verdict } from "./verdict.ts";

/** The use a verdict is about, and the chain that proves the value reaches it, nearest the HTTP call first. */
export interface UseConsequence {
  verdict: Verdict;
  operation: UseOperation;
  /** What the code reads, as an access path in the coordinates of the value at the use. */
  path: string;
  changed: string;
  chain: readonly Hop[];
}

export const OLD_GUARANTEE = "present-and-non-null";

export interface ConsequencesValue {
  hypothesis: { method: string; path: string; target: string; property: string; change: ChangeKind };
  assumedOldGuarantee: typeof OLD_GUARANTEE;
  /** A complete finding is a use with its verdict; an `unknown` one is a place the flow could not be followed. */
  findings: readonly Finding<UseConsequence>[];
}
