import { evaluate, representatives, subjectOf, testSubject, type Capability, type Representative, type Subject } from "../languages/javascript.ts";
import type { Evidence } from "../shared/fact.ts";
import { relatePaths, type AccessPath } from "./access-path.ts";
import type { Change } from "./change.ts";
import type { AccessStep, JsonValue, Literal, Predicate, Replacement, UseEnd, UseOperation } from "./use-operation.ts";

export type { Absence, UseOperation } from "./use-operation.ts";
export type { Capability } from "../languages/javascript.ts";

interface PlacedGuard {
  /** The path whose value the guard establishes: up to and including the changed segment, or deeper. */
  covers: AccessPath;
  evidence: Evidence;
}

/** A condition, an early exit or a `?.`: the use runs where `test`, applied to the value at `covers`, gives `holds`. */
export interface TestedGuard extends PlacedGuard {
  kind: "condition" | "early-exit" | "optional-chain";
  test: Predicate;
  holds: boolean;
}

/** `??`, `||` or a destructuring default: a value on which `test` does not give `holds` goes on as the replacement. */
export interface FallbackGuard extends PlacedGuard {
  kind: "fallback";
  test: Predicate;
  holds: boolean;
  replacement: Replacement;
}

/** A construct whose test the language module does not evaluate. */
export interface UntestedGuard extends PlacedGuard {
  kind: "non-null-assertion" | "type-guard" | "assertion" | "instanceof";
}

/** The guards of one use, in the order the value passes them. */
export type Guard = TestedGuard | FallbackGuard | UntestedGuard;

export type GuardKind = Guard["kind"];

/** One place the code operates on a carried value, with the paths in the coordinates of that value. */
export interface UseSite {
  /** What the code reads from the carried value. */
  path: AccessPath;
  /** Where the changed property sits in that same value. */
  changed: AccessPath;
  operation: UseOperation;
  guards: readonly Guard[];
}

export type ReviewReason = "consumed" | "unmodelled-sink" | "removed-behind-guard" | "opaque-guard" | "unknown-value" | "opaque-replacement";

export type Verdict =
  | { kind: "incompatible"; witness: string; at: number; failing: AccessStep | UseEnd; capability: Capability; replacement?: JsonValue }
  | { kind: "admits"; guards: readonly Guard[] }
  | { kind: "review"; reason: ReviewReason };

/** What one introduced value does at the use. */
type Outcome =
  | { kind: "handled"; guard: Guard }
  | { kind: "throws"; witness: string; at: number; failing: AccessStep | UseEnd; capability: Capability; replacement?: JsonValue }
  | { kind: "runs" }
  | { kind: "unknown"; reason: "opaque-guard" | "unmodelled-sink" | "unknown-value" | "opaque-replacement" };

const RUNS: Outcome = { kind: "runs" };
const NONE: readonly Literal[] = [];

/** A test of a deeper path dereferences the changed value itself and is reported as its own use; a `?.` there guards nothing before it. */
function establishes({ kind, covers }: Guard, changed: AccessPath): boolean {
  const relation = relatePaths(covers, changed);
  return relation === "exact" || (relation === "beyond" && kind !== "optional-chain");
}

/**
 * Each value the change introduces is decided on its own, guards first, then the steps of the use; one that throws makes
 * the use `incompatible`, one that runs or cannot be decided makes it `review`, and only a use every value is kept from
 * admits the change. A read that never reaches into the changed value has no verdict.
 */
export function decideUse(use: UseSite, change: Change): Verdict | undefined {
  const relation = relatePaths(use.path, use.changed);
  if (relation === "contains" || relation === "disjoint") return undefined;
  const reaching = use.guards.filter((guard) => guard.kind !== "non-null-assertion" && establishes(guard, use.changed));
  const needsNames = change.introduced.some((valueClass) => valueClass === "number" || valueClass === "string");
  const outcomes = change.introduced.length === 0 ? [] : representatives(change.introduced, needsNames ? literalsNamed(use) : NONE).map((value) => outcomeOf(value, use, reaching));
  const thrown = outcomes.find((outcome) => outcome.kind === "throws");
  if (thrown !== undefined) return { ...thrown, kind: "incompatible" };
  if (outcomes.some((outcome) => outcome.kind === "runs")) return { kind: "review", reason: "consumed" };
  const unknown = outcomes.find((outcome) => outcome.kind === "unknown");
  if (unknown !== undefined) return { kind: "review", reason: unknown.reason };
  if (change.alwaysAbsent) return { kind: "review", reason: "removed-behind-guard" };
  return { kind: "admits", guards: [...new Set(outcomes.flatMap((outcome) => (outcome.kind === "handled" ? [outcome.guard] : [])))] };
}

/** The literals the use compares against: a fresh value must differ from each. */
function literalsNamed({ guards, operation: { end } }: UseSite): Literal[] {
  const named = guards.flatMap((guard) => ("test" in guard && guard.test.kind === "literal" ? [guard.test.literal] : []));
  return end.kind === "compare" && end.literal !== undefined ? [...named, end.literal] : named;
}

/**
 * The value passes the guards in order: a tested guard whose test does not give `holds` handles it, a fallback whose test
 * does not replaces it, and a guard the module cannot evaluate leaves a throwing use undecided. Then the use runs on
 * what is left.
 */
function outcomeOf({ literal, subject }: Representative, { operation, changed }: UseSite, reaching: readonly Guard[]): Outcome {
  let current: Subject = subject;
  let replaced: FallbackGuard | undefined;
  let undecided = false;
  for (const guard of reaching) {
    if (!("test" in guard)) {
      undecided = true;
      continue;
    }
    const tested = testSubject(guard.test, guard.holds, current, guard.covers.slice(changed.length));
    if (tested === "passes") continue;
    if (tested === "undecided") undecided = true;
    else if (guard.kind !== "fallback" || tested === "reads-throw") return { kind: "handled", guard };
    else if (guard.covers.length > changed.length) undecided = true;
    else {
      current = subjectOf(guard.replacement);
      replaced = guard;
    }
  }
  const walked = evaluate(operation, current);
  switch (walked.kind) {
    case "throws": {
      if (undecided) return { kind: "unknown", reason: "opaque-guard" };
      const replacement = replaced?.replacement;
      const failing = operation.steps[walked.at] ?? operation.end;
      return { kind: "throws", witness: literal, at: walked.at, failing, capability: walked.capability, ...(replacement?.kind === "literal" ? { replacement: replacement.value } : {}) };
    }
    case "runs":
      return replaced === undefined ? RUNS : { kind: "handled", guard: replaced };
    case "unknown":
      if (walked.cause === "sink") return { kind: "unknown", reason: "unmodelled-sink" };
      return { kind: "unknown", reason: replaced?.replacement.kind === "opaque" ? "opaque-replacement" : "unknown-value" };
  }
}
