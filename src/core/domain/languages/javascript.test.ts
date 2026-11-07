import assert from "node:assert/strict";
import test from "node:test";
import { ELEMENT } from "../contracts/access-path.ts";
import { VALUE_CLASSES } from "../contracts/change.ts";
import type { AccessStep, JsonValue, Literal, Predicate, UseEnd, UseOperation } from "../contracts/use-operation.ts";
import { evaluate, keepsLeft, representatives, subjectOf, testSubject, wireOf, type Subject } from "./javascript.ts";
import { ARRAY_PROTOTYPE, BOOLEAN_PROTOTYPE, NUMBER_PROTOTYPE, OBJECT_PROTOTYPE, STRING_PROTOTYPE, type MemberKind } from "./javascript-prototypes.ts";

const ALL = representatives(VALUE_CLASSES, []);
const subjectOfLiteral = (literal: string) => ALL.find((representative) => representative.literal === literal)!.subject;
const subjectNaming = (literal: string, named: readonly Literal[]) => representatives(VALUE_CLASSES, named).find((representative) => representative.literal === literal)!.subject;

const member = (name: string, optional = false): AccessStep => ({ kind: "member", name, optional });
const keyed = (key?: string | number, optional = false): AccessStep => ({ kind: "keyed", ...(key === undefined ? {} : { key }), optional });
const call = (optional = false): AccessStep => ({ kind: "call", optional });
const NONE: UseEnd = { kind: "none" };

const run = (literal: string, steps: readonly AccessStep[], end: UseEnd = NONE) => evaluate({ steps, end }, subjectOfLiteral(literal));
const outcome = (literal: string, steps: readonly AccessStep[], end: UseEnd = NONE) => {
  const evaluation = run(literal, steps, end);
  return evaluation.kind === "throws" ? `throws ${evaluation.at} ${evaluation.capability}` : evaluation.kind;
};

test("each class is represented by values written as JavaScript literals, the literals the use names, and a fresh value that differs from all of them", () => {
  assert.deepEqual(
    ALL.map(({ literal }) => literal),
    ["null", "undefined", "false", "true", "0", "1", '""', '"a"', "[]", "{}"],
  );
  assert.deepEqual(
    representatives(["number", "string"], [true, "a"]).map(({ literal }) => literal),
    ["0", "2", '""', '"aa"', '"a"'],
  );
  assert.deepEqual(
    representatives(["number"], [1, 5]).map(({ literal }) => literal),
    ["0", "2", "1", "5"],
  );
});

test("a predicate is applied to a representative with the language's own operators, by exact operator and polarity", () => {
  const cases: readonly (readonly [Predicate, string, boolean])[] = [
    [{ kind: "absence", operator: "==", absence: "null" }, "undefined", true],
    [{ kind: "absence", operator: "===", absence: "null" }, "undefined", false],
    [{ kind: "absence", operator: "!=", absence: "undefined" }, "null", false],
    [{ kind: "absence", operator: "!==", absence: "null" }, "0", true],
    [{ kind: "literal", operator: "===", literal: 0 }, '""', false],
    [{ kind: "literal", operator: "==", literal: 0 }, '""', true],
    [{ kind: "literal", operator: "!=", literal: "" }, '""', false],
    [{ kind: "typeof", operator: "===", type: "object" }, "null", true],
    [{ kind: "typeof", operator: "!==", type: "object" }, "[]", false],
    [{ kind: "array" }, "[]", true],
    [{ kind: "array" }, "{}", false],
    [{ kind: "truthy" }, '""', false],
    [{ kind: "truthy" }, "{}", true],
  ];
  for (const [predicate, literal, expected] of cases) {
    assert.equal(testSubject(predicate, true, subjectOfLiteral(literal), []), expected ? "passes" : "rejects", `${JSON.stringify(predicate)} on ${literal}`);
  }
  assert.equal(testSubject({ kind: "truthy" }, false, subjectOfLiteral("{}"), []), "rejects");
});

test("a one-of predicate is a strict equality with any of its literals and absences: no coercion, and an absence only matches itself", () => {
  const oneOf: Predicate = { kind: "one-of", literals: [0, "a"], absences: ["null"] };
  const holds = (literal: string) => testSubject(oneOf, true, subjectNaming(literal, [0, "a"]), []);
  assert.deepEqual(["0", '"a"', "null"].map(holds), ["passes", "passes", "passes"]);
  assert.deepEqual(["undefined", "false", '""', "1", "[]"].map(holds), ["rejects", "rejects", "rejects", "rejects", "rejects"]);
  assert.equal(testSubject(oneOf, false, subjectOfLiteral("0"), []), "rejects");
  assert.equal(testSubject({ kind: "one-of", literals: [], absences: ["undefined"] }, true, subjectOfLiteral("undefined"), []), "passes");
});

