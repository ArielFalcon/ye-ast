import { ELEMENT } from "../contracts/access-path.ts";
import type { ValueClass } from "../contracts/change.ts";
import type { AccessStep, EqualityOperator, JsonValue, Literal, Predicate, Replacement, UseEnd, UseOperation } from "../contracts/use-operation.ts";
import { ARRAY_PROTOTYPE, BOOLEAN_PROTOTYPE, NUMBER_PROTOTYPE, OBJECT_PROTOTYPE, STRING_PROTOTYPE, type MemberKind } from "./javascript-prototypes.ts";

/** What the failing step or end needs the value to be: one to read a member from (as object destructuring does), a function, an iterable. */
export type Capability = "readable" | "function" | "iterable";

type Value = undefined | JsonValue;

/**
 * A value as the module reasons about it. A `value` is exact when its own keys and elements are all known (a replacement
 * built from a literal) and a representative of its class otherwise. A `function` comes from a built-in member; a `json`
 * is some JSON value the module cannot tell apart, so never a function; an `unknown` is anything.
 */
export type Subject =
  | { readonly kind: "value"; readonly value: Value; readonly exact: boolean }
  | { readonly kind: "function" }
  | { readonly kind: "json" }
  | { readonly kind: "unknown" };

type ValueSubject = Extract<Subject, { kind: "value" }>;

const sample = (value: Value): Subject => ({ kind: "value", value, exact: false });
const exact = (value: Value): Subject => ({ kind: "value", value, exact: true });
const UNDEFINED = exact(undefined);
const NUMBER = sample(1);
const FUNCTION: Subject = { kind: "function" };
const JSON_VALUE: Subject = { kind: "json" };
const UNKNOWN: Subject = { kind: "unknown" };

const A_FUNCTION = (): void => undefined;
const EMPTY_ARRAY: readonly JsonValue[] = Object.freeze([]);
const EMPTY_OBJECT: { readonly [key: string]: JsonValue } = Object.freeze({});

export interface Representative {
  /** The value written as a JavaScript literal. */
  literal: string;
  subject: Subject;
}

/**
 * The concrete values that stand for each class: `undefined`; `null`; `false` and `true`; `0`, a fresh number and the
 * numbers the use names; `""`, a fresh string and the strings it names; `[]`; `{}`. A fresh value differs, loosely and so
 * strictly, from every literal the use names, so a guard naming finitely many literals cannot reject it and pass another member.
 */
export function representatives(classes: readonly ValueClass[], named: readonly Literal[]): Representative[] {
  return classes.flatMap((valueClass) => valuesOf(valueClass, named).map((value) => ({ literal: value === undefined ? "undefined" : JSON.stringify(value), subject: sample(value) })));
}

function valuesOf(valueClass: ValueClass, named: readonly Literal[]): readonly Value[] {
  switch (valueClass) {
    case "null":
      return [null];
    case "undefined":
      return [undefined];
    case "boolean":
      return [false, true];
    case "number":
      return distinct([0, fresh<number>(1, (candidate) => candidate + 1, named), ...named.filter((literal) => typeof literal === "number")]);
    case "string":
      return distinct(["", fresh<string>("a", (candidate) => `${candidate}a`, named), ...named.filter((literal) => typeof literal === "string")]);
    case "array":
      return [EMPTY_ARRAY];
    case "object":
      return [EMPTY_OBJECT];
  }
}

const distinct = <T>(values: readonly T[]): readonly T[] => [...new Set(values)];

function fresh<T extends number | string>(first: T, next: (candidate: T) => T, named: readonly Literal[]): T {
  let candidate = first;
  while (named.some((literal) => equality("==", candidate, literal))) candidate = next(candidate);
  return candidate;
}

/** The subject a fallback puts in place of the values its test rejects. */
export function subjectOf(replacement: Replacement): Subject {
  return replacement.kind === "literal" ? exact(replacement.value) : UNKNOWN;
}

function equality(operator: EqualityOperator, left: unknown, right: unknown): boolean {
  switch (operator) {
    case "===":
      return left === right;
    case "!==":
      return left !== right;
    case "==":
      return left == right;
    case "!=":
      return left != right;
  }
}

/** The predicate applied to the subject with the language's operators; `undefined` when the module cannot tell. */
function holdsOn(test: Predicate, subject: Subject): boolean | undefined {
  if (subject.kind === "json" || subject.kind === "unknown") return undefined;
  const value: unknown = subject.kind === "function" ? A_FUNCTION : subject.value;
  switch (test.kind) {
    case "truthy":
      return Boolean(value);
    case "absence":
      return equality(test.operator, value, test.absence === "null" ? null : undefined);
    case "literal":
      return equality(test.operator, value, test.literal);
    case "typeof":
      return equality(test.operator, typeof value, test.type);
    case "array":
      return Array.isArray(value);
  }
}

/** `passes`: the use runs where the test gives `holds`; `rejects`: it does not; `reads-throw`: reading the tested path fails first; `undecided`: the module cannot tell. */
export type TestResult = "passes" | "rejects" | "reads-throw" | "undecided";

/** Applies `test` to what `segments` read from the subject, expecting the result `holds`. */
export function testSubject(test: Predicate, holds: boolean, subject: Subject, segments: readonly string[]): TestResult {
  const followed = segments.length === 0 ? reached(subject) : follow(segments.map(readOf), subject);
  if (followed.kind === "throws") return "reads-throw";
  if (followed.kind === "undecided") return "undecided";
  const result = holdsOn(test, followed.subject);
  return result === undefined ? "undecided" : result === holds ? "passes" : "rejects";
}

const readOf = (segment: string): AccessStep => (segment === ELEMENT ? { kind: "keyed", optional: false } : { kind: "member", name: segment, optional: false });

