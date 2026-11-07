import assert from "node:assert/strict";
import test from "node:test";
import { derivedRequestChange, parseRequestChange, writtenRequestChange } from "./request-change.ts";
import type { ChangeInput } from "./change.ts";
import type { ValueSet } from "./payload-shape.ts";

const parsed = (input: ChangeInput) => {
  const result = parseRequestChange(input);
  assert.ok(result.ok);
  return result.value;
};
const refusal = (input: ChangeInput) => {
  const result = parseRequestChange(input);
  return result.ok ? undefined : result.fault.kind;
};

test("required rejects absence and non-nullable rejects null, each apart from every class of value", () => {
  const required = parsed("required").rejected;
  assert.equal(required.absent, true);
  assert.equal(required.null, false);
  assert.deepEqual(required.literals, { boolean: [], number: [], string: [] });
  assert.equal(required.array || required.object, false);
  const nonNullable = parsed("non-nullable").rejected;
  assert.equal(nonNullable.null, true);
  assert.equal(nonNullable.absent, false);
});

test("removed literals reject exactly those literals in their class, sorted and without repeats", () => {
  const { rejected, entries } = parsed({ values: { removed: ["b", "a", "a", 2, true] } });
  assert.deepEqual(rejected.literals, { boolean: [true], number: [2], string: ["a", "b"] });
  assert.deepEqual(entries, [{ values: { removed: [true, 2, "a", "b"] } }]);
});

test("a type rejects every other present class and leaves null and absence to their own entries", () => {
  const { rejected } = parsed({ type: "string" });
  assert.deepEqual(rejected.literals, { boolean: "every", number: "every", string: [] });
  assert.equal(rejected.array && rejected.object, true);
  assert.equal(rejected.null || rejected.absent, false);
  assert.equal(parsed({ type: "array" }).rejected.array, false);
});

test("entries combine in a fixed order, each once, and a single entry is echoed as written", () => {
  const combined = parsed(["non-nullable", "required", "required"]);
  assert.deepEqual(combined.entries, ["required", "non-nullable"]);
  assert.equal(combined.rejected.absent && combined.rejected.null, true);
  assert.deepEqual(writtenRequestChange(combined), ["required", "non-nullable"]);
  assert.equal(writtenRequestChange(parsed("required")), "required");
});

test("the response kinds are refused for a request, since each states what a reader may now receive", () => {
  for (const change of ["nullable", "optional", "removed", { renamed: "x" }, { wrapped: "x" }, { meaning: "units" }, { values: { added: ["a"] } }] as ChangeInput[]) assert.equal(refusal(change), "unsupported-change");
  assert.equal(refusal([]), "unsupported-change");
  assert.equal(refusal({ values: { removed: [] } }), "unsupported-change");
});

test("entries no value can satisfy together are contradictions", () => {
  assert.equal(refusal([{ type: "string" }, { type: "number" }]), "contradictory-change");
  assert.equal(refusal([{ type: "number" }, { values: { removed: ["a"] } }]), "contradictory-change");
  assert.equal(refusal([{ values: { removed: ["a"] } }, { values: { removed: ["b"] } }]), "contradictory-change");
});

const accepts = (overrides: Partial<ValueSet> = {}): ValueSet => ({ literals: { boolean: [], number: [], string: [] }, array: false, object: false, null: false, absent: false, ...overrides });
const STRINGS = { boolean: [], number: [], string: "every" } as const;

test("what a server stops accepting between two revisions is written as the entries a declared request change uses, with the old acceptance kept", () => {
  const base = accepts({ literals: { boolean: [], number: "every", string: ["a", "b"] }, null: true, absent: true });
  const derived = derivedRequestChange(base, accepts({ literals: { boolean: [], number: [], string: ["a"] } }));
  assert.ok(derived?.ok);
  assert.deepEqual(derived.value.entries, ["required", "non-nullable", { type: "string" }, { values: { removed: ["b"] } }]);
  assert.deepEqual(derived.value.oldAcceptance, base);
  assert.deepEqual(derived.value.rejected, parsed(["required", "non-nullable", { type: "string" }, { values: { removed: ["b"] } }]).rejected);
});

test("listed literals a server stops accepting are removed values even when their whole class goes, as the comparison names them", () => {
  const derived = derivedRequestChange(accepts({ literals: { boolean: [], number: "every", string: ["a", "b"] } }), accepts({ literals: { boolean: [], number: "every", string: [] } }));
  assert.ok(derived?.ok);
  assert.deepEqual(derived.value.entries, [{ values: { removed: ["a", "b"] } }]);
});

test("a server that accepts as much as before or more derives no request change", () => {
  assert.equal(derivedRequestChange(accepts({ literals: STRINGS }), accepts({ literals: { ...STRINGS, number: "every" }, null: true, absent: true })), undefined);
  assert.equal(derivedRequestChange(accepts({ literals: { ...STRINGS, string: ["a"] } }), accepts({ literals: STRINGS })), undefined);
});

test("a rejection the request entries cannot write is refused: classes retired with several or no class left, or a class narrowed to its listed literals", () => {
  const several = derivedRequestChange(accepts({ literals: { boolean: "every", number: "every", string: "every" } }), accepts({ literals: { boolean: [], number: "every", string: "every" } }));
  const none = derivedRequestChange(accepts({ literals: STRINGS }), accepts({ absent: true }));
  const narrowed = derivedRequestChange(accepts({ literals: STRINGS }), accepts({ literals: { ...STRINGS, string: ["a"] } }));
  assert.deepEqual([several?.ok, none?.ok, narrowed?.ok], [false, false, false]);
});
