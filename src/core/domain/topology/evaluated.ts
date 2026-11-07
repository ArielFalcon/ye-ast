import { compareText } from "../shared/code-node.ts";
import { distinctEvidence, type Evidence, type Finding, type UnknownReason } from "../shared/fact.ts";
import type { CallSiteDiagnostic } from "./call-site.ts";

type CallSiteCause = CallSiteDiagnostic["cause"];

/** Why the snapshot does not decide a value a call site is written with. */
export type UndecidedCause = Extract<CallSiteCause, "recursive" | "dispatch-disagreement" | "destination-undecidable">;

/**
 * A value the snapshot does not decide: why, where the evaluation stopped, and the values a run-time choice takes on the
 * branches the snapshot does decide.
 */
export interface Undecided {
  status: "undecided";
  cause: UndecidedCause;
  evidence: readonly Evidence[];
  alternatives?: readonly string[];
}

/** What the evaluator of a call site's code reads a value as: decided, or undecided with its cause. */
export type Evaluated<T> = { status: "known"; value: T } | Undecided;

export function known<T>(value: T): Evaluated<T> {
  return { status: "known", value };
}

export function undecided(cause: UndecidedCause, evidence: readonly Evidence[] = [], alternatives: readonly string[] = []): Undecided {
  const distinct = [...new Set(alternatives)].sort(compareText);
  return { status: "undecided", cause, evidence, ...(distinct.length === 0 ? {} : { alternatives: distinct }) };
}

/**
 * The cause several readings of one value come to: recursion first, since what it hides cannot be read, then readings
 * that disagree, then the first cause a reading states.
 */
export function prevailingCause<C extends CallSiteCause>(causes: readonly (C | undefined)[], agreement = true): C | "recursive" | "dispatch-disagreement" | undefined {
  if (causes.includes("recursive" as C)) return "recursive";
  if (!agreement || causes.includes("dispatch-disagreement" as C)) return "dispatch-disagreement";
  return causes.find((cause) => cause !== undefined);
}

/**
 * Why a call that reaches its requests or publishes through other methods stays unresolved: the prevailing cause of the
 * readings, `destination-undecidable` when none states one, and every alternative they record.
 */
export function reachedDiagnostic(diagnostics: readonly (CallSiteDiagnostic | undefined)[], agreement: boolean, throughLibrary: boolean): CallSiteDiagnostic {
  const cause = prevailingCause(diagnostics.map((diagnostic) => diagnostic?.cause), agreement) ?? "destination-undecidable";
  const alternatives = [...new Set(diagnostics.flatMap((diagnostic) => diagnostic?.alternatives ?? []))].sort(compareText);
  return { cause, ...(throughLibrary ? { source: "read" } : {}), ...(alternatives.length === 0 ? {} : { alternatives }) };
}

/** An undecided value as a call site's target: unknown at the call, then where the evaluation stopped, with its cause. */
export function undecidedTarget(why: Undecided, at: Evidence, reason: UnknownReason = "unresolved"): { target: Finding<never>; diagnostic: CallSiteDiagnostic } {
  return {
    target: { status: "unknown", reason, evidence: distinctEvidence([at, ...why.evidence]) },
    diagnostic: { cause: why.cause, ...(why.alternatives === undefined ? {} : { alternatives: why.alternatives }) },
  };
}
