import type { Evidence } from "../shared/fact.ts";
import { relatePaths, type AccessPath } from "./access-path.ts";
import type { Change } from "./change.ts";
import type { Absence, AccessStep, UseEnd, UseOperation } from "./use-operation.ts";

export type { Absence, UseOperation } from "./use-operation.ts";

export type GuardKind = "optional-chain" | "truthiness" | "comparison" | "early-exit" | "fallback" | "non-null-assertion" | "type-guard" | "assertion" | "instanceof";

/** `protects` guards are decided by their path and exclusions, `opaque` ones leave a use that would fail undecided, `none` never guard. */
const GUARD_EFFECT: Readonly<Record<GuardKind, "protects" | "opaque" | "none">> = {
  "optional-chain": "protects",
  truthiness: "protects",
  comparison: "protects",
  "early-exit": "protects",
  fallback: "protects",
  "non-null-assertion": "none",
  "type-guard": "opaque",
  assertion: "opaque",
  instanceof: "opaque",
};

export interface Guard {
  kind: GuardKind;
  /** The path whose value the guard establishes: up to and including the changed segment, or deeper. */
  covers: AccessPath;
  /** The absences the guard rules out where it holds. */
  excludes: readonly Absence[];
  evidence: Evidence;
}

/** One place the code operates on a carried value, with the paths in the coordinates of that value. */
export interface UseSite {
  /** What the code reads from the carried value. */
  path: AccessPath;
  /** Where the changed property sits in that same value. */
  changed: AccessPath;
  operation: UseOperation;
  guards: readonly Guard[];
}

export type ReviewReason = "consumed" | "unmodelled-sink" | "removed-behind-guard" | "opaque-guard";

/** What the failing step or end needs the value to be: one to read a member from (as object destructuring does), a function, an iterable. */
export type Capability = "readable" | "function" | "iterable";

export type Verdict =
  | { kind: "incompatible"; witness: Absence; failing: AccessStep | UseEnd; capability: Capability }
  | { kind: "admits"; guards: readonly Guard[] }
  | { kind: "review"; reason: ReviewReason };

/** What one introduced value does at the use. */
type Outcome =
  | { kind: "handled"; guard: Guard }
  | { kind: "throws"; witness: Absence; failing: AccessStep | UseEnd; capability: Capability }
  | { kind: "runs" }
  | { kind: "unknown"; reason: "opaque-guard" | "unmodelled-sink" };

const RUNS: Outcome = { kind: "runs" };

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
  const reaching = use.guards.filter((guard) => GUARD_EFFECT[guard.kind] !== "none" && establishes(guard, use.changed));
  const outcomes = change.introduced.map((value) => outcomeOf(value, use.operation, reaching));
  const thrown = outcomes.find((outcome) => outcome.kind === "throws");
  if (thrown !== undefined) return { ...thrown, kind: "incompatible" };
  if (outcomes.some((outcome) => outcome.kind === "runs")) return { kind: "review", reason: "consumed" };
  const unknown = outcomes.find((outcome) => outcome.kind === "unknown");
  if (unknown !== undefined) return { kind: "review", reason: unknown.reason };
  if (change.alwaysAbsent) return { kind: "review", reason: "removed-behind-guard" };
  return { kind: "admits", guards: [...new Set(outcomes.flatMap((outcome) => (outcome.kind === "handled" ? [outcome.guard] : [])))] };
}

/** A guard the use's branch rejects the value on keeps it away; one outside the vocabulary leaves a failing use undecided. */
function outcomeOf(value: Absence, operation: UseOperation, reaching: readonly Guard[]): Outcome {
  const guard = reaching.find((candidate) => GUARD_EFFECT[candidate.kind] === "protects" && candidate.excludes.includes(value));
  if (guard !== undefined) return { kind: "handled", guard };
  const walked = walk(operation, value);
  return walked.kind === "throws" && reaching.some((candidate) => GUARD_EFFECT[candidate.kind] === "opaque") ? { kind: "unknown", reason: "opaque-guard" } : walked;
}

/** `null` and `undefined` fail the first step applied to them; without steps, the end decides. */
function walk({ steps, end }: UseOperation, witness: Absence): Outcome {
  const [first] = steps;
  if (first !== undefined) return { kind: "throws", witness, failing: first, capability: first.kind === "call" ? "function" : "readable" };
  switch (end.kind) {
    case "iterate":
      return end.tolerates.includes(witness) ? RUNS : { kind: "throws", witness, failing: end, capability: "iterable" };
    case "destructure":
      return { kind: "throws", witness, failing: end, capability: end.shape === "object" ? "readable" : "iterable" };
    case "none":
      return { kind: "throws", witness, failing: end, capability: "readable" };
    case "compare":
    case "coerce":
    case "consume":
      return RUNS;
    case "unmodelled":
      return { kind: "unknown", reason: "unmodelled-sink" };
  }
}
