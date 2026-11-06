import assert from "node:assert/strict";
import test from "node:test";
import { parseAccessPath } from "./access-path.ts";
import { parseChange, type Change, type ChangeInput, type ValueClass } from "./change.ts";
import type { AccessStep, JsonValue, Literal, Predicate, Replacement, UseEnd } from "./use-operation.ts";
import { decideUse, type FallbackGuard, type Guard, type TestedGuard, type UntestedGuard, type UseOperation, type UseSite } from "./verdict.ts";

const path = (text: string) => parseAccessPath(text)!;

const NULLABLE: Change = { entries: ["nullable"], introduced: ["null"], alwaysAbsent: false };
const REMOVED: Change = { entries: ["removed"], introduced: ["undefined"], alwaysAbsent: true };
const NULLABLE_AND_OPTIONAL: Change = { entries: ["nullable", "optional"], introduced: ["null", "undefined"], alwaysAbsent: false };
const AS_STRING: Change = { entries: [{ type: "string" }], introduced: ["string"], alwaysAbsent: false };
const AS_OBJECT: Change = { entries: [{ type: "object" }], introduced: ["object"], alwaysAbsent: false };

const NOT_ABSENT: Predicate = { kind: "absence", operator: "!=", absence: "null" };
const NOT_NULL: Predicate = { kind: "absence", operator: "!==", absence: "null" };
const NOT_UNDEFINED: Predicate = { kind: "absence", operator: "!==", absence: "undefined" };

function guard(test: Predicate = NOT_ABSENT, overrides: Partial<TestedGuard> = {}): TestedGuard {
  return { kind: "condition", covers: path("address"), test, holds: true, evidence: { path: "src/a.ts", line: 9 }, ...overrides };
}

function fallback(test: Predicate, replacement: Replacement, overrides: Partial<FallbackGuard> = {}): FallbackGuard {
  return { kind: "fallback", covers: path("address"), test, holds: true, replacement, evidence: { path: "src/a.ts", line: 12 }, ...overrides };
}

const untested = (kind: UntestedGuard["kind"]): UntestedGuard => ({ kind, covers: path("address"), evidence: { path: "src/a.ts", line: 9 } });

const CITY = { kind: "member", name: "city", optional: false } as const;
const READ_CITY: UseOperation = { steps: [CITY], end: { kind: "none" } };
const SHOWN: UseOperation = { steps: [], end: { kind: "consume", as: "shown" } };

function use(overrides: Partial<UseSite> = {}): UseSite {
  return { path: path("address.city"), changed: path("address"), operation: READ_CITY, guards: [], ...overrides };
}

test("an unguarded read inside a value the contract now lets be null is incompatible: null fails the member read, which needs a value to read from", () => {
  assert.deepEqual(decideUse(use(), NULLABLE), { kind: "incompatible", witness: "null", at: 0, failing: CITY, capability: "readable" });
});

test("the same read of a removed property is incompatible with undefined as the witness", () => {
  assert.deepEqual(decideUse(use(), REMOVED), { kind: "incompatible", witness: "undefined", at: 0, failing: CITY, capability: "readable" });
});

test("a sufficient guard makes the read admit the change and names the guard", () => {
  const sufficient = guard(NOT_ABSENT, { kind: "optional-chain" });
  assert.deepEqual(decideUse(use({ guards: [sufficient] }), NULLABLE), { kind: "admits", guards: [sufficient] });
});

test("a non-null assertion is never a guard", () => {
  const verdict = decideUse(use({ guards: [untested("non-null-assertion")] }), NULLABLE);
  assert.equal(verdict?.kind, "incompatible");
});

test("a guard covers only the segments it tests: a parent guard does not protect the changed segment", () => {
  const parentOnly = guard(NOT_ABSENT, { kind: "optional-chain", covers: path("") });
  assert.equal(decideUse(use({ guards: [parentOnly] }), NULLABLE)?.kind, "incompatible");
  const deeper = guard(NOT_ABSENT, { covers: path("address.city") });
  assert.equal(decideUse(use({ guards: [deeper] }), NULLABLE)?.kind, "admits");
});

test("an optional chain protects only the segment it sits at: one deeper in the path leaves the earlier dereference unguarded", () => {
  const deeperChain = guard(NOT_ABSENT, { kind: "optional-chain", covers: path("address.city") });
  assert.equal(decideUse(use({ path: path("address.city.name"), guards: [deeperChain] }), NULLABLE)?.kind, "incompatible");
  const atChanged = guard(NOT_ABSENT, { kind: "optional-chain", covers: path("address") });
  assert.equal(decideUse(use({ path: path("address.city.name"), guards: [atChanged] }), NULLABLE)?.kind, "admits");
});

test("a test of a deeper path still handles a value whose own read of that path throws", () => {
  const deeperTest = guard({ kind: "truthy" }, { covers: path("address.city") });
  assert.equal(decideUse(use({ path: path("address.city.name"), guards: [deeperTest] }), NULLABLE)?.kind, "admits");
});