test("a test of a path deeper than the value reads it first: a read that throws is its own failure, one the module cannot decide is undecided", () => {
  const truthy: Predicate = { kind: "truthy" };
  assert.equal(testSubject(truthy, true, subjectOfLiteral("null"), ["city"]), "reads-throw");
  assert.equal(testSubject(truthy, true, subjectOfLiteral('""'), ["city"]), "rejects");
  assert.equal(testSubject(truthy, true, subjectOfLiteral("{}"), ["city"]), "undecided");
  assert.equal(testSubject(truthy, true, subjectOfLiteral("{}"), [ELEMENT]), "undecided");
  assert.equal(testSubject(truthy, true, subjectOfLiteral("{}"), []), "passes");
});

test("a step on null or undefined throws, and an optional one ends the chain at undefined", () => {
  assert.equal(outcome("null", [member("a")]), "throws 0 readable");
  assert.equal(outcome("undefined", [keyed(0)]), "throws 0 readable");
  assert.equal(outcome("undefined", [call()]), "throws 0 function");
  assert.equal(outcome("null", [member("a", true), member("b"), call()]), "runs");
  assert.equal(outcome("null", [member("a", true)], { kind: "iterate", tolerates: [] }), "throws 1 iterable");
});

test("a member of a primitive or an array is what the built-in prototypes hold under that name, inherited ones included, else undefined", () => {
  assert.equal(outcome("0", [member("toFixed")]), "runs");
  assert.equal(outcome("true", [member("hasOwnProperty")]), "runs");
  assert.equal(outcome('""', [member("toFixed"), call()]), "throws 1 function");
  assert.equal(outcome("0", [member("missing"), member("name")]), "throws 1 readable");
  assert.equal(outcome("0", [member("missing"), member("name", true)]), "runs");
  assert.equal(outcome("0", [member("missing", true), member("name")]), "throws 1 readable");
  assert.equal(outcome("[]", [member("length"), member("foo"), member("bar")]), "throws 2 readable");
  assert.equal(outcome("[]", [keyed("map")]), "runs");
  assert.equal(outcome('"a"', [member("length"), member("toFixed")]), "runs");
});

test("a member of an object is unknown unless Object.prototype holds it, and a member no JSON value can hold as a function is not callable", () => {
  assert.equal(outcome("{}", [member("name"), member("first")]), "unknown");
  assert.equal(outcome("{}", [member("name"), call()]), "throws 1 function");
  assert.equal(outcome("{}", [member("name"), call(true)]), "unknown");
  assert.equal(outcome("{}", [member("toString")]), "runs");
  assert.equal(outcome("{}", [member("name")]), "runs");
});

test("a keyed read is a member read under its literal key, and any other keyed read is unknown past null and undefined", () => {
  assert.equal(outcome("{}", [keyed("toString")]), "runs");
  assert.equal(outcome("[]", [keyed(0), member("name")]), "unknown");
  assert.equal(outcome("0", [keyed(0), member("name")]), "throws 1 readable");
  assert.equal(outcome("{}", [keyed(), member("name")]), "unknown");
  assert.equal(outcome("null", [keyed()]), "throws 0 readable");
});

test("a call throws when its target is not a function, and a call of a function is unknown since what it does is not modelled", () => {
  assert.equal(outcome("0", [call()]), "throws 0 function");
  assert.equal(outcome("[]", [member("map"), call(), member("length")]), "unknown");
  assert.equal(outcome("[]", [member("map"), call()]), "unknown");
  assert.equal(outcome("[]", [member("length"), call()]), "throws 1 function");
  assert.equal(outcome("null", [call(true), member("a")]), "runs");
});

test("a loose equality converts an exact object or array like a coercing end: undecided when the conversion may fail, decided otherwise, and null or undefined convert nothing", () => {
  const loose = (operator: "==" | "!=", literal: number): Predicate => ({ kind: "literal", operator, literal });
  const decide = (value: JsonValue, test: Predicate) => testSubject(test, true, subjectOf({ kind: "literal", value }), []);
  assert.equal(decide({ valueOf: null, toString: null }, loose("==", 1)), "undecided");
  assert.equal(decide([{ toString: null }], loose("!=", 0)), "undecided");
  assert.equal(decide([1], loose("==", 1)), "passes");
  assert.equal(decide({}, loose("==", 1)), "rejects");
  assert.equal(decide({ valueOf: null, toString: null }, { kind: "absence", operator: "==", absence: "null" }), "rejects");
});

