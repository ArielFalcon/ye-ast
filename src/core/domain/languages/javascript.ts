import { ELEMENT } from "../contracts/access-path.ts";
import type { ValueClass } from "../contracts/change.ts";
import type { AccessStep, EqualityOperator, JsonValue, Literal, Predicate, Replacement, UseEnd, UseOperation } from "../contracts/use-operation.ts";
import { ARRAY_PROTOTYPE, BOOLEAN_PROTOTYPE, NUMBER_PROTOTYPE, OBJECT_PROTOTYPE, STRING_PROTOTYPE, type MemberKind } from "./javascript-prototypes.ts";

/** What the failing step or end needs the value to be: one to read a member from (as object destructuring does), a function, an iterable. */
export type Capability = "readable" | "function" | "iterable";

type Value = undefined | JsonValue;

/** The operators that compare without converting either side. */
export const STRICT_OPERATORS: ReadonlySet<string> = new Set(["===", "!=="]);

/**
 * What a subject stands for. An `exact` value is that one value, its own keys and elements all known (`null`, `0`, `""`, a
 * literal the code or the change writes, what is read from one). A `sample` is every value of its class but the `without`
 * literals, which other subjects stand for: `value` is one member, and the rest are told apart from it only by the
 * decisions below. A `function` comes from a built-in member; a `json` is some JSON value the module cannot tell apart,
 * so never a function; an `unknown` is anything.
 */
export type Subject =
  | { readonly kind: "value"; readonly value: Value; readonly exact: true }
  | { readonly kind: "value"; readonly value: Value; readonly exact: false; readonly without: readonly Literal[] }
  | { readonly kind: "function" }
  | { readonly kind: "json" }
  | { readonly kind: "unknown" };

type ValueSubject = Extract<Subject, { kind: "value" }>;

const sample = (value: Value, without: readonly Literal[]): ValueSubject => ({ kind: "value", value, exact: false, without });
const exact = (value: Value): ValueSubject => ({ kind: "value", value, exact: true });
const UNDEFINED = exact(undefined);
/** Any number: what the length of a sample gives. */
const ANY_NUMBER = sample(1, []);
const FUNCTION: Subject = { kind: "function" };
const JSON_VALUE: Subject = { kind: "json" };
const UNKNOWN: Subject = { kind: "unknown" };

const A_FUNCTION = (): void => undefined;
const NONE: readonly Literal[] = [];
const EMPTY_ARRAY: readonly JsonValue[] = Object.freeze([]);
const EMPTY_OBJECT: { readonly [key: string]: JsonValue } = Object.freeze({});

export interface Representative {
  /** The value written as a JavaScript literal. */
  literal: string;
  subject: Subject;
}

/**
 * What stands for each class, none of it a retired literal: the exact values `undefined`, `null`, `false`, `true`, `0`
 * and `""`, the numbers and strings the use names, and a sample of every other number and string (a fresh one, which
 * differs, loosely and so strictly, from every literal in `avoid`), of every array (`[]`) and of every object (`{}`). A
 * guard naming finitely many literals cannot reject a sample and pass another member of its class.
 */
export function representatives(classes: readonly ValueClass[], named: readonly Literal[], avoid: readonly Literal[] = named, retired: readonly Literal[] = []): Representative[] {
  return classes.flatMap((valueClass) => subjectsOf(valueClass, named, avoid).filter((subject) => !subject.exact || !retired.some((literal) => literal === subject.value)).map((subject) => ({ literal: literalOf(subject.value), subject })));
}

/** Each literal as itself: a value whose own keys and elements are all known. */
export function literalRepresentatives(literals: readonly Literal[]): Representative[] {
  return literals.map((value) => ({ literal: literalOf(value), subject: exact(value) }));
}

const literalOf = (value: Value): string => (value === undefined ? "undefined" : JSON.stringify(value));

function subjectsOf(valueClass: ValueClass, named: readonly Literal[], avoid: readonly Literal[]): readonly ValueSubject[] {
  switch (valueClass) {
    case "null":
      return [exact(null)];
    case "undefined":
      return [UNDEFINED];
    case "boolean":
      return [exact(false), exact(true)];
    case "number":
      return exactAndSample<number>(0, 1, (candidate) => candidate + 1, "number", named, avoid);
    case "string":
      return exactAndSample<string>("", "a", (candidate) => `${candidate}a`, "string", named, avoid);
    case "array":
      return [sample(EMPTY_ARRAY, [])];
    case "object":
      return [sample(EMPTY_OBJECT, [])];
  }
}