test("a guard's test is evaluated on the value: one that lets the introduced value through does not protect", () => {
  assert.equal(decideUse(use({ guards: [guard(NOT_UNDEFINED)] }), NULLABLE)?.kind, "incompatible");
  assert.equal(decideUse(use({ guards: [guard(NOT_NULL)] }), REMOVED)?.kind, "incompatible");
});

test("a removed property behind a guard is for review", () => {
  assert.deepEqual(decideUse(use({ guards: [guard()] }), REMOVED), { kind: "review", reason: "removed-behind-guard" });
});

test("a guard outside the vocabulary leaves a failing read for review, a recognized guard wins over it, and a use that runs stays consumed", () => {
  const opaque = untested("type-guard");
  assert.deepEqual(decideUse(use({ guards: [opaque] }), NULLABLE), { kind: "review", reason: "opaque-guard" });
  const sufficient = guard();
  assert.equal(decideUse(use({ guards: [opaque, sufficient] }), NULLABLE)?.kind, "admits");
  assert.deepEqual(decideUse(use({ path: path("address"), operation: SHOWN, guards: [opaque] }), NULLABLE), { kind: "review", reason: "consumed" });
});

test("a test the module cannot decide on the value acts like a guard outside the vocabulary", () => {
  const undecidable = guard({ kind: "truthy" }, { covers: path("address.city") });
  const callName: UseOperation = { steps: [{ kind: "member", name: "name", optional: false }, { kind: "call", optional: false }], end: { kind: "none" } };
  const site = use({ path: path("address.name"), operation: callName });
  assert.equal(decideUse(site, AS_OBJECT)?.kind, "incompatible");
  assert.deepEqual(decideUse({ ...site, guards: [undecidable] }, AS_OBJECT), { kind: "review", reason: "opaque-guard" });
});

test("operating on the changed value itself is incompatible only when the operation dereferences it", () => {
  const exact = (operation: UseOperation) => decideUse(use({ path: path("address"), changed: path("address"), operation }), NULLABLE);
  assert.equal(exact({ steps: [{ kind: "member", name: "trim", optional: false }, { kind: "call", optional: false }], end: { kind: "none" } })?.kind, "incompatible");
  assert.equal(exact({ steps: [], end: { kind: "iterate", tolerates: [] } })?.kind, "incompatible");
  assert.deepEqual(exact({ steps: [], end: { kind: "iterate", tolerates: ["null", "undefined"] } }), { kind: "review", reason: "consumed" });
  assert.deepEqual(exact({ steps: [], end: { kind: "coerce", operator: "-" } }), { kind: "review", reason: "consumed" });
  assert.deepEqual(exact({ steps: [], end: { kind: "unmodelled", detail: "call:format" } }), { kind: "review", reason: "unmodelled-sink" });
});

test("a read that does not reach into the changed value is no use of it", () => {
  assert.equal(decideUse(use({ path: path("name") }), NULLABLE), undefined);
  assert.equal(decideUse(use({ path: path("") }), NULLABLE), undefined);
});

test("the incompatible verdict names the first step or the end that throws on the witness, its index, and the capability the value lacks there", () => {
  const failure = (operation: UseOperation) => {
    const verdict = decideUse(use({ path: path("address"), operation }), NULLABLE);
    return verdict?.kind === "incompatible" ? { at: verdict.at, failing: verdict.failing, capability: verdict.capability } : verdict;
  };
  const trim = { kind: "member", name: "trim", optional: false } as const;
  const keyed = { kind: "keyed", key: 0, optional: false } as const;
  const call = { kind: "call", optional: false } as const;
  assert.deepEqual(failure({ steps: [trim, call], end: { kind: "none" } }), { at: 0, failing: trim, capability: "readable" });
  assert.deepEqual(failure({ steps: [keyed], end: { kind: "none" } }), { at: 0, failing: keyed, capability: "readable" });
  assert.deepEqual(failure({ steps: [call], end: { kind: "none" } }), { at: 0, failing: call, capability: "function" });
  assert.deepEqual(failure({ steps: [], end: { kind: "iterate", tolerates: [] } }), { at: 0, failing: { kind: "iterate", tolerates: [] }, capability: "iterable" });
  assert.deepEqual(failure({ steps: [], end: { kind: "destructure", shape: "object" } }), { at: 0, failing: { kind: "destructure", shape: "object" }, capability: "readable" });
  assert.deepEqual(failure({ steps: [], end: { kind: "destructure", shape: "array" } }), { at: 0, failing: { kind: "destructure", shape: "array" }, capability: "iterable" });
  assert.deepEqual(failure({ steps: [], end: { kind: "none" } }), { at: 0, failing: { kind: "none" }, capability: "readable" });
  const missing = { kind: "member", name: "missing", optional: false } as const;
  const iterate = { kind: "iterate", tolerates: [] } as const;
  const lateEnd = decideUse(use({ path: path("address"), operation: { steps: [missing], end: iterate } }), AS_STRING);
  assert.deepEqual(lateEnd, { kind: "incompatible", witness: '""', at: 1, failing: iterate, capability: "iterable" });
});

