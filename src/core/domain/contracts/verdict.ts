import type { Evidence } from "../shared/fact.ts";
import { relatePaths, type AccessPath } from "./access-path.ts";
import type { ChangeKind } from "./hypothesis.ts";

export type Absence = "null" | "undefined";

export type Counterexample = "null" | "absent";

/**
 * What a change does to the old guarantee: the absence it introduces, the counterexample that shows it, and the verdict a
 * sufficient guard earns. A new change kind is a row here, never a branch in the rule.
 */
export interface ChangeRule {
  violates: Absence;
  counterexample: Counterexample;
  guarded: "admits" | "review";
}

export const CHANGE_RULES: Readonly<Record<ChangeKind, ChangeRule>> = {
  nullable: { violates: "null", counterexample: "null", guarded: "admits" },
  removed: { violates: "undefined", counterexample: "absent", guarded: "review" },
};

/**
 * What the code does with the value at a path: an operation that fails on null or undefined (member read, call, keyed
 * read, array spread, iteration, destructuring); hands it on or shows it; anything else.
 */
export type UseOperation = "dereference" | "consume" | "unmodelled";

export type GuardKind = "optional-chain" | "truthiness" | "comparison" | "early-exit" | "fallback" | "non-null-assertion" | "type-guard" | "assertion" | "instanceof";

/** `protects` guards are decided by their path and exclusions, `opaque` ones leave the read for review, `none` never guard. */
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

export type Verdict =
  | { kind: "incompatible"; requirement: "present-and-non-null"; counterexample: Counterexample }
  | { kind: "admits"; guard: Guard }
  | { kind: "review"; reason: ReviewReason };

const sameOrDeeper = (covers: AccessPath, changed: AccessPath) => relatePaths(covers, changed) === "exact" || relatePaths(covers, changed) === "beyond";

/**
 * Proof is asymmetric: `admits` needs a guard that establishes the changed value, `incompatible` an unguarded
 * dereference of it, and everything the rule cannot decide is `review`. A read that never reaches into the changed value
 * has no verdict.
 */
export function decideUse(use: UseSite, change: ChangeKind): Verdict | undefined {
  const relation = relatePaths(use.path, use.changed);
  if (relation === "contains" || relation === "disjoint") return undefined;
  if (relation === "exact" && use.operation !== "dereference") return { kind: "review", reason: use.operation === "consume" ? "consumed" : "unmodelled-sink" };
  const rule = CHANGE_RULES[change];
  const reaching = use.guards.filter((guard) => GUARD_EFFECT[guard.kind] !== "none" && sameOrDeeper(guard.covers, use.changed));
  const sufficient = reaching.find((guard) => GUARD_EFFECT[guard.kind] === "protects" && guard.excludes.includes(rule.violates));
  if (sufficient !== undefined) return rule.guarded === "admits" ? { kind: "admits", guard: sufficient } : { kind: "review", reason: "removed-behind-guard" };
  if (reaching.some((guard) => GUARD_EFFECT[guard.kind] === "opaque")) return { kind: "review", reason: "opaque-guard" };
  return { kind: "incompatible", requirement: "present-and-non-null", counterexample: rule.counterexample };
}
