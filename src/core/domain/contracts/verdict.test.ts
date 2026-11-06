import assert from "node:assert/strict";
import test from "node:test";
import { parseAccessPath } from "./access-path.ts";
import { decideUse, type Guard, type UseSite } from "./verdict.ts";

const path = (text: string) => parseAccessPath(text)!;

function guard(overrides: Partial<Guard> = {}): Guard {
  return { kind: "truthiness", covers: path("address"), excludes: ["null", "undefined"], evidence: { path: "src/a.ts", line: 9 }, ...overrides };
}

function use(overrides: Partial<UseSite> = {}): UseSite {
  return { path: path("address.city"), changed: path("address"), operation: "consume", guards: [], ...overrides };
}

test("an unguarded read inside a value the contract now lets be null is incompatible, with null as the counterexample", () => {
  assert.deepEqual(decideUse(use(), "nullable"), { kind: "incompatible", requirement: "present-and-non-null", counterexample: "null" });
});

test("the same read of a removed property is incompatible with absent as the counterexample", () => {
  assert.deepEqual(decideUse(use(), "removed"), { kind: "incompatible", requirement: "present-and-non-null", counterexample: "absent" });
});

test("a sufficient guard makes the read admit the change and names the guard", () => {
  const sufficient = guard({ kind: "optional-chain", covers: path("address") });
  assert.deepEqual(decideUse(use({ guards: [sufficient] }), "nullable"), { kind: "admits", guard: sufficient });
});

test("a non-null assertion is never a guard", () => {
  const verdict = decideUse(use({ guards: [guard({ kind: "non-null-assertion" })] }), "nullable");
  assert.equal(verdict?.kind, "incompatible");
});

test("a guard covers only the segments it tests: a parent guard does not protect the changed segment", () => {
  const parentOnly = guard({ kind: "optional-chain", covers: path("") });
  assert.equal(decideUse(use({ guards: [parentOnly] }), "nullable")?.kind, "incompatible");
  const deeper = guard({ covers: path("address.city") });
  assert.equal(decideUse(use({ guards: [deeper] }), "nullable")?.kind, "admits");
});

test("an optional chain protects only the segment it sits at: one deeper in the path leaves the earlier dereference unguarded", () => {
  const deeperChain = guard({ kind: "optional-chain", covers: path("address.city") });
  assert.equal(decideUse(use({ path: path("address.city.name"), guards: [deeperChain] }), "nullable")?.kind, "incompatible");
  const atChanged = guard({ kind: "optional-chain", covers: path("address") });
  assert.equal(decideUse(use({ path: path("address.city.name"), guards: [atChanged] }), "nullable")?.kind, "admits");
});

test("a test of a deeper path still establishes the prefix it dereferences", () => {
  const deeperTest = guard({ kind: "truthiness", covers: path("address.city") });
  assert.equal(decideUse(use({ path: path("address.city.name"), guards: [deeperTest] }), "nullable")?.kind, "admits");
});

test("a guard that excludes only what the change does not introduce does not protect", () => {
  assert.equal(decideUse(use({ guards: [guard({ excludes: ["undefined"] })] }), "nullable")?.kind, "incompatible");
  assert.equal(decideUse(use({ guards: [guard({ excludes: ["null"] })] }), "removed")?.kind, "incompatible");
});

test("a removed property behind a guard is for review", () => {
  assert.deepEqual(decideUse(use({ guards: [guard()] }), "removed"), { kind: "review", reason: "removed-behind-guard" });
});

test("a guard outside the vocabulary leaves the read for review, and a recognized guard wins over it", () => {
  const opaque = guard({ kind: "type-guard" });
  assert.deepEqual(decideUse(use({ guards: [opaque] }), "nullable"), { kind: "review", reason: "opaque-guard" });
  const sufficient = guard();
  assert.equal(decideUse(use({ guards: [opaque, sufficient] }), "nullable")?.kind, "admits");
});

test("operating on the changed value itself is incompatible only when the operation dereferences it", () => {
  const exact = { path: path("address"), changed: path("address") };
  assert.equal(decideUse(use({ ...exact, operation: "dereference" }), "nullable")?.kind, "incompatible");
  assert.deepEqual(decideUse(use({ ...exact, operation: "consume" }), "nullable"), { kind: "review", reason: "consumed" });
  assert.deepEqual(decideUse(use({ ...exact, operation: "unmodelled" }), "nullable"), { kind: "review", reason: "unmodelled-sink" });
});

test("a read that does not reach into the changed value is no use of it", () => {
  assert.equal(decideUse(use({ path: path("name") }), "nullable"), undefined);
  assert.equal(decideUse(use({ path: path("") }), "nullable"), undefined);
});