test("an iteration runs on the absences it tolerates and throws on the others", () => {
  const iterate: UseOperation = { steps: [], end: { kind: "iterate", tolerates: ["null"] } };
  const over = (change: Change) => decideUse(use({ path: path("address"), operation: iterate }), change);
  assert.deepEqual(over(NULLABLE), { kind: "review", reason: "consumed" });
  assert.deepEqual(over(NULLABLE_AND_OPTIONAL), { kind: "incompatible", witness: "undefined", at: 0, failing: iterate.end, capability: "iterable" });
});

test("a combined change is admitted only when every value it introduces is kept from the use, and the first value that throws is the witness", () => {
  assert.deepEqual(decideUse(use(), NULLABLE_AND_OPTIONAL), { kind: "incompatible", witness: "null", at: 0, failing: CITY, capability: "readable" });
  const nullTest = guard(NOT_NULL);
  assert.deepEqual(decideUse(use({ guards: [nullTest] }), NULLABLE_AND_OPTIONAL), { kind: "incompatible", witness: "undefined", at: 0, failing: CITY, capability: "readable" });
  const undefinedTest = guard(NOT_UNDEFINED, { evidence: { path: "src/a.ts", line: 10 } });
  assert.deepEqual(decideUse(use({ guards: [nullTest, undefinedTest] }), NULLABLE_AND_OPTIONAL), { kind: "admits", guards: [nullTest, undefinedTest] });
  assert.deepEqual(decideUse(use({ guards: [guard()] }), NULLABLE_AND_OPTIONAL), { kind: "admits", guards: [guard()] });
});

test("a value a guard keeps from the use never reaches it: shown, compared or coerced behind a sufficient guard admits the change", () => {
  const behind = (operation: UseOperation, change: Change, guards = [guard()]) => decideUse(use({ path: path("address"), operation, guards }), change);
  assert.deepEqual(behind(SHOWN, NULLABLE), { kind: "admits", guards: [guard()] });
  assert.equal(behind({ steps: [], end: { kind: "compare", operator: ">", literal: 0 } }, NULLABLE_AND_OPTIONAL)?.kind, "admits");
  assert.equal(behind({ steps: [], end: { kind: "coerce", operator: "+" } }, NULLABLE)?.kind, "admits");
  assert.deepEqual(behind(SHOWN, REMOVED), { kind: "review", reason: "removed-behind-guard" });
  assert.deepEqual(behind(SHOWN, NULLABLE_AND_OPTIONAL, [guard(NOT_NULL)]), { kind: "review", reason: "consumed" });
});

test("every representative of a class is decided: the witness is the first value written as a literal, and a value no step of the use can read is for review", () => {
  const trimCall: UseOperation = { steps: [{ kind: "member", name: "trim", optional: false }, { kind: "call", optional: false }], end: { kind: "none" } };
  const toFixedCall: UseOperation = { steps: [{ kind: "member", name: "toFixed", optional: false }, { kind: "call", optional: false }], end: { kind: "none" } };
  const on = (operation: UseOperation, change: Change) => decideUse(use({ path: path("address"), operation }), change);
  assert.deepEqual(on(toFixedCall, AS_STRING), { kind: "incompatible", witness: '""', at: 1, failing: toFixedCall.steps[1], capability: "function" });
  assert.deepEqual(on(trimCall, AS_STRING), { kind: "review", reason: "unknown-value" });
  const nameThenName: UseOperation = { steps: [{ kind: "member", name: "name", optional: false }, { kind: "member", name: "first", optional: false }], end: { kind: "none" } };
  assert.deepEqual(on(nameThenName, AS_OBJECT), { kind: "review", reason: "unknown-value" });
});

test("a guard naming finitely many literals cannot protect a whole class: the literals it names and a fresh value differing from them are all represented", () => {
  const onAddress = (guards: readonly Guard[], change: Change) => decideUse(use({ path: path("address"), operation: SHOWN, guards }), change);
  const isA = guard({ kind: "literal", operator: "===", literal: "a" });
  assert.deepEqual(onAddress([isA], AS_STRING), { kind: "review", reason: "consumed" });
  const notOne = guard({ kind: "literal", operator: "!==", literal: 1 });
  const notZero = guard({ kind: "literal", operator: "!==", literal: 0 });
  assert.deepEqual(onAddress([notOne, notZero], { entries: [{ type: "number" }], introduced: ["number"], alwaysAbsent: false }), { kind: "review", reason: "consumed" });
});

test("a fallback replaces the values its test rejects: a replacement the use runs on is handled by the fallback, one it fails on is incompatible and named", () => {
  const trimCall: UseOperation = { steps: [{ kind: "member", name: "trim", optional: false }, { kind: "call", optional: false }], end: { kind: "none" } };
  const toEmpty = fallback(NOT_ABSENT, { kind: "literal", value: "" });
  const onAddress = (operation: UseOperation, guards: readonly Guard[]) => decideUse(use({ path: path("address"), operation, guards }), NULLABLE);
  assert.deepEqual(onAddress({ steps: [{ kind: "member", name: "length", optional: false }], end: { kind: "none" } }, [toEmpty]), { kind: "admits", guards: [toEmpty] });
  const toZero = fallback(NOT_ABSENT, { kind: "literal", value: 0 });
  assert.deepEqual(onAddress(trimCall, [toZero]), { kind: "incompatible", witness: "null", at: 1, failing: trimCall.steps[1], capability: "function", replacement: 0 });
});