/** The fixed value of a primitive class, a fresh sample of every other, and the values the use names. */
function exactAndSample<T extends number | string>(fixed: T, first: T, next: (candidate: T) => T, type: "number" | "string", named: readonly Literal[], avoid: readonly Literal[]): readonly ValueSubject[] {
  const ofType = (literals: readonly Literal[]): T[] => literals.filter((literal): literal is T => typeof literal === type);
  return [exact(fixed), sample(fresh(first, next, avoid), [fixed, ...ofType(avoid)]), ...[...new Set(ofType(named))].filter((literal) => literal !== fixed).map(exact)];
}

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

/**
 * The predicate on what the subject stands for, with the language's operators; `undefined` when the module cannot tell.
 * An exact value is decided by applying the predicate. A sample, a function or any number is decided only where every
 * value it stands for gives one result: a test of its type, of an absence, or of being an array always does; truthiness
 * and equality with a literal of its own type when the literal is one the sample is without; strict equality with a
 * literal of another type; any other loose equality is not, since a member of the class may convert to equal the literal.
 */
function holdsOn(test: Predicate, subject: Subject): boolean | undefined {
  if (subject.kind === "json" || subject.kind === "unknown") return undefined;
  if (subject.kind === "value" && subject.exact) return applied(test, subject.value);
  const [value, without] = subject.kind === "function" ? [A_FUNCTION, NONE] : [subject.value, subject.without];
  /** True when no value the subject stands for equals `literal`, strictly or loosely when both are of one type. */
  const differs = (literal: Literal): boolean => typeof literal !== typeof value || without.includes(literal);
  switch (test.kind) {
    case "truthy":
      return (typeof value === "number" && !without.includes(0)) || (typeof value === "string" && !without.includes("")) ? undefined : true;
    case "literal":
      return (typeof test.literal === typeof value || STRICT_OPERATORS.has(test.operator)) && differs(test.literal) ? applied(test, value) : undefined;
    case "one-of":
      return test.literals.every(differs) ? false : undefined;
    default:
      return applied(test, value);
  }
}

function applied(test: Predicate, value: unknown): boolean {
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
    case "one-of":
      return test.literals.some((literal) => value === literal) || test.absences.some((absence) => value === (absence === "null" ? null : undefined));
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

/**
 * A member of a value that is not `null` or `undefined`: what the built-in prototypes hold under that name, else
 * `undefined`. An exact value has exact elements, length and own keys; a sample's are open: a length is any number, an
 * element is unknown, and on an object the member Object.prototype holds may be an own JSON value instead.
 */
function readMember(subject: ValueSubject, name: string): Subject {
  const { value } = subject;
  if (typeof value === "string" || isArray(value)) {
    if (isIndex(name)) return subject.exact ? exact(value[Number(name)]) : UNKNOWN;
    if (name === "length") return subject.exact ? exact(value.length) : ANY_NUMBER;
    return inherited(typeof value === "string" ? STRING_PROTOTYPE : ARRAY_PROTOTYPE, name);
  }
  if (typeof value === "number") return inherited(NUMBER_PROTOTYPE, name);
  if (typeof value === "boolean") return inherited(BOOLEAN_PROTOTYPE, name);
  const object = value as { readonly [key: string]: JsonValue };
  if (subject.exact) return Object.hasOwn(object, name) ? exact(object[name]) : inherited(OBJECT_PROTOTYPE, name);
  return OBJECT_PROTOTYPE.has(name) ? UNKNOWN : JSON_VALUE;
}

function inherited(table: ReadonlyMap<string, MemberKind>, name: string): Subject {
  switch (table.get(name) ?? OBJECT_PROTOTYPE.get(name)) {
    case undefined:
      return UNDEFINED;
    case "function":
      return FUNCTION;
    case "number":
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
      return STRICT_OPERATORS.has(end.operator) ? RUNS : converts(subject);
    case "coerce":
      return converts(subject);
    case "consume":
      return RUNS;
    case "unmodelled":
      return UNKNOWN_SINK;
  }
}

/**
 * Converting an object to a primitive calls its `valueOf` and `toString`, and an own key of either holds a JSON value that
 * is no function, which can leave the conversion without a result. A primitive converts; an exact object or array does
 * when no own key shadows them, nor any element's; a sample array or object has open keys and elements, and a value the
 * module cannot tell may be any of them.
 */
function converts(subject: Subject): Evaluation {
  if (subject.kind === "function") return RUNS;
  if (subject.kind !== "value") return UNKNOWN_VALUE;
  return subject.exact ? (convertible(subject.value) ? RUNS : UNKNOWN_VALUE) : typeof subject.value === "object" ? UNKNOWN_VALUE : RUNS;
}

function convertible(value: Value): boolean {
  if (isArray(value)) return value.every(convertible);
  return typeof value !== "object" || value === null || !(Object.hasOwn(value, "valueOf") || Object.hasOwn(value, "toString"));
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