test("a replacement built from a literal is fully known: its own keys and elements are exact", () => {
  const replacement = subjectOf({ kind: "literal", value: { a: null, list: [1], text: "xy" } });
  const on = (steps: readonly AccessStep[]) => evaluate({ steps, end: NONE }, replacement);
  assert.equal(on([member("a"), member("b")]).kind, "throws");
  assert.deepEqual(on([member("c"), member("d")]), { kind: "throws", at: 1, capability: "readable" });
  assert.deepEqual(on([member("list"), keyed(1), member("x")]), { kind: "throws", at: 2, capability: "readable" });
  assert.equal(on([member("list"), keyed(0), member("toFixed")]).kind, "runs");
  assert.deepEqual(on([member("text"), keyed(5), member("x")]), { kind: "throws", at: 2, capability: "readable" });
  assert.equal(on([member("text"), keyed(1), member("x")]).kind, "runs");
  assert.equal(on([member("toString")]).kind, "runs");
  assert.equal(on([keyed(), member("x")]).kind, "unknown");
});

test("an opaque replacement is an unknown value: only the ends that run on every value run", () => {
  const opaque = subjectOf({ kind: "opaque" });
  const on = (operation: UseOperation) => evaluate(operation, opaque).kind;
  assert.equal(on({ steps: [member("a")], end: NONE }), "unknown");
  assert.equal(on({ steps: [], end: { kind: "consume", as: "shown" } }), "runs");
  assert.equal(on({ steps: [], end: { kind: "iterate", tolerates: [] } }), "unknown");
  assert.equal(on({ steps: [], end: NONE }), "unknown");
});

test("an iteration or an array destructuring throws unless the value is iterable, an object destructuring only on null and undefined", () => {
  const iterate: UseEnd = { kind: "iterate", tolerates: [] };
  const array: UseEnd = { kind: "destructure", shape: "array" };
  const object: UseEnd = { kind: "destructure", shape: "object" };
  assert.deepEqual(
    ALL.map(({ literal }) => outcome(literal, [], iterate)),
    ["throws 0 iterable", "throws 0 iterable", "throws 0 iterable", "throws 0 iterable", "throws 0 iterable", "throws 0 iterable", "runs", "runs", "runs", "throws 0 iterable"],
  );
  assert.deepEqual(
    ALL.map(({ literal }) => outcome(literal, [], array)),
    ALL.map(({ literal }) => outcome(literal, [], iterate)),
  );
  assert.deepEqual(
    ALL.map(({ literal }) => outcome(literal, [], object)),
    ["throws 0 readable", "throws 0 readable", "runs", "runs", "runs", "runs", "runs", "runs", "runs", "runs"],
  );
  assert.equal(outcome("null", [], { kind: "iterate", tolerates: ["null"] }), "runs");
  assert.equal(outcome("undefined", [], { kind: "iterate", tolerates: ["null"] }), "throws 0 iterable");
  assert.equal(outcome("0", [member("missing")], iterate), "throws 1 iterable");
});

test("a strict comparison and a consumption run on every value, a bare use needs a value, and a sink outside the vocabulary is unknown after the steps that throw", () => {
  for (const end of [{ kind: "compare", operator: "===", literal: 1 }, { kind: "consume", as: "shown" }] satisfies UseEnd[]) {
    assert.deepEqual(new Set(ALL.map(({ literal }) => outcome(literal, [], end))), new Set(["runs"]));
  }
  assert.equal(outcome("null", [], NONE), "throws 0 readable");
  assert.equal(outcome("0", [], NONE), "runs");
  assert.equal(outcome("0", [], { kind: "unmodelled", detail: "x" }), "unknown");
  assert.equal(outcome("null", [member("a")], { kind: "unmodelled", detail: "x" }), "throws 0 readable");
});