test("an opaque replacement goes on as an unknown value: an end that runs on every value runs, anything else is unknown", () => {
  const opaque = fallback(NOT_ABSENT, { kind: "opaque" });
  const onAddress = (operation: UseOperation) => decideUse(use({ path: path("address"), operation, guards: [opaque] }), NULLABLE);
  assert.deepEqual(onAddress(SHOWN), { kind: "admits", guards: [opaque] });
  assert.deepEqual(onAddress({ steps: [{ kind: "member", name: "name", optional: false }], end: { kind: "none" } }), { kind: "review", reason: "opaque-replacement" });
  assert.deepEqual(onAddress({ steps: [], end: { kind: "unmodelled", detail: "x" } }), { kind: "review", reason: "unmodelled-sink" });
});

test("guards apply in the order the value passes them: a later guard tests the value an earlier fallback put in place", () => {
  const toText = fallback(NOT_ABSENT, { kind: "literal", value: "x" });
  const isText = guard({ kind: "typeof", operator: "===", type: "string" });
  const length: UseOperation = { steps: [{ kind: "member", name: "length", optional: false }], end: { kind: "none" } };
  const onAddress = (guards: readonly Guard[]) => decideUse(use({ path: path("address"), operation: length, guards }), NULLABLE);
  assert.deepEqual(onAddress([toText, isText]), { kind: "admits", guards: [toText] });
  assert.deepEqual(onAddress([isText, toText]), { kind: "admits", guards: [isText] });
});

test("a fallback and a test are decided the same way on a path deeper than the changed value: a read that throws is handled, a replacement there is not followed", () => {
  const deeper = fallback({ kind: "truthy" }, { kind: "literal", value: [] }, { covers: path("address.city") });
  const names: UseOperation = { steps: [CITY, { kind: "member", name: "name", optional: false }], end: { kind: "none" } };
  const site = (change: Change) => decideUse(use({ path: path("address.city.name"), operation: names, guards: [deeper] }), change);
  assert.deepEqual(site(NULLABLE), { kind: "admits", guards: [deeper] });
  assert.deepEqual(site(AS_STRING), { kind: "review", reason: "opaque-guard" });
});

function changeOf(input: ChangeInput): Change {
  const parsed = parseChange(input, path("address"));
  assert.ok(parsed.ok);
  return parsed.value;
}

const ADD_A = changeOf({ values: { added: ["A"] } });
const RETIRE_OLD = changeOf({ values: { removed: ["OLD"] } });
const compareWith = (operator: string, literal: string): UseOperation => ({ steps: [], end: { kind: "compare", operator, literal } });
const onChanged = (operation: UseOperation, change: Change, guards: readonly Guard[] = []) => decideUse(use({ path: path("address"), operation, guards }), change);

test("an added literal is walked as itself, exactly: its own characters are known, which a representative of its class does not give", () => {
  const pastItsEnd: UseOperation = { steps: [{ kind: "keyed", key: 5, optional: false }, { kind: "member", name: "length", optional: false }], end: { kind: "none" } };
  assert.deepEqual(onChanged(pastItsEnd, ADD_A), { kind: "incompatible", witness: '"A"', at: 1, failing: pastItsEnd.steps[1], capability: "readable" });
  assert.deepEqual(onChanged(pastItsEnd, changeOf([{ type: "string" }, { values: { removed: [""] } }])), { kind: "review", reason: "unknown-value" });
  assert.equal(onChanged(pastItsEnd, AS_STRING)?.kind, "incompatible");
});

test("a value the change retires is never walked, and no fresh value equals a literal the change names", () => {
  const readable = guard({ kind: "truthy" }, { holds: true });
  const missing: UseOperation = { steps: [{ kind: "member", name: "missing", optional: false }, { kind: "member", name: "city", optional: false }], end: { kind: "none" } };
  const witness = (change: Change) => (onChanged(missing, change, [readable]) as { witness?: string }).witness;
  assert.equal(witness(AS_STRING), '"a"');
  assert.equal(witness(changeOf([{ type: "string" }, { values: { removed: ["a"] } }])), '"aa"');
  const onlyOld = guard({ kind: "literal", operator: "===", literal: "OLD" });
  const retiredString = changeOf([{ type: "string" }, { values: { removed: ["OLD"] } }]);
  assert.deepEqual(onChanged(missing, retiredString, [onlyOld]), { kind: "review", reason: "retired-literal" });
});

