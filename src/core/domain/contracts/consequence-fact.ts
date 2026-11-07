import { incompleteSectionCuts, type Cut, type Fact, type FactBase, type SnapshotRef, type UnknownReason } from "../shared/fact.ts";
import type { RepositoryEvidence } from "../shared/repository-evidence.ts";
import type { Handler } from "../entrypoints/http-route.ts";
import type { LinkBasis } from "../topology/link.ts";
import type { ChangeEntry } from "./change.ts";
import type { OperationDelta, ResponseDelta, RuleLevel, RuleTarget } from "./contract-change-rules.ts";
import type { Hop } from "./consumer-flow.ts";
import type { ValueSet } from "./payload-shape.ts";
import type { RequestEntry } from "./request-change.ts";
import type { ProducerVerdict } from "./request-origin.ts";
import type { UseOperation, Verdict } from "./verdict.ts";

/** A step of a chain, placed in the repository it happens in. */
export interface LocatedHop extends Omit<Hop, "evidence"> {
  evidence: RepositoryEvidence;
}

/** What an extractor found, placed in the repository it was found in; `unknown` carries the reason and the places of where. */
export type ConsequenceFinding<T> =
  | { status: "complete"; value: T; evidence: readonly RepositoryEvidence[] }
  | { status: "unknown"; reason: UnknownReason; evidence: readonly RepositoryEvidence[] };

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
  chain: readonly LocatedHop[];
}

/** One producer of a request body: an HTTP call site that sends the operation's request, and what it can write at the changed property. */
export interface ProducerConsequence {
  repo: string;
  link: UseConsequence["link"];
  verdict: ProducerVerdict;
  /** The property the verdict is about, as the hypothesis wrote it. */
  path: string;
  /** From the HTTP call to the witness an `incompatible` verdict names; the call alone otherwise. */
  chain: readonly LocatedHop[];
}

export const OLD_GUARANTEE = "present-and-non-null";

/** What the old contract is assumed to have done under a request hypothesis: accepted every value the hypothesis rejects. */
export const OLD_ACCEPTANCE = "accepts-the-rejected";

/** What an answer says about one hypothesis, whatever its status. */
export interface AnswerBody {
  /** The hypothesis as normalized; `renamedTo` is the property's path under the new contract when it is renamed, `elementsAt` the path of the elements of a wrapped array. */
  hypothesis: { method: string; path: string; target: string; property: string; change: ChangeEntry | RequestEntry | readonly ChangeEntry[] | readonly RequestEntry[]; renamedTo?: string; elementsAt?: string };
  /** What the old contract guaranteed: the assumption when the hypothesis was written, the base value set when it was derived from a diff. */
  oldContract: typeof OLD_GUARANTEE | typeof OLD_ACCEPTANCE | ValueSet;
  /** Set on an answer `ofChange` derived: the operation and property it came from, the rules of the differences it answers, and where that operation sits in the contract at each revision. */
  derivedFrom?: { operation: string; property: string; rules: readonly string[]; places: { base: RepositoryEvidence; head: RepositoryEvidence } };
  /** Under a `values` change, how many uses only show the value or compare it with another literal and so give no finding. */
  silent?: number;
  /** A complete finding is a use (response) or a producer (request) with its verdict; an `unknown` one is a place the flow could not be followed. */
  findings: readonly ConsequenceFinding<UseConsequence | ProducerConsequence>[];
}

/** `partial` names what cut the answer; `unknown` is a hypothesis nothing could be followed for, with the reason. */
export type HypothesisAnswer = AnswerBody & ({ status: "complete" } | { status: "partial"; cuts: readonly [Cut, ...Cut[]] } | { status: "unknown"; reason: UnknownReason; detail: string });

/** One difference a change made to a contract, classified by the rule of its delta; a derived answer follows the ones its hypothesis answers. */
export interface ClassifiedDifference {
  rule: string;
  level: RuleLevel;
  target: RuleTarget;
  operation: string;
  /** The property of the payload the difference is at; absent for the operation itself. */
  property?: string;
  delta: ResponseDelta | OperationDelta;
  /** The class or keyword the delta names. */
  subject?: string;
  /** The keyword's value at each revision, absent where the revision does not carry it. */
  base?: unknown;
  head?: unknown;
  /** Where the operation sits in the contract at each revision that declares it. */
  places: { base?: RepositoryEvidence; head?: RepositoryEvidence };
}

/** A place the change could not be derived at, so nothing at or below it is decided. */
export interface ChangeFrontier {
  status: "unknown";
  reason: UnknownReason;
  kind: "unsupported-delta" | "recursive-shape" | "unknown-shape" | "unclassified-difference" | "request-unread" | "ambiguous-operation" | "unserved-operation" | "unreadable-contract";
  /** The side of the exchange a derivation frontier is on, when it is not the response. */
  target?: "request" | "parameter";
  operation?: string;
  property?: string;
  side?: "base" | "head";
  detail?: string;
  evidence: readonly RepositoryEvidence[];
}

export interface DerivationValue {
  /** In the order of the operations, each operation's own difference first, then its properties'. */
  differences: readonly ClassifiedDifference[];
  frontiers: readonly ChangeFrontier[];
}

export interface ChangeSection {
  base: string;
  head: string;
  /** The commits `base` and `head` named when the change was read; the consequences are answered on the head one. */
  snapshots: { base: string; head: string };
  /** Partial keeps what reading the sources of either revision left out: nothing at or below a cut is decided. */
  derivation: Fact<DerivationValue>;
}

export interface ConsequencesValue {
  /** Each repository the answer read, with its snapshot, sorted by repository. */
  repositorySnapshots: readonly { repo: string; snapshot: SnapshotRef }[];
  /** One per hypothesis: in the order asked, or sorted by operation and property when derived from a change. */
  answers: readonly HypothesisAnswer[];
  /** Present when the answer is about a change, even when no hypothesis was derived. */
  change?: ChangeSection;
}

const answerSection = (base: FactBase, answer: HypothesisAnswer): Fact<unknown> =>
  answer.status === "unknown" ? { ...base, status: "unknown", reason: answer.reason } : answer.status === "partial" ? { ...base, status: "partial", value: answer, cuts: answer.cuts } : { ...base, status: "complete", value: answer };

/** The composite of RFC-0002 rule 2: its answers and its derivation are its sections, and it is complete only when each is. */
export function consequencesFact(base: FactBase, value: ConsequencesValue): Fact<ConsequencesValue> {
  const sections: Record<string, Fact<unknown>> = Object.fromEntries(value.answers.map((answer, index) => [`answers.${index}`, answerSection(base, answer)]));
  if (value.change !== undefined) sections["change.derivation"] = value.change.derivation;
  const [first, ...rest] = incompleteSectionCuts(sections);
  return first === undefined ? { ...base, status: "complete", value } : { ...base, status: "partial", value, cuts: [first, ...rest] };
}
