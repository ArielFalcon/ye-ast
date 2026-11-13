/**
 * The cut ledger of the corpus gate (RFC-0031, ADR-0071): the cuts of one side's answers counted by family, language,
 * kind, reason and sub-reason, the difference of two ledgers, and the reasons a change declared with `--expect-cuts`.
 * Pure: no I/O, no clock.
 */
import { CUT_REASONS, CUT_SUB_REASONS } from "../src/core/domain/shared/fact.ts";
import { LANGUAGE_PROFILES } from "../src/core/domain/languages/profiles.ts";
import { type Answer, type Direction, ExpectationError, canonical, compareText, isObject, parseDirected, topFact } from "./corpus-gate-diff.ts";

const STATUSES = ["complete", "partial", "unknown"] as const;
type Status = (typeof STATUSES)[number];
export type StatusCounts = Record<Status, number>;

const NO_LANGUAGE = "none";

export interface LedgerKey {
  family: string;
  /** The language whose profile reads the file of the cut's first place; `none` when no profile reads it. */
  language: string;
  kind: string;
  reason: string;
  subReason?: string;
}

export interface LedgerValues {
  cuts: number;
  /** The answers holding at least one cut of the key, by the answer's status. */
  answersWith: StatusCounts;
  /** The expanded steps of the answers that hold the key's cuts; present only for a family whose facts count steps. */
  steps?: number;
  /** `cuts` per 100 of `steps`; `null` when those answers expanded no step. */
  per100Steps?: number | null;
}

export type LedgerRow = LedgerKey & LedgerValues;

export interface CutLedger {
  families: { family: string; answers: StatusCounts }[];
  rows: LedgerRow[];
}

export type LedgerDifferenceRow = LedgerKey & { base: LedgerValues | null; candidate: LedgerValues | null };

export interface LedgerDifference {
  rows: LedgerDifferenceRow[];
  totals: { base: number; candidate: number };
}

/** A reason whose cuts may move, in one direction: `+` must rise, `-` must fall, `±` must change. */
export interface CutExpectation {
  reason: string;
  direction: Direction;
}

export interface CutViolation {
  reason: string;
  direction: Direction;
  base: number;
  candidate: number;
  rule: "cuts-not-as-declared";
}

export class CutLedgerError extends Error {
  constructor(readonly code: "unknown-cut-reason" | "unknown-cut-sub-reason", readonly detail: string) {
    super(`${code}: ${detail}`);
  }
}

interface HeldCut {
  key: LedgerKey;
  answer: Answer;
  status: Status;
  steps: number | undefined;
}

/** The ledger of one side's answers. A cut whose reason or sub-reason is outside the closed sets of the facts contract throws. */
export function cutLedger(answers: readonly Answer[]): CutLedger {
  const families = new Map<string, StatusCounts>();
  const held: HeldCut[] = [];
  const familiesWithSteps = new Set<string>();
  for (const answer of answers) {
    const fact = topFact(answer.stdout);
    if (fact === null || !isStatus(fact.status)) continue;
    const counts = families.get(answer.family) ?? emptyCounts();
    families.set(answer.family, counts);
    counts[fact.status] += 1;
    const steps = expandedSteps(fact);
    if (steps !== undefined) familiesWithSteps.add(answer.family);
    for (const cut of factCuts(fact)) held.push({ key: keyOf(answer.family, cut), answer, status: fact.status, steps });
  }
  return {
    families: [...families.entries()].sort(([a], [b]) => compareText(a, b)).map(([family, answers]) => ({ family, answers })),
    rows: rowsOf(held, familiesWithSteps),
  };
}

/** The rows whose values differ between two ledgers, a row one side lacks as `null`, and the total cuts of each side. */
export function ledgerDifference(base: CutLedger, candidate: CutLedger): LedgerDifference {
  const baseRows = new Map(base.rows.map((row) => [keyText(row), row]));
  const candidateRows = new Map(candidate.rows.map((row) => [keyText(row), row]));
  const keys = [...new Set([...baseRows.keys(), ...candidateRows.keys()])].sort(compareText);
  const rows = keys.flatMap((key): LedgerDifferenceRow[] => {
    const before = baseRows.get(key);
    const after = candidateRows.get(key);
    const baseValues = before === undefined ? null : valuesOf(before);
    const candidateValues = after === undefined ? null : valuesOf(after);
    if (canonical(baseValues) === canonical(candidateValues)) return [];
    return [{ ...keyFields((before ?? after) as LedgerRow), base: baseValues, candidate: candidateValues }];
  });
  return { rows, totals: { base: totalCuts(base.rows), candidate: totalCuts(candidate.rows) } };
}

/** Parses the `--expect-cuts` values: `<reason>:<+|-|±>` once per reason, each reason one of the facts contract. */
export function parseCutExpectations(values: readonly string[]): CutExpectation[] {
  return parseDirected(values).map(([reason, direction]) => {
    if (!(CUT_REASONS as readonly string[]).includes(reason)) throw new ExpectationError("invalid-expectation", reason);
    return { reason, direction };
  });
}

