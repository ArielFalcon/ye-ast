import assert from "node:assert/strict";
import test from "node:test";
import { parseAccessPath } from "./access-path.ts";
import type { Change } from "./change.ts";
import { decideUse, type Guard, type UseOperation, type UseSite } from "./verdict.ts";

const path = (text: string) => parseAccessPath(text)!;

const NULLABLE: Change = { entries: ["nullable"], introduced: ["null"], alwaysAbsent: false };
const REMOVED: Change = { entries: ["removed"], introduced: ["undefined"], alwaysAbsent: true };
const NULLABLE_AND_OPTIONAL: Change = { entries: ["nullable", "optional"], introduced: ["null", "undefined"], alwaysAbsent: false };

function guard(overrides: Partial<Guard> = {}): Guard {
  return { kind: "truthiness", covers: path("address"), excludes: ["null", "undefined"], evidence: { path: "src/a.ts", line: 9 }, ...overrides };
}

const CITY = { kind: "member", name: "city", optional: false } as const;
const READ_CITY: UseOperation = { steps: [CITY], end: { kind: "none" } };
const SHOWN: UseOperation = { steps: [], end: { kind: "consume", as: "shown" } };

function use(overrides: Partial<UseSite> = {}): UseSite {
  return { path: path("address.city"), changed: path("address"), operation: READ_CITY, guards: [], ...overrides };
}

test("an unguarded read inside a value the contract now lets be null is incompatible: null fails the member read, which needs a value to read from", () => {
  assert.deepEqual(decideUse(use(), NULLABLE), { kind: "incompatible", witness: "null", failing: CITY, capability: "readable" });
});

test("the same read of a removed property is incompatible with undefined as the witness", () => {
  assert.deepEqual(decideUse(use(), REMOVED), { kind: "incompatible", witness: "undefined", failing: CITY, capability: "readable" });
});

test("a sufficient guard makes the read admit the change and names the guard", () => {
  const sufficient = guard({ kind: "optional-chain", covers: path("address") });
  assert.deepEqual(decideUse(use({ guards: [sufficient] }), NULLABLE), { kind: "admits", guards: [sufficient] });
});

test("a non-null assertion is never a guard", () => {
  const verdict = decideUse(use({ guards: [guard({ kind: "non-null-assertion" })] }), NULLABLE);
  assert.equal(verdict?.kind, "incompatible");
});

test("a guard covers only the segments it tests: a parent guard does not protect the changed segment", () => {
  const parentOnly = guard({ kind: "optional-chain", covers: path("") });
  assert.equal(decideUse(use({ guards: [parentOnly] }), NULLABLE)?.kind, "incompatible");
  const deeper = guard({ covers: path("address.city") });
  assert.equal(decideUse(use({ guards: [deeper] }), NULLABLE)?.kind, "admits");
});

test("an optional chain protects only the segment it sits at: one deeper in the path leaves the earlier dereference unguarded", () => {
  const deeperChain = guard({ kind: "optional-chain", covers: path("address.city") });
  assert.equal(decideUse(use({ path: path("address.city.name"), guards: [deeperChain] }), NULLABLE)?.kind, "incompatible");
  const atChanged = guard({ kind: "optional-chain", covers: path("address") });
  assert.equal(decideUse(use({ path: path("address.city.name"), guards: [atChanged] }), NULLABLE)?.kind, "admits");
});

test("a test of a deeper path still establishes the prefix it dereferences", () => {
  const deeperTest = guard({ kind: "truthiness", covers: path("address.city") });
  assert.equal(decideUse(use({ path: path("address.city.name"), guards: [deeperTest] }), NULLABLE)?.kind, "admits");
});

test("a guard that excludes only what the change does not introduce does not protect", () => {
  assert.equal(decideUse(use({ guards: [guard({ excludes: ["undefined"] })] }), NULLABLE)?.kind, "incompatible");
  assert.equal(decideUse(use({ guards: [guard({ excludes: ["null"] })] }), REMOVED)?.kind, "incompatible");
});

test("a removed property behind a guard is for review", () => {
  assert.deepEqual(decideUse(use({ guards: [guard()] }), REMOVED), { kind: "review", reason: "removed-behind-guard" });
});

