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
