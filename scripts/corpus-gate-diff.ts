/**
 * The comparison of the corpus gate (ADR-0039): which answers differ between a base and a candidate engine, how, and
 * whether every difference is one the change declared. Pure: no I/O.
 */

export type Direction = "+" | "-" | "±";

/** A family whose answers may change, in one direction: `+` only adds, `-` only removes, `±` any change. */
export interface Expectation {
  family: string;
  direction: Direction;
}

export interface Answer {
  id: string;
  family: string;
  argv: readonly string[];
  exit: number | null;
  stdout: unknown;
  stderr: string;
}

/** One structural difference. An array is compared as a multiset: a modified element is one removal and one addition. */
export interface Difference {
  kind: "added" | "removed" | "changed" | "reordered";
  path: string;
  base?: unknown;
  candidate?: unknown;
}

export interface Counter {
  path: string;
  base: number | null;
  candidate: number | null;
}

export interface AnswerComparison {
  id: string;
  family: string;
  identical: boolean;
  base: { exit: number | null; status: string | null };
  candidate: { exit: number | null; status: string | null };
  added: number;
  removed: number;
  changed: number;
  examples: Difference[];
  counters: Counter[];
}

export type ViolationRule = "undeclared-family" | "undeclared-direction" | "new-failure" | "degraded";

export interface Violation {
  answer: string;
  family: string;
  rule: ViolationRule;
}

export class ExpectationError extends Error {
  constructor(readonly code: "invalid-expectation" | "duplicate-expectation" | "none-with-families", readonly detail: string) {
    super(`${code}: ${detail}`);
  }
}

const EXAMPLES_PER_ANSWER = 10;
const EXAMPLE_CHARACTERS = 200;

/** Parses the `--expect` values: `none`, or `<family>:<+|-|±>` once per family. `none` alone is the empty list. */
export function parseExpectations(values: readonly string[]): Expectation[] {
  if (values.includes("none")) {
    if (values.length > 1) throw new ExpectationError("none-with-families", values.join(" "));
    return [];
  }
  return parseDirected(values).map(([family, direction]) => ({ family, direction }));
}

/** Each `<name>:<+|-|±>` value as its name and direction, once per name, sorted by name. */
export function parseDirected(values: readonly string[]): [string, Direction][] {
  const parsed: [string, Direction][] = [];
  for (const value of values) {
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*):([+\-±])$/u.exec(value);
    if (match === null) throw new ExpectationError("invalid-expectation", value);
    const [, name, direction] = match as unknown as [string, string, Direction];
    if (parsed.some(([declared]) => declared === name)) throw new ExpectationError("duplicate-expectation", name);
    parsed.push([name, direction]);
  }
  return parsed.sort(([a], [b]) => compareText(a, b));
}

/** JSON with object keys sorted, so two equal values serialize alike whatever their key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function differences(base: unknown, candidate: unknown, path = ""): Difference[] {
  if (canonical(base) === canonical(candidate)) {
    return JSON.stringify(base) === JSON.stringify(candidate) ? [] : [{ kind: "reordered", path }];
  }
  if (Array.isArray(base) && Array.isArray(candidate)) return arrayDifferences(base, candidate, path);
  if (isObject(base) && isObject(candidate)) {
    const keys = [...new Set([...Object.keys(base), ...Object.keys(candidate)])].sort(compareText);
    return keys.flatMap((key): Difference[] => {
      const at = `${path}/${key}`;
      if (!(key in base)) return [{ kind: "added", path: at, candidate: candidate[key] }];
      if (!(key in candidate)) return [{ kind: "removed", path: at, base: base[key] }];
      return differences(base[key], candidate[key], at);
    });
  }
  return [{ kind: "changed", path, base, candidate }];
}

function arrayDifferences(base: readonly unknown[], candidate: readonly unknown[], path: string): Difference[] {
  const unmatched = new Map<string, number>();
  for (const element of candidate) unmatched.set(canonical(element), (unmatched.get(canonical(element)) ?? 0) + 1);
  const removed: Difference[] = [];
  for (const element of base) {
    const key = canonical(element);
    const left = unmatched.get(key) ?? 0;
    if (left > 0) unmatched.set(key, left - 1);
    else removed.push({ kind: "removed", path, base: element });
  }
  const added: Difference[] = [];
  for (const element of candidate) {
    const key = canonical(element);
    const left = unmatched.get(key) ?? 0;
    if (left === 0) continue;
    unmatched.set(key, left - 1);
    added.push({ kind: "added", path, candidate: element });
  }
  return removed.length + added.length === 0 ? [{ kind: "reordered", path }] : [...removed, ...added];
}

/** The length of every array reached through object keys alone (never inside an array), by its path. */
export function arrayLengths(value: unknown): Map<string, number> {
  return new Map([...arraysAt(value)].map(([path, array]) => [path, array.length]));
}