test("a conversion to a primitive runs on the primitives and is unknown where an own key may shadow valueOf or toString", () => {
  const converts = (end: UseEnd, subject: Subject) => evaluate({ steps: [], end }, subject).kind;
  const plus: UseEnd = { kind: "coerce", operator: "+" };
  const loose: UseEnd = { kind: "compare", operator: "==", literal: 1 };
  const exact = (value: JsonValue) => subjectOf({ kind: "literal", value });
  assert.deepEqual(ALL.map(({ literal, subject }) => [literal, converts(plus, subject)]).filter(([, kind]) => kind !== "runs"), [["[]", "unknown"], ["{}", "unknown"]]);
  for (const end of [plus, loose]) {
    assert.equal(converts(end, exact({})), "runs");
    assert.equal(converts(end, exact([1, "a", null])), "runs");
    for (const shadowing of [{ valueOf: null, toString: null }, { toString: null }, { valueOf: 1 }, [{ toString: 0 }]]) assert.equal(converts(end, exact(shadowing)), "unknown", JSON.stringify(shadowing));
  }
  assert.equal(converts({ kind: "compare", operator: "===", literal: 1 }, exact({ toString: null })), "runs");
  assert.equal(converts(plus, subjectOf({ kind: "opaque" })), "unknown");
});

test("the step evaluation agrees with the running engine wherever it decides", () => {
  const descriptors: readonly (readonly AccessStep[])[] = [
    [member("length")],
    [member("toString"), call()],
    [member("trim"), call(), member("length")],
    [member("missing"), member("name")],
    [member("missing", true), member("name")],
    [keyed("map"), call()],
    [keyed("length"), member("toFixed")],
    [member("length"), member("toFixed"), call()],
    [member("foo"), call()],
    [member("hasOwnProperty"), call(true)],
    [call(true), member("a")],
    [member("length", true), member("x"), member("y")],
    [member("__proto__"), member("x")],
    [member("constructor"), member("name")],
  ];
  const source = (steps: readonly AccessStep[]) =>
    steps.map((step) => (step.kind === "call" ? `${step.optional ? "?." : ""}()` : step.kind === "member" ? `${step.optional ? "?." : "."}${step.name}` : `${step.optional ? "?." : ""}[${JSON.stringify(step.key)}]`)).join("");
  let decided = 0;
  for (const steps of descriptors) {
    for (const { literal } of ALL) {
      const evaluation = run(literal, steps);
      if (evaluation.kind === "unknown") continue;
      const read = new Function(`return (${literal})${source(steps)}`);
      let threw = false;
      try {
        read();
      } catch {
        threw = true;
      }
      assert.equal(evaluation.kind === "throws", threw, `${literal}${source(steps)}`);
      decided++;
    }
  }
  assert.ok(decided > descriptors.length * 5);
});

test("a class sample stands for every value of its class: a predicate is decided only when all of them give one result", () => {
  const named: readonly Literal[] = [5, "k"];
  const result = (predicate: Predicate, literal: string, holds = true, segments: readonly string[] = []) => testSubject(predicate, holds, subjectNaming(literal, named), segments);
  const literal = (operator: "===" | "!==" | "==" | "!=", value: Literal): Predicate => ({ kind: "literal", operator, literal: value });
  assert.equal(result(literal("==", 1), '"a"'), "undecided");
  assert.equal(result(literal("!=", 0), "[]"), "undecided");
  assert.equal(result(literal("==", "7"), "1"), "undecided");
  assert.equal(result(literal("==", true), "1"), "undecided");
  assert.equal(result(literal("===", 9), "1"), "undecided");
  assert.equal(result(literal("===", "9"), '"a"'), "undecided");
  assert.equal(result({ kind: "one-of", literals: [9], absences: [] }, "1"), "undecided");
  assert.equal(result(literal("===", 5), "1"), "rejects");
  assert.equal(result(literal("==", 0), "1"), "rejects");
  assert.equal(result(literal("==", "k"), '"a"'), "rejects");
  assert.equal(result(literal("===", "7"), "1"), "rejects");
  assert.equal(result(literal("!==", 5), "1"), "passes");
  assert.equal(result({ kind: "one-of", literals: [5, "k"], absences: ["null"] }, "1"), "rejects");
  assert.equal(result({ kind: "truthy" }, "1"), "passes");
  assert.equal(result({ kind: "truthy" }, '"a"'), "passes");
  assert.equal(result({ kind: "absence", operator: "==", absence: "undefined" }, "[]"), "rejects");
  assert.equal(result({ kind: "typeof", operator: "===", type: "number" }, "1"), "passes");
  assert.equal(result({ kind: "array" }, "[]"), "passes");
});