test("a use that compares the value strictly with a retired literal written directly is to be reviewed", () => {
  assert.deepEqual(onChanged(compareWith("===", "OLD"), RETIRE_OLD), { kind: "review", reason: "retired-literal" });
  assert.deepEqual(onChanged(compareWith("!==", "OLD"), RETIRE_OLD), { kind: "review", reason: "retired-literal" });
  assert.notDeepEqual(onChanged(compareWith("==", "OLD"), RETIRE_OLD), { kind: "review", reason: "retired-literal" });
  assert.notDeepEqual(onChanged(compareWith("===", "OTHER"), RETIRE_OLD), { kind: "review", reason: "retired-literal" });
});

test("a use behind a strict equality with a retired literal that must hold for it to run is to be reviewed", () => {
  const equals = (operator: "===" | "!==", holds: boolean, literal = "OLD") => guard({ kind: "literal", operator, literal }, { holds });
  assert.deepEqual(onChanged(SHOWN, RETIRE_OLD, [equals("===", true)]), { kind: "review", reason: "retired-literal" });
  assert.deepEqual(onChanged(SHOWN, RETIRE_OLD, [equals("!==", false)]), { kind: "review", reason: "retired-literal" });
  assert.deepEqual(onChanged(SHOWN, RETIRE_OLD, [equals("===", false)]), { kind: "silent" });
  assert.deepEqual(onChanged(SHOWN, RETIRE_OLD, [equals("===", true, "OTHER")]), { kind: "silent" });
  assert.deepEqual(onChanged(SHOWN, RETIRE_OLD, [guard({ kind: "literal", operator: "==", literal: "OLD" })]), { kind: "silent" });
  const deeper = guard({ kind: "literal", operator: "===", literal: "OLD" }, { covers: path("address.city") });
  assert.deepEqual(decideUse(use({ path: path("address.city"), operation: SHOWN, guards: [deeper] }), RETIRE_OLD), { kind: "silent" });
});

test("a meaning change makes every use it reaches a review, after a value that throws and before any other reason", () => {
  const meaning = changeOf({ meaning: "euros become cents" });
  assert.deepEqual(onChanged(SHOWN, meaning), { kind: "review", reason: "meaning" });
  assert.deepEqual(onChanged(compareWith("===", "OLD"), meaning), { kind: "review", reason: "meaning" });
  assert.deepEqual(onChanged(SHOWN, changeOf(["optional", { meaning: "x" }]), [guard({ kind: "truthy" })]), { kind: "review", reason: "meaning" });
  assert.equal(decideUse(use({ path: path("address.city") }), changeOf(["nullable", { meaning: "x" }]))?.kind, "incompatible");
  assert.equal(decideUse(use({ path: path("address.city"), changed: path("address.city.name") }), meaning), undefined);
});

test("under a values change a use that only shows the value, or compares it strictly with a literal the change does not name, is silent", () => {
  assert.deepEqual(onChanged(SHOWN, ADD_A), { kind: "silent" });
  assert.deepEqual(onChanged(compareWith("===", "B"), ADD_A), { kind: "silent" });
  assert.deepEqual(onChanged(compareWith("!==", "B"), ADD_A), { kind: "silent" });
  assert.deepEqual(onChanged(compareWith("===", "A"), ADD_A), { kind: "review", reason: "consumed" });
  assert.deepEqual(onChanged(compareWith("==", "B"), ADD_A), { kind: "review", reason: "consumed" });
  assert.deepEqual(onChanged({ steps: [], end: { kind: "coerce", operator: "+" } }, ADD_A), { kind: "review", reason: "consumed" });
  assert.deepEqual(onChanged(SHOWN, changeOf({ type: "string" })), { kind: "review", reason: "consumed" });
});

test("a use under a values change keeps its finding when null or undefined also run, when a value throws or when a value cannot be told", () => {
  assert.deepEqual(onChanged(SHOWN, changeOf(["nullable", { values: { added: ["A"] } }])), { kind: "review", reason: "consumed" });
  assert.deepEqual(onChanged(SHOWN, changeOf(["optional", { values: { added: ["A"] } }])), { kind: "review", reason: "consumed" });
  assert.equal(decideUse(use(), changeOf(["nullable", { values: { added: ["A"] } }]))?.kind, "incompatible");
  const unmodelled: UseOperation = { steps: [], end: { kind: "unmodelled", detail: "x" } };
  assert.deepEqual(onChanged(unmodelled, ADD_A), { kind: "review", reason: "unmodelled-sink" });
});

test("a switch case whose labels are not literals is an opaque guard: it handles nothing and only turns a throwing use into a review", () => {
  assert.deepEqual(decideUse(use({ guards: [untested("case")] }), NULLABLE), { kind: "review", reason: "opaque-guard" });
});

test("the literals a one-of guard names are named by the use: no fresh value equals one", () => {
  const missing: UseOperation = { steps: [{ kind: "member", name: "missing", optional: false }, { kind: "member", name: "city", optional: false }], end: { kind: "none" } };
  const readable = guard({ kind: "truthy" });
  const notA = guard({ kind: "one-of", literals: ["a"], absences: [] }, { holds: false });
  assert.equal((onChanged(missing, AS_STRING, [readable, notA]) as { witness?: string }).witness, '"aa"');
});