test("a guard outside the vocabulary leaves a failing read for review, a recognized guard wins over it, and a use that runs stays consumed", () => {
  const opaque = guard({ kind: "type-guard" });
  assert.deepEqual(decideUse(use({ guards: [opaque] }), NULLABLE), { kind: "review", reason: "opaque-guard" });
  const sufficient = guard();
  assert.equal(decideUse(use({ guards: [opaque, sufficient] }), NULLABLE)?.kind, "admits");
  assert.deepEqual(decideUse(use({ path: path("address"), operation: SHOWN, guards: [opaque] }), NULLABLE), { kind: "review", reason: "consumed" });
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

test("the incompatible verdict names the first step or the end that throws on the witness and the capability the value lacks there", () => {
  const failure = (operation: UseOperation) => {
    const verdict = decideUse(use({ path: path("address"), operation }), NULLABLE);
    return verdict?.kind === "incompatible" ? { failing: verdict.failing, capability: verdict.capability } : verdict;
  };
  const trim = { kind: "member", name: "trim", optional: false } as const;
  const keyed = { kind: "keyed", key: 0, optional: false } as const;
  const call = { kind: "call", optional: false } as const;
  assert.deepEqual(failure({ steps: [trim, call], end: { kind: "none" } }), { failing: trim, capability: "readable" });
  assert.deepEqual(failure({ steps: [keyed], end: { kind: "none" } }), { failing: keyed, capability: "readable" });
  assert.deepEqual(failure({ steps: [call], end: { kind: "none" } }), { failing: call, capability: "function" });
  assert.deepEqual(failure({ steps: [], end: { kind: "iterate", tolerates: [] } }), { failing: { kind: "iterate", tolerates: [] }, capability: "iterable" });
  assert.deepEqual(failure({ steps: [], end: { kind: "destructure", shape: "object" } }), { failing: { kind: "destructure", shape: "object" }, capability: "readable" });
  assert.deepEqual(failure({ steps: [], end: { kind: "destructure", shape: "array" } }), { failing: { kind: "destructure", shape: "array" }, capability: "iterable" });
  assert.deepEqual(failure({ steps: [], end: { kind: "none" } }), { failing: { kind: "none" }, capability: "readable" });
});

test("an iteration runs on the absences it tolerates and throws on the others", () => {
  const iterate: UseOperation = { steps: [], end: { kind: "iterate", tolerates: ["null"] } };
  const over = (change: Change) => decideUse(use({ path: path("address"), operation: iterate }), change);
  assert.deepEqual(over(NULLABLE), { kind: "review", reason: "consumed" });
  assert.deepEqual(over(NULLABLE_AND_OPTIONAL), { kind: "incompatible", witness: "undefined", failing: iterate.end, capability: "iterable" });
});

test("a combined change is admitted only when every value it introduces is kept from the use, and the first value that throws is the witness", () => {
  assert.deepEqual(decideUse(use(), NULLABLE_AND_OPTIONAL), { kind: "incompatible", witness: "null", failing: CITY, capability: "readable" });
  const nullTest = guard({ kind: "comparison", excludes: ["null"] });
  assert.deepEqual(decideUse(use({ guards: [nullTest] }), NULLABLE_AND_OPTIONAL), { kind: "incompatible", witness: "undefined", failing: CITY, capability: "readable" });
  const undefinedTest = guard({ kind: "comparison", excludes: ["undefined"], evidence: { path: "src/a.ts", line: 10 } });
  assert.deepEqual(decideUse(use({ guards: [nullTest, undefinedTest] }), NULLABLE_AND_OPTIONAL), { kind: "admits", guards: [nullTest, undefinedTest] });
  assert.deepEqual(decideUse(use({ guards: [guard()] }), NULLABLE_AND_OPTIONAL), { kind: "admits", guards: [guard()] });
});

test("a value a guard keeps from the use never reaches it: shown, compared or coerced behind a sufficient guard admits the change", () => {
  const behind = (operation: UseOperation, change: Change, guards = [guard()]) => decideUse(use({ path: path("address"), operation, guards }), change);
  assert.deepEqual(behind(SHOWN, NULLABLE), { kind: "admits", guards: [guard()] });
  assert.equal(behind({ steps: [], end: { kind: "compare", operator: ">", literal: 0 } }, NULLABLE_AND_OPTIONAL)?.kind, "admits");
  assert.equal(behind({ steps: [], end: { kind: "coerce", operator: "+" } }, NULLABLE)?.kind, "admits");
  assert.deepEqual(behind(SHOWN, REMOVED), { kind: "review", reason: "removed-behind-guard" });
  assert.deepEqual(behind(SHOWN, NULLABLE_AND_OPTIONAL, [guard({ excludes: ["null"] })]), { kind: "review", reason: "consumed" });
});