type Followed = { kind: "throws"; at: number; capability: Capability } | { kind: "reached"; subject: Subject } | { kind: "undecided" };

const reached = (subject: Subject): Followed => ({ kind: "reached", subject });

/** Applies the steps in order; stops at the first that throws, and at the first applied to a value the module cannot tell. */
function follow(steps: readonly AccessStep[], start: Subject): Followed {
  let current = start;
  for (const [at, step] of steps.entries()) {
    const next = apply(step, current);
    if (next === "throws") return { kind: "throws", at, capability: step.kind === "call" ? "function" : "readable" };
    if (next === "undecided") return { kind: "undecided" };
    current = next === "short-circuit" ? UNDEFINED : next;
    if (next === "short-circuit") break;
  }
  return reached(current);
}

/** A call of a function is undecided: what the callee does with the arguments the code passes is not modelled. */
function apply(step: AccessStep, current: Subject): Subject | "throws" | "undecided" | "short-circuit" {
  if (current.kind === "unknown") return "undecided";
  if (current.kind === "value" && (current.value === null || current.value === undefined)) return step.optional ? "short-circuit" : "throws";
  if (step.kind === "call") return current.kind === "function" || (current.kind === "json" && step.optional) ? "undecided" : "throws";
  if (current.kind === "json") return "undecided";
  if (current.kind === "function" || (step.kind === "keyed" && step.key === undefined)) return UNKNOWN;
  return readMember(current, String(step.kind === "member" ? step.name : step.key));
}

const isArray = (value: unknown): value is readonly JsonValue[] => Array.isArray(value);

function isIndex(name: string): boolean {
  const index = Number(name);
  return Number.isInteger(index) && index >= 0 && String(index) === name;
}

/** A member of a value that is not `null` or `undefined`: what the built-in prototypes hold under that name, else `undefined`; an object's own keys are open unless exact. */
function readMember({ value, exact: known }: ValueSubject, name: string): Subject {
  if (typeof value === "string") return isIndex(name) ? (known ? exact(value[Number(name)]) : UNKNOWN) : inherited(STRING_PROTOTYPE, name);
  if (typeof value === "number") return inherited(NUMBER_PROTOTYPE, name);
  if (typeof value === "boolean") return inherited(BOOLEAN_PROTOTYPE, name);
  if (isArray(value)) return isIndex(name) ? (known ? exact(value[Number(name)]) : UNKNOWN) : inherited(ARRAY_PROTOTYPE, name);
  const object = value as { readonly [key: string]: JsonValue };
  if (known) return Object.hasOwn(object, name) ? exact(object[name]) : inherited(OBJECT_PROTOTYPE, name);
  return OBJECT_PROTOTYPE.has(name) ? inherited(OBJECT_PROTOTYPE, name) : JSON_VALUE;
}

function inherited(table: ReadonlyMap<string, MemberKind>, name: string): Subject {
  switch (table.get(name) ?? OBJECT_PROTOTYPE.get(name)) {
    case undefined:
      return UNDEFINED;
    case "function":
      return FUNCTION;
    case "number":
      return NUMBER;
    case "object":
      return UNKNOWN;
  }
}

/** What running a use on one value comes to: a step or the end throws, the use runs, or the module cannot tell (`sink` when the end is outside its vocabulary). */
export type Evaluation = { kind: "throws"; at: number; capability: Capability } | { kind: "runs" } | { kind: "unknown"; cause: "value" | "sink" };

const RUNS: Evaluation = { kind: "runs" };
const UNKNOWN_VALUE: Evaluation = { kind: "unknown", cause: "value" };
const UNKNOWN_SINK: Evaluation = { kind: "unknown", cause: "sink" };

/** Walks the steps over the subject with JavaScript's semantics, then applies the end to the value reached. No repository code runs. */
export function evaluate({ steps, end }: UseOperation, subject: Subject): Evaluation {
  const followed = follow(steps, subject);
  if (followed.kind === "throws") return followed;
  return followed.kind === "undecided" ? UNKNOWN_VALUE : finish(end, followed.subject, steps.length);
}

/** `at` is where the end sits after the steps: the index a failure at the end reports. */
function finish(end: UseEnd, subject: Subject, at: number): Evaluation {
  switch (end.kind) {
    case "none":
      return at > 0 ? RUNS : needsValue(subject, at, "readable");
    case "iterate": {
      const absence = subject.kind === "value" && (subject.value === null || subject.value === undefined) ? String(subject.value) : undefined;
      return absence !== undefined && end.tolerates.some((tolerated) => tolerated === absence) ? RUNS : needsIterable(subject, at);
    }
    case "destructure":
      return end.shape === "array" ? needsIterable(subject, at) : needsValue(subject, at, "readable");
    case "compare":
    case "coerce":
    case "consume":
      return RUNS;
    case "unmodelled":
      return UNKNOWN_SINK;
  }
}

/** Throws on `null` and `undefined`, runs on any other value, and cannot tell when the value may be either. */
function needsValue(subject: Subject, at: number, capability: Capability): Evaluation {
  if (subject.kind === "json" || subject.kind === "unknown") return UNKNOWN_VALUE;
  return subject.kind === "value" && (subject.value === null || subject.value === undefined) ? { kind: "throws", at, capability } : RUNS;
}

/** Strings and arrays are iterable; so is nothing else a JSON value or a built-in member can be. */
function needsIterable(subject: Subject, at: number): Evaluation {
  if (subject.kind === "json" || subject.kind === "unknown") return UNKNOWN_VALUE;
  return subject.kind === "value" && (typeof subject.value === "string" || isArray(subject.value)) ? RUNS : { kind: "throws", at, capability: "iterable" };
}