test("a use that runs only where a one-of naming a retired literal holds is to be reviewed, and a one-of not required to hold or naming no retired literal is not", () => {
  const oneOf = (literals: readonly string[], holds: boolean) => guard({ kind: "one-of", literals, absences: [] }, { holds });
  assert.deepEqual(onChanged(SHOWN, RETIRE_OLD, [oneOf(["NEW", "OLD"], true)]), { kind: "review", reason: "retired-literal" });
  assert.deepEqual(onChanged(SHOWN, RETIRE_OLD, [oneOf(["NEW", "OLD"], false)]), { kind: "silent" });
  assert.deepEqual(onChanged(SHOWN, RETIRE_OLD, [oneOf(["NEW"], true)]), { kind: "silent" });
});

const member = (name: string): AccessStep => ({ kind: "member", name, optional: false });
const CALL: AccessStep = { kind: "call", optional: false };
const calling = (name: string): UseOperation => ({ steps: [member(name), CALL], end: { kind: "none" } });

test("a length is exact on an exact value and any number on a class, so a test of it never admits nor names a witness for a class", () => {
  const lengthIs = (test: Predicate, holds = true) => guard(test, { covers: path("address.length"), holds });
  const zero: Predicate = { kind: "literal", operator: "===", literal: 0 };
  const array = changeOf({ type: "array" });
  assert.deepEqual(onChanged(calling("toFixed"), array, [lengthIs(zero)]), { kind: "review", reason: "opaque-guard" });
  assert.deepEqual(onChanged(calling("toFixed"), array, [lengthIs({ kind: "truthy" })]), { kind: "review", reason: "opaque-guard" });
  const emptyString = changeOf({ values: { added: [""] } });
  assert.deepEqual(onChanged(calling("toFixed"), emptyString, [lengthIs(zero)]), { kind: "incompatible", witness: '""', at: 1, failing: CALL, capability: "function" });
  assert.equal(onChanged(calling("toFixed"), emptyString, [lengthIs({ kind: "truthy" })])?.kind, "admits");
});

test("a loose equality between a class and a literal of another type is not decided on the representatives: another value of the class may be equal", () => {
  const loose = (operator: "==" | "!=", literal: number) => guard({ kind: "literal", operator, literal });
  assert.deepEqual(onChanged(calling("toFixed"), AS_STRING, [loose("==", 1)]), { kind: "review", reason: "opaque-guard" });
  assert.deepEqual(onChanged(calling("toFixed"), changeOf({ type: "array" }), [loose("!=", 0)]), { kind: "review", reason: "opaque-guard" });
});

test("a member Object.prototype holds may be an own value of an open object: a test of it handles nothing", () => {
  const isString = guard({ kind: "typeof", operator: "===", type: "string" }, { covers: path("address.toString") });
  assert.deepEqual(onChanged(calling("toString"), AS_OBJECT, [isString]), { kind: "review", reason: "unknown-value" });
});

test("a literal the change retires is no value of the class: it is never a witness, and a guard that rejects every other value admits", () => {
  const falsy = guard({ kind: "truthy" }, { holds: false });
  const chain: UseOperation = { steps: [member("missing"), member("y")], end: { kind: "none" } };
  assert.equal(onChanged(calling("toFixed"), changeOf([{ type: "string" }, { values: { removed: [""] } }]), [falsy])?.kind, "admits");
  assert.equal(onChanged(calling("missing"), changeOf([{ type: "number" }, { values: { removed: [0] } }]), [falsy])?.kind, "admits");
  assert.equal(onChanged(chain, changeOf([{ type: "boolean" }, { values: { removed: [false] } }]), [falsy])?.kind, "admits");
});

test("a fallback to an object whose own keys may shadow the conversion members does not hand the coercion to the fallback", () => {
  const coerce: UseOperation = { steps: [], end: { kind: "coerce", operator: "+" } };
  const to = (value: JsonValue) => [fallback(NOT_ABSENT, { kind: "literal", value })];
  assert.deepEqual(onChanged(coerce, NULLABLE, to({ valueOf: null, toString: null })), { kind: "review", reason: "unknown-value" });
  assert.equal(onChanged(coerce, NULLABLE, to({}))?.kind, "admits");
  assert.equal(onChanged(coerce, NULLABLE, to(0))?.kind, "admits");
});

test("a loose comparison of an exact object or array goes through the conversion rule: when it may not succeed the test is undecided, never an exception", () => {
  const missing: UseOperation = { steps: [member("missing"), CALL], end: { kind: "none" } };
  const loose = (operator: "==" | "!=", literal: Literal) => guard({ kind: "literal", operator, literal });
  const to = (value: JsonValue) => fallback(NOT_ABSENT, { kind: "literal", value });
  const shadowed = { valueOf: null, toString: null };
  assert.deepEqual(onChanged(missing, NULLABLE, [to(shadowed), loose("==", 1)]), { kind: "review", reason: "opaque-guard" });
  assert.deepEqual(onChanged(missing, NULLABLE, [to([{ toString: null }]), loose("!=", 0)]), { kind: "review", reason: "opaque-guard" });
  assert.equal(onChanged(missing, NULLABLE, [to({}), loose("==", 1)])?.kind, "admits");
  assert.equal(onChanged(missing, NULLABLE, [to([1]), loose("==", 1)])?.kind, "incompatible");
});

