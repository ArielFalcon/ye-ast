import { canonicalJson } from "../shared/canonical-json.ts";
import { compareText } from "../shared/code-node.ts";
import type { Evidence } from "../shared/fact.ts";
import type { AccessPath } from "./access-path.ts";
import { holdsClass } from "./change.ts";
import type { Hop } from "./consumer-flow.ts";
import type { LiteralClass, ValueSet } from "./payload-shape.ts";
import type { Literal } from "./use-operation.ts";

/** What a place of a request body holds on the wire. */
export type OriginValue = { kind: "literal"; value: Literal | null } | { kind: "absent" } | { kind: "array" } | { kind: "object" };

/** Why an origin could not be followed any further. */
export const ORIGIN_FRONTIER_REASONS = ["form-value", "call-result", "member", "construction", "mutated", "unresolved-callers", "untracked"] as const;

export type OriginFrontierReason = (typeof ORIGIN_FRONTIER_REASONS)[number];

/** A condition the origin holds under: the source text of the test and the side of it the branch is on. */
export interface BranchCondition {
  expression: string;
  holds: boolean;
  at: Evidence;
}

/** Where an origin is written, the steps from the call site to it (nearest the call site first) and the branches it holds under (outermost first). */
export interface OriginTrail {
  at: Evidence;
  hops: readonly Hop[];
  conditions: readonly BranchCondition[];
}

/** The parameter of a function that a value reaches the body through; the callers of the function decide what it holds. */
export interface ParameterContinuation {
  file: string;
  symbol: string;
  line: number;
  index: number;
  /** The followed path in the coordinates of the parameter's value. */
  path: AccessPath;
  /** The parameter holds the whole request body, so a serialization at the caller is the body's own. */
  body: boolean;
  /** What the parameter holds when the caller passes no argument or `undefined`: its default's origins, or absence. */
  omitted: readonly Origin[];
}

/**
 * Where a followed value comes from. `exact` is a value the source writes, `approximate` a class whose values are not all
 * known, `frontier` a place the walk could not follow, and `parameter` a boundary the use case resolves at the callers.
 */
export type Origin =
  | (OriginTrail & { kind: "exact"; value: OriginValue })
  | (OriginTrail & { kind: "approximate"; class: LiteralClass })
  | (OriginTrail & { kind: "frontier"; reason: OriginFrontierReason; detail?: string })
  | (OriginTrail & { kind: "parameter"; parameter: ParameterContinuation });

/** An origin with no boundary left to resolve. */
export type SettledOrigin = Exclude<Origin, { kind: "parameter" }>;

export type ProducerVerdict =
  | { kind: "incompatible"; witness: { value: string; at: Evidence; hops: readonly Hop[]; conditions: readonly BranchCondition[] } }
  | { kind: "admits" }
  | { kind: "review"; reason: "frontier" | "approximate" | "no-origin" };

/**
 * The verdict of one producer: a proven origin writing a rejected value is `incompatible` whatever else is unknown; it
 * `admits` only when every origin is known and none can be rejected; an empty set of origins never admits.
 */
export function decideProducer(origins: readonly SettledOrigin[], rejected: ValueSet): ProducerVerdict {
  const writes = origins.filter((origin): origin is Extract<SettledOrigin, { kind: "exact" }> => origin.kind === "exact" && isRejected(origin.value, rejected));
  const [witness] = writes.sort((a, b) => compareText(a.at.path, b.at.path) || a.at.line - b.at.line);
  if (witness !== undefined) return { kind: "incompatible", witness: { value: formatOriginValue(witness.value), at: witness.at, hops: witness.hops, conditions: witness.conditions } };
  if (origins.length === 0) return { kind: "review", reason: "no-origin" };
  if (origins.some((origin) => origin.kind === "frontier")) return { kind: "review", reason: "frontier" };
  if (origins.some((origin) => origin.kind === "approximate" && holdsClass(rejected, origin.class))) return { kind: "review", reason: "approximate" };
  return { kind: "admits" };
}

function isRejected(value: OriginValue, rejected: ValueSet): boolean {
  if (value.kind === "absent") return rejected.absent;
  if (value.kind === "array") return rejected.array;
  if (value.kind === "object") return rejected.object;
  if (value.value === null) return rejected.null;
  const values = rejected.literals[typeof value.value as LiteralClass];
  return values === "every" || values.includes(value.value);
}

export const formatOriginValue = (value: OriginValue): string => (value.kind === "literal" ? canonicalJson(value.value) : value.kind);
