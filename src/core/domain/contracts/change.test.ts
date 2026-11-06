import assert from "node:assert/strict";
import test from "node:test";
import { ELEMENT, parseAccessPath } from "./access-path.ts";
import { parseChange, VALUE_CLASSES, type ChangeInput } from "./change.ts";

const property = parseAccessPath("owner.items")!;

function parsed(input: ChangeInput) {
  const result = parseChange(input, property);
  assert.ok(result.ok);
  return result.value;
}

function refusal(input: ChangeInput) {
  const result = parseChange(input, property);
  return result.ok ? undefined : result.fault.kind;
}

test("a type change introduces the kind it states, united in the fixed class order with what the other entries introduce", () => {
  assert.deepEqual(parsed({ type: "string" }), { entries: [{ type: "string" }], introduced: ["string"], alwaysAbsent: false });
  const combined = parsed([{ type: "number" }, "optional", "nullable"]);
  assert.deepEqual(combined.entries, ["nullable", "optional", { type: "number" }]);
  assert.deepEqual(combined.introduced, ["null", "undefined", "number"]);
  assert.deepEqual(VALUE_CLASSES, ["null", "undefined", "boolean", "number", "string", "array", "object"]);
});

test("a wrapped change introduces an object and gives the path its elements move to", () => {
  assert.deepEqual(parsed({ wrapped: "content" }), { entries: [{ wrapped: "content" }], introduced: ["object"], alwaysAbsent: false, elementsAt: ["owner", "items", "content", ELEMENT] });
});

test("a type or wrapped entry with anything but one known kind or one segment is unsupported", () => {
  assert.equal(refusal({ type: "date" }), "unsupported-change");
  assert.equal(refusal({ type: "null" }), "unsupported-change");
  assert.equal(refusal({ type: "string", wrapped: "content" }), "unsupported-change");
  assert.equal(refusal({ wrapped: "a.b" }), "unsupported-change");
  assert.equal(refusal({ wrapped: ELEMENT }), "unsupported-change");
});

test("entries that cannot hold together are refused as contradictions, and a repeated entry is none", () => {
  assert.equal(refusal([{ type: "string" }, { type: "number" }]), "contradictory-change");
  assert.equal(refusal([{ wrapped: "content" }, { type: "object" }]), "contradictory-change");
  assert.equal(refusal([{ wrapped: "content" }, { wrapped: "items" }]), "contradictory-change");
  assert.equal(refusal(["removed", { type: "string" }]), "contradictory-change");
  assert.equal(refusal([{ type: "string" }, { type: "string" }]), undefined);
});

test("a values change carries its added and retired literals, each once in a fixed order, and introduces no class", () => {
  const change = parsed({ values: { added: ["B", 2, "A", "B", true], removed: ["Z", 1] } });
  assert.deepEqual(change.entries, [{ values: { added: [true, 2, "A", "B"], removed: [1, "Z"] } }]);
  assert.deepEqual(change.values, { added: [true, 2, "A", "B"], removed: [1, "Z"] });
  assert.deepEqual(change.introduced, []);
  assert.equal(change.alwaysAbsent, false);
  assert.deepEqual(parsed({ values: { added: ["A"] } }).values, { added: ["A"], removed: [] });
});

test("a values entry is unsupported unless it holds literal lists with at least one literal", () => {
  assert.equal(refusal({ values: { added: [], removed: [] } }), "unsupported-change");
  assert.equal(refusal({ values: {} }), "unsupported-change");
  assert.equal(refusal({ values: ["A"] }), "unsupported-change");
  assert.equal(refusal({ values: "A" }), "unsupported-change");
  assert.equal(refusal({ values: { added: [null] } }), "unsupported-change");
  assert.equal(refusal({ values: { added: [{}] } }), "unsupported-change");
  assert.equal(refusal({ values: { added: [Number.NaN] } }), "unsupported-change");
  assert.equal(refusal({ values: { added: "A" } }), "unsupported-change");
  assert.equal(refusal({ values: { added: ["A"], other: [] } }), "unsupported-change");
});

test("values entries that cannot hold together are refused as contradictions", () => {
  assert.equal(refusal({ values: { added: ["A"], removed: ["A"] } }), "contradictory-change");
  assert.equal(refusal([{ values: { added: ["A"] } }, { values: { removed: ["B"] } }]), "contradictory-change");
  assert.equal(refusal([{ type: "string" }, { values: { added: [1] } }]), "contradictory-change");
  assert.equal(refusal([{ type: "string" }, { values: { removed: [true] } }]), "contradictory-change");
  assert.equal(refusal([{ type: "array" }, { values: { added: ["A"] } }]), "contradictory-change");
  assert.equal(refusal(["removed", { values: { added: ["A"] } }]), "contradictory-change");
  assert.equal(refusal([{ type: "string" }, { values: { added: ["A"], removed: ["B"] } }]), undefined);
  assert.equal(refusal({ values: { added: [1], removed: ["1"] } }), undefined);
  assert.equal(refusal([{ values: { added: ["A"] } }, { values: { added: ["A"] } }]), undefined);
});

test("a meaning change carries its note as written and introduces nothing", () => {
  const change = parsed({ meaning: "euros become cents" });
  assert.deepEqual(change.entries, [{ meaning: "euros become cents" }]);
  assert.equal(change.meaning, "euros become cents");
  assert.deepEqual(change.introduced, []);
  assert.deepEqual(parsed(["nullable", { meaning: "x" }]).entries, ["nullable", { meaning: "x" }]);
  assert.equal(refusal({ meaning: "" }), "unsupported-change");
  assert.equal(refusal({ meaning: "  " }), "unsupported-change");
  assert.equal(refusal({ meaning: 3 }), "unsupported-change");
  assert.equal(refusal(["removed", { meaning: "x" }]), "contradictory-change");
});