test("the end of a use that reads below the changed value is applied to the value its steps reach, so a fallback is handed that operator too", () => {
  const through = (end: UseEnd): UseOperation => ({ steps: [member("a")], end });
  const to = (value: JsonValue) => [fallback(NOT_ABSENT, { kind: "literal", value })];
  const plus: UseEnd = { kind: "coerce", operator: "+" };
  assert.deepEqual(onChanged(through(plus), NULLABLE, to({ a: { valueOf: null, toString: null } })), { kind: "review", reason: "unknown-value" });
  assert.equal(onChanged(through(plus), NULLABLE, to({ a: 0 }))?.kind, "admits");
  assert.deepEqual(onChanged(through({ kind: "unmodelled", detail: "in" }), NULLABLE, to({ a: 0 })), { kind: "review", reason: "unmodelled-sink" });
  assert.equal(onChanged(through({ kind: "iterate", tolerates: [] }), NULLABLE, to({ a: 0 }))?.kind, "incompatible");
});

/** Source text of the values a class holds, to run on the engine: more than the module's representatives, and none of them chosen by it. */
const BATTERY: Readonly<Record<ValueClass, readonly string[]>> = {
  null: ["null"],
  undefined: ["undefined"],
  boolean: ["false", "true"],
  number: ["0", "1", "2", "-1", "1.5"],
  string: ['""', '"a"', '"1"', '"0"', '"aa"', '"x"', '"true"'],
  array: ["[]", "[0]", "[1]", '[""]', '["a"]', "[[]]", "[null]", '[{"toString":null}]'],
  object: ["{}", '{"toString":"hello"}', '{"length":0}', '{"length":1}', '{"a":1}', '{"valueOf":null,"toString":null}', '{"toString":null}', '{"constructor":1}'],
};

function conditionOf(test: Predicate, value: string): string {
  switch (test.kind) {
    case "truthy":
      return `Boolean(${value})`;
    case "absence":
      return `${value} ${test.operator} ${test.absence}`;
    case "literal":
      return `${value} ${test.operator} ${JSON.stringify(test.literal)}`;
    case "typeof":
      return `typeof ${value} ${test.operator} ${JSON.stringify(test.type)}`;
    case "array":
      return `Array.isArray(${value})`;
    case "one-of":
      return [...test.literals.map((literal) => `${value} === ${JSON.stringify(literal)}`), ...test.absences.map((absence) => `${value} === ${absence}`), "false"].join(" || ");
  }
}

const stepSource = (step: AccessStep): string => {
  const optional = step.optional ? "?." : "";
  return step.kind === "member" ? `${optional || "."}${step.name}` : step.kind === "keyed" ? `${optional}[${JSON.stringify(step.key)}]` : `${optional}()`;
};

function endSource(end: UseEnd, value: string): string {
  switch (end.kind) {
    case "none":
      return `${value};`;
    case "iterate":
      return `for (const item of ${value}) {}`;
    case "destructure":
      return end.shape === "array" ? `const [] = ${value};` : `const {} = ${value};`;
    case "compare":
      return `${value} ${end.operator} ${JSON.stringify(end.literal)};`;
    case "coerce":
      return `${end.operator}${value};`;
    default:
      throw new Error(end.kind);
  }
}

type Replay = (value: unknown) => "skipped" | "ran" | "threw-in-guard" | "threw-in-use";

/** The use as the code runs it for one value: the guards in order, then the steps and the end; says where it threw. */
function replayer({ operation, guards, changed }: UseSite): Replay {
  const lines = ["let phase = 'guard';", "try {"];
  for (const held of guards) {
    if (!("test" in held)) throw new Error(held.kind);
    const condition = conditionOf(held.test, ["v", ...held.covers.slice(changed.length)].join("."));
    const replacement = held.kind === "fallback" && held.replacement.kind === "literal" ? JSON.stringify(held.replacement.value) : "";
    lines.push(held.kind === "fallback" ? `if ((${condition}) !== ${held.holds}) v = ${replacement};` : `if ((${condition}) !== ${held.holds}) return "skipped";`);
  }
  lines.push("phase = 'use';", endSource(operation.end, `v${operation.steps.map(stepSource).join("")}`), "return 'ran';", "} catch { return phase === 'use' ? 'threw-in-use' : 'threw-in-guard'; }");
  return new Function("v", lines.join("\n")) as Replay;
}

