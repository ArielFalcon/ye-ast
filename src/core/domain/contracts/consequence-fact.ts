import type { Finding } from "../shared/fact.ts";
import type { RepositoryEvidence } from "../shared/repository-evidence.ts";
import type { Handler } from "../entrypoints/http-route.ts";
import type { LinkBasis } from "../topology/link.ts";
import type { ChangeEntry } from "./change.ts";
import type { Hop } from "./consumer-flow.ts";
import type { ValueSet } from "./payload-shape.ts";
import type { RequestEntry } from "./request-change.ts";
import type { ProducerVerdict } from "./request-origin.ts";
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

/** One producer of a request body: an HTTP call site that sends the operation's request, and what it can write at the changed property. */
export interface ProducerConsequence {
  repo: string;
  link: UseConsequence["link"];
  verdict: ProducerVerdict;
  /** The property the verdict is about, as the hypothesis wrote it. */
  path: string;
  /** From the HTTP call to the witness an `incompatible` verdict names; the call alone otherwise. */
  chain: readonly Hop[];
}

export const OLD_GUARANTEE = "present-and-non-null";

/** What the old contract is assumed to have done under a request hypothesis: accepted every value the hypothesis rejects. */
export const OLD_ACCEPTANCE = "accepts-the-rejected";

export interface ConsequencesValue {
  /** The hypothesis as normalized; `renamedTo` is the property's path under the new contract when it is renamed, `elementsAt` the path of the elements of a wrapped array. */
  hypothesis: { method: string; path: string; target: string; property: string; change: ChangeEntry | RequestEntry | readonly ChangeEntry[] | readonly RequestEntry[]; renamedTo?: string; elementsAt?: string };
  /** What the old contract guaranteed: the assumption when the hypothesis was written, the base value set when it was derived from a diff. */
  assumedOldGuarantee: typeof OLD_GUARANTEE | typeof OLD_ACCEPTANCE | ValueSet;
  /** Under a `values` change, how many uses only show the value or compare it with another literal and so give no finding. */
  silent?: number;
  /** A complete finding is a use (response) or a producer (request) with its verdict; an `unknown` one is a place the flow could not be followed. */
  findings: readonly Finding<UseConsequence | ProducerConsequence>[];
}
