import type { Finding } from "../shared/fact.ts";
import type { RepositoryEvidence } from "../shared/repository-evidence.ts";
import type { Handler } from "../entrypoints/http-route.ts";
import type { LinkBasis } from "../topology/link.ts";
import type { ChangeKind } from "./hypothesis.ts";
import type { Hop } from "./consumer-flow.ts";
import type { UseOperation, Verdict } from "./verdict.ts";

/** The use a verdict is about, and the chain that proves the value reaches it, nearest the HTTP call first. */
export interface UseConsequence {
  /** The repository the use is in. */
  repo: string;
  /** The qualified link the value came through: the call site that makes the HTTP call, and the handler it reaches. */
  link: { id: string; basis: LinkBasis; call: { file: string; line: number; symbol: string }; handler: Handler & { repo: string } };
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
