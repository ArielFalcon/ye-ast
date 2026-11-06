import assert from "node:assert/strict";
import test from "node:test";
import { parseAccessPath } from "./access-path.ts";
import type { Change } from "./change.ts";
import type { Predicate, Replacement } from "./use-operation.ts";
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