/** Every array reached through object keys alone (never inside an array), by its path. */
export function arraysAt(value: unknown, path = "", found = new Map<string, readonly unknown[]>()): Map<string, readonly unknown[]> {
  if (Array.isArray(value)) found.set(path, value);
  else if (isObject(value)) for (const key of Object.keys(value)) arraysAt(value[key], `${path}/${key}`, found);
  return found;
}

/** The status of the shallowest object that states one, reached through object keys alone. */
export function topStatus(value: unknown): string | null {
  return (topFact(value)?.status as string | undefined) ?? null;
}

/** The shallowest object that states a status, reached through object keys alone: the fact an answer printed. */
export function topFact(value: unknown): Record<string, unknown> | null {
  let level: unknown[] = [value];
  while (level.length > 0) {
    const next: unknown[] = [];
    for (const node of level) {
      if (!isObject(node)) continue;
      if (typeof node.status === "string") return node;
      next.push(...Object.values(node));
    }
    level = next;
  }
  return null;
}

export function compareAnswers(base: Answer, candidate: Answer): AnswerComparison {
  const baseBody = { exit: base.exit, stdout: base.stdout, stderr: base.stderr };
  const candidateBody = { exit: candidate.exit, stdout: candidate.stdout, stderr: candidate.stderr };
  const found = differences(baseBody, candidateBody);
  const baseLengths = arrayLengths(base.stdout);
  const candidateLengths = arrayLengths(candidate.stdout);
  const counters = [...new Set([...baseLengths.keys(), ...candidateLengths.keys()])]
    .sort(compareText)
    .map((path) => ({ path, base: baseLengths.get(path) ?? null, candidate: candidateLengths.get(path) ?? null }))
    .filter((counter) => counter.base !== counter.candidate);
  return {
    id: base.id,
    family: base.family,
    identical: JSON.stringify(baseBody) === JSON.stringify(candidateBody),
    base: { exit: base.exit, status: topStatus(base.stdout) },
    candidate: { exit: candidate.exit, status: topStatus(candidate.stdout) },
    added: found.filter((difference) => difference.kind === "added").length,
    removed: found.filter((difference) => difference.kind === "removed").length,
    changed: found.filter((difference) => difference.kind === "changed" || difference.kind === "reordered").length,
    examples: found.slice(0, EXAMPLES_PER_ANSWER).map(abbreviated),
    counters,
  };
}

/**
 * The differences no expectation explains. A new non-zero exit always fails. Any other difference needs its family
 * declared; a declared `+` admits only additions, `-` only removals, and a changed value, a reordering or a `complete`
 * answer that is no longer `complete` needs `±`.
 */
export function violations(comparisons: readonly AnswerComparison[], expectations: readonly Expectation[]): Violation[] {
  const found: Violation[] = [];
  for (const comparison of comparisons) {
    if (comparison.identical) continue;
    const violation = (rule: ViolationRule) => found.push({ answer: comparison.id, family: comparison.family, rule });
    if (comparison.base.exit === 0 && comparison.candidate.exit !== 0) {
      violation("new-failure");
      continue;
    }
    const expectation = expectations.find((candidate) => candidate.family === comparison.family);
    if (expectation === undefined) {
      violation("undeclared-family");
      continue;
    }
    if (expectation.direction === "±") continue;
    const degraded = comparison.base.status === "complete" && comparison.candidate.status !== "complete";
    if (degraded) violation("degraded");
    const admitted = expectation.direction === "+" ? comparison.removed === 0 : comparison.added === 0;
    if (!admitted || comparison.changed > 0) violation("undeclared-direction");
  }
  return found;
}

function abbreviated(difference: Difference): Difference {
  const shorten = (value: unknown) => {
    const text = JSON.stringify(value) ?? "undefined";
    return text.length <= EXAMPLE_CHARACTERS ? value : `${text.slice(0, EXAMPLE_CHARACTERS)}…`;
  };
  return {
    ...difference,
    ...("base" in difference && { base: shorten(difference.base) }),
    ...("candidate" in difference && { candidate: shorten(difference.candidate) }),
  };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