test("a length is exact on an exact string or array and any number on a sample, so a test of it is decided only for the exact ones", () => {
  const length = (subject: Subject, test: Predicate, holds = true) => testSubject(test, holds, subject, ["length"]);
  const isZero: Predicate = { kind: "literal", operator: "===", literal: 0 };
  assert.equal(length(subjectOf({ kind: "literal", value: "" }), isZero), "passes");
  assert.equal(length(subjectOf({ kind: "literal", value: [] }), { kind: "truthy" }), "rejects");
  assert.equal(length(subjectOf({ kind: "literal", value: [1, 2] }), isZero), "rejects");
  assert.equal(length(subjectOf({ kind: "literal", value: "xy" }), { kind: "truthy" }), "passes");
  for (const literal of ['"a"', "[]"]) {
    assert.equal(length(subjectOfLiteral(literal), isZero), "undecided", literal);
    assert.equal(length(subjectOfLiteral(literal), { kind: "truthy" }), "undecided", literal);
  }
  assert.equal(length(subjectOfLiteral('"a"'), { kind: "typeof", operator: "===", type: "number" }), "passes");
});

test("a member that Object.prototype holds may be an own JSON value on an open object, and keeps its exact lookup on an exact one", () => {
  const isString: Predicate = { kind: "typeof", operator: "===", type: "string" };
  assert.equal(testSubject(isString, true, subjectOfLiteral("{}"), ["toString"]), "undecided");
  assert.equal(testSubject(isString, true, subjectOfLiteral("{}"), ["valueOf"]), "undecided");
  assert.equal(testSubject(isString, true, subjectOfLiteral("{}"), ["name"]), "undecided");
  assert.equal(testSubject(isString, true, subjectOf({ kind: "literal", value: {} }), ["toString"]), "rejects");
  assert.equal(testSubject(isString, true, subjectOf({ kind: "literal", value: { toString: "x" } }), ["toString"]), "passes");
  assert.equal(outcome("{}", [member("toString"), call()]), "unknown");
});

test("no representative is a retired literal, the fixed samples included, and the fresh values avoid them", () => {
  const retired: readonly Literal[] = [0, "", false];
  assert.deepEqual(
    representatives(VALUE_CLASSES, [], retired, retired).map(({ literal }) => literal),
    ["null", "undefined", "true", "1", '"a"', "[]", "{}"],
  );
  assert.deepEqual(
    representatives(["number", "string", "boolean"], [3, "z"], [3, "z", 1, "a"], [3, "a", true]).map(({ literal }) => literal),
    ["0", "2", '""', '"aa"', '"z"', "false"],
  );
});

const PROTOTYPES: readonly (readonly [object, ReadonlyMap<string, MemberKind>])[] = [
  [Object.prototype, OBJECT_PROTOTYPE],
  [Array.prototype, ARRAY_PROTOTYPE],
  [String.prototype, STRING_PROTOTYPE],
  [Number.prototype, NUMBER_PROTOTYPE],
  [Boolean.prototype, BOOLEAN_PROTOTYPE],
];

/** Members an engine newer than the table's edition may add; none today. */
const ENGINE_ONLY: ReadonlySet<string> = new Set();

test("the prototype table holds exactly the string-keyed members the engine's intrinsics have, each of the kind it states", () => {
  for (const [intrinsic, table] of PROTOTYPES) {
    const engine = Object.getOwnPropertyNames(intrinsic).filter((name) => !ENGINE_ONLY.has(name));
    assert.deepEqual([...table.keys()].sort(), engine.sort());
    for (const [name, kind] of table) {
      const descriptor = Object.getOwnPropertyDescriptor(intrinsic, name)!;
      const engineKind = descriptor.get !== undefined ? "object" : typeof descriptor.value;
      assert.equal(kind, engineKind, name);
    }
  }
});

test("the wire drops undefined, writes a non-finite number as null and keeps every other primitive", () => {
  assert.equal(wireOf(undefined), undefined);
  assert.equal(wireOf(Number.NaN), null);
  assert.equal(wireOf(-Infinity), null);
  assert.deepEqual([wireOf(0), wireOf(""), wireOf(false), wireOf(null)], [0, "", false, null]);
});

test("?? keeps a left side that is not nullish, even 0 or an empty string, and || keeps only a truthy one", () => {
  assert.deepEqual([0, "", false, null, undefined, "a"].map((value) => keepsLeft("??", value)), [true, true, true, false, false, true]);
  assert.deepEqual([0, "", false, null, undefined, "a", Number.NaN].map((value) => keepsLeft("||", value)), [false, false, false, false, false, true, false]);
});