/** The declared reasons whose total cuts did not move as declared; a reason nobody declared is never one. */
export function cutViolations(base: CutLedger, candidate: CutLedger, expectations: readonly CutExpectation[]): CutViolation[] {
  return expectations.flatMap(({ reason, direction }): CutViolation[] => {
    const before = totalCuts(base.rows.filter((row) => row.reason === reason));
    const after = totalCuts(candidate.rows.filter((row) => row.reason === reason));
    const moved = direction === "+" ? after > before : direction === "-" ? after < before : after !== before;
    return moved ? [] : [{ reason, direction, base: before, candidate: after, rule: "cuts-not-as-declared" }];
  });
}

function rowsOf(held: readonly HeldCut[], familiesWithSteps: ReadonlySet<string>): LedgerRow[] {
  const byKey = new Map<string, { key: LedgerKey; cuts: number; answers: Map<Answer, HeldCut> }>();
  for (const cut of held) {
    const text = keyText(cut.key);
    const row = byKey.get(text) ?? { key: cut.key, cuts: 0, answers: new Map() };
    byKey.set(text, row);
    row.cuts += 1;
    row.answers.set(cut.answer, cut);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([, { key, cuts, answers }]): LedgerRow => {
      const holders = [...answers.values()];
      const answersWith = emptyCounts();
      for (const holder of holders) answersWith[holder.status] += 1;
      if (!familiesWithSteps.has(key.family)) return { ...key, cuts, answersWith };
      const steps = holders.reduce((sum, holder) => sum + (holder.steps ?? 0), 0);
      return { ...key, cuts, answersWith, steps, per100Steps: steps === 0 ? null : Math.round((cuts * 10_000) / steps) / 100 };
    });
}

/** The cuts of a fact and of every fact it holds through object keys alone, as a composite holds its sections. */
function factCuts(fact: Record<string, unknown>): Record<string, unknown>[] {
  const own = Array.isArray(fact.cuts) ? fact.cuts.filter(isObject) : [];
  const nested = Object.values(fact).flatMap((child) => nestedFacts(child)).flatMap(factCuts);
  return [...own, ...nested];
}

function nestedFacts(value: unknown): Record<string, unknown>[] {
  if (!isObject(value)) return [];
  if (isStatus(value.status)) return [value];
  return Object.values(value).flatMap(nestedFacts);
}

function keyOf(family: string, cut: Record<string, unknown>): LedgerKey {
  const { kind, reason, subReason, at } = cut;
  if (typeof reason !== "string" || !(CUT_REASONS as readonly string[]).includes(reason)) throw new CutLedgerError("unknown-cut-reason", `${family}: ${JSON.stringify(reason)}`);
  if (subReason !== undefined && (typeof subReason !== "string" || !(CUT_SUB_REASONS as readonly string[]).includes(subReason))) throw new CutLedgerError("unknown-cut-sub-reason", `${family}: ${JSON.stringify(subReason)}`);
  const first = Array.isArray(at) ? at[0] : undefined;
  return keyFields({ family, language: languageOf(typeof first === "string" ? first : undefined), kind: String(kind), reason, subReason });
}

/** The language of a place: the place itself, then without each trailing `:<line>` or `:<symbol>`, until a profile reads it. */
export function languageOf(place: string | undefined): string {
  for (let candidate = place; candidate !== undefined; candidate = withoutSuffix(candidate)) {
    const read = candidate;
    const profile = LANGUAGE_PROFILES.find((languageProfile) => languageProfile.reads(read));
    if (profile !== undefined) return profile.language;
  }
  return NO_LANGUAGE;
}

function withoutSuffix(place: string): string | undefined {
  const separator = place.lastIndexOf(":");
  return separator === -1 ? undefined : place.slice(0, separator);
}

function expandedSteps(fact: Record<string, unknown>): number | undefined {
  const value = fact.value;
  if (!isObject(value) || !isObject(value.cost)) return undefined;
  return typeof value.cost.expanded === "number" ? value.cost.expanded : undefined;
}

function valuesOf({ cuts, answersWith, steps, per100Steps }: LedgerRow): LedgerValues {
  return { cuts, answersWith, ...(steps === undefined ? {} : { steps, per100Steps }) };
}

function keyFields({ family, language, kind, reason, subReason }: Omit<LedgerKey, "subReason"> & { subReason?: string | undefined }): LedgerKey {
  return { family, language, kind, reason, ...(subReason === undefined ? {} : { subReason }) };
}

function keyText({ family, language, kind, reason, subReason }: LedgerKey): string {
  return [family, language, kind, reason, subReason ?? ""].join("\0");
}

function totalCuts(rows: readonly LedgerRow[]): number {
  return rows.reduce((sum, row) => sum + row.cuts, 0);
}

function isStatus(value: unknown): value is Status {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

function emptyCounts(): StatusCounts {
  return { complete: 0, partial: 0, unknown: 0 };
}