test("against the running engine, every witness a verdict names throws in the use and every value of the introduced classes runs where it admits", () => {
  const changes = [
    NULLABLE,
    NULLABLE_AND_OPTIONAL,
    AS_STRING,
    AS_OBJECT,
    changeOf({ type: "array" }),
    changeOf({ type: "number" }),
    changeOf({ type: "boolean" }),
    changeOf([{ type: "string" }, { values: { removed: [""] } }]),
    changeOf([{ type: "number" }, { values: { removed: [0] } }]),
    changeOf([{ type: "boolean" }, { values: { removed: [false] } }]),
    changeOf({ values: { added: [""] } }),
    changeOf([{ type: "string" }, { values: { added: ["x"], removed: ["a"] } }]),
    changeOf(["nullable", { type: "array" }]),
  ];
  const equality = ["===", "!==", "==", "!="] as const;
  const tested: { test: Predicate; reads: readonly string[] }[] = [
    { test: { kind: "truthy" }, reads: ["", "length"] },
    ...(["null", "undefined"] as const).flatMap((absence) => equality.map((operator) => ({ test: { kind: "absence", operator, absence } satisfies Predicate, reads: [""] }))),
    ...([0, 1, "", "a", "1", true] satisfies Literal[]).flatMap((literal) => equality.map((operator) => ({ test: { kind: "literal", operator, literal } satisfies Predicate, reads: ["", "length"] }))),
    ...["string", "number", "object", "function"].map((type) => ({ test: { kind: "typeof", operator: "===", type } satisfies Predicate, reads: ["", "length", "toString"] })),
    { test: { kind: "array" }, reads: [""] },
    { test: { kind: "one-of", literals: [0, "a"], absences: [] }, reads: [""] },
    { test: { kind: "one-of", literals: [], absences: ["null"] }, reads: [""] },
  ];
  const guardSets: Guard[][] = [[]];
  for (const { test, reads } of tested) {
    for (const read of reads) {
      for (const holds of [true, false]) guardSets.push([guard(test, { holds, covers: path(read === "" ? "address" : `address.${read}`) })]);
    }
  }
  for (const test of [{ kind: "truthy" }, NOT_ABSENT] satisfies Predicate[]) {
    for (const value of [0, "", [], "x", {}, { valueOf: null, toString: null }, { a: 0 }, { a: [{ toString: null }] }, { a: { valueOf: null, toString: null } }] satisfies JsonValue[]) guardSets.push([fallback(test, { kind: "literal", value })]);
  }
  for (const value of [{}, { valueOf: null, toString: null }, [{ toString: null }], [1], "1"] satisfies JsonValue[]) {
    for (const { test } of tested.filter((candidate) => candidate.test.kind === "literal")) {
      for (const holds of [true, false]) guardSets.push([fallback(NOT_ABSENT, { kind: "literal", value }), guard(test, { holds })]);
    }
  }
  const operations: UseOperation[] = [
    calling("toFixed"),
    calling("toString"),
    calling("trim"),
    { steps: [member("length")], end: { kind: "none" } },
    { steps: [member("missing"), member("y")], end: { kind: "none" } },
    { steps: [], end: { kind: "iterate", tolerates: [] } },
    { steps: [], end: { kind: "destructure", shape: "array" } },
    { steps: [], end: { kind: "destructure", shape: "object" } },
    { steps: [], end: { kind: "coerce", operator: "+" } },
    { steps: [], end: { kind: "compare", operator: "==", literal: 1 } },
    { steps: [], end: { kind: "compare", operator: "<", literal: 1 } },
    { steps: [], end: { kind: "compare", operator: "===", literal: 1 } },
    { steps: [member("a")], end: { kind: "coerce", operator: "+" } },
    { steps: [member("a")], end: { kind: "compare", operator: "==", literal: 1 } },
    { steps: [member("a")], end: { kind: "iterate", tolerates: [] } },
  ];
  const claims = { incompatible: 0, admits: 0 };
  for (const change of changes) {
    const retired: readonly Literal[] = change.values?.removed ?? [];
    const sources = [...change.introduced.flatMap((valueClass) => BATTERY[valueClass]), ...(change.values?.added ?? []).map((literal) => JSON.stringify(literal))];
    const values = sources.map((source) => ({ source, value: new Function(`return (${source})`)() as unknown })).filter(({ value }) => !retired.some((literal) => literal === value));
    for (const guards of guardSets) {
      for (const operation of operations) {
        const site = use({ path: path("address"), operation, guards });
        const decision = decideUse(site, change);
        const where = () => `${JSON.stringify(change.entries)} ${JSON.stringify(guards.map((held) => ("test" in held ? [held.kind, held.covers.join("."), held.test, held.holds] : held.kind)))} ${JSON.stringify(operation)}`;
        if (decision?.kind === "incompatible") {
          claims.incompatible++;
          const witness = new Function(`return (${decision.witness})`)() as unknown;
          assert.ok(!retired.some((literal) => literal === witness), `${where()}: the witness ${decision.witness} is retired`);
          assert.equal(replayer(site)(witness), "threw-in-use", `${where()}: witness ${decision.witness}`);
        } else if (decision?.kind === "admits") {
          claims.admits++;
          const replay = replayer(site);
          for (const { source, value } of values) assert.notEqual(replay(value), "threw-in-use", `${where()}: admits, but ${source} throws`);
        }
      }
    }
  }
  assert.ok(claims.incompatible > 100 && claims.admits > 100, JSON.stringify(claims));
});
