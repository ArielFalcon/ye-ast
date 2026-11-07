import assert from "node:assert/strict";
import test from "node:test";
import { ELEMENT, parseAccessPath } from "./access-path.ts";
import { derivedChange, parseChange, VALUE_CLASSES, type ChangeInput, type ValueDelta } from "./change.ts";
import type { ValueSet } from "./payload-shape.ts";

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

const OLD_GUARANTEE: ValueSet = { literals: { boolean: [], number: [], string: ["A", "B"] }, array: false, object: false, null: false, absent: false };

const delta = (overrides: Partial<ValueDelta> = {}): ValueDelta => ({ introduced: [], added: [], retired: [], alwaysAbsent: false, oldGuarantee: OLD_GUARANTEE, ...overrides });

function derived(input: ValueDelta) {
  const result = derivedChange(input);
  assert.ok(result.ok);
  return result.value;
}

const WRITTEN: readonly (readonly [string, ChangeInput, ValueDelta])[] = [
  ["nullable", "nullable", delta({ introduced: ["null"] })],
  ["optional", "optional", delta({ introduced: ["undefined"] })],
  ["removed", "removed", delta({ introduced: ["undefined"], alwaysAbsent: true })],
  ["every type", { type: "string" }, delta({ introduced: ["string"] })],
  ["an array type", { type: "array" }, delta({ introduced: ["array"] })],
  ["added literals", { values: { added: ["B", 2, "A", true] } }, delta({ added: ["B", 2, "A", true] })],
  ["retired literals", { values: { removed: ["Z", 1] } }, delta({ retired: ["Z", 1] })],
  ["both lists", { values: { added: ["A"], removed: ["B"] } }, delta({ added: ["A"], retired: ["B"] })],
  ["nullable and optional", ["optional", "nullable"], delta({ introduced: ["undefined", "null"] })],
  ["a type and an absence", [{ type: "number" }, "optional"], delta({ introduced: ["number", "undefined"] })],
  ["an absence and literals", ["nullable", { values: { added: ["A"], removed: ["B"] } }], delta({ introduced: ["null"], added: ["A"], retired: ["B"] })],
  ["a type and literals of its kind", [{ type: "string" }, { values: { added: ["A"], removed: ["B"] } }], delta({ introduced: ["string"], added: ["A"], retired: ["B"] })],
];

test("a change derived from a delta is exactly the change the parser builds for the delta a written hypothesis expresses, and states the old guarantee", () => {
  for (const [name, input, expected] of WRITTEN) {
    const { oldGuarantee, ...rest } = derived(expected);
    assert.deepEqual(rest, parsed(input), name);
    assert.deepEqual(oldGuarantee, OLD_GUARANTEE, name);
  }
});

test("a derived change accepts what a written one cannot say: several introduced classes, and a retired literal outside a new class", () => {
  const classes = derived(delta({ introduced: ["string", "number", "null"] }));
  assert.deepEqual(classes.entries, ["nullable", { type: "number" }, { type: "string" }]);
  assert.deepEqual(classes.introduced, ["null", "number", "string"]);
  assert.equal(refusal([{ type: "number" }, { type: "string" }]), "contradictory-change");

  const outside = derived(delta({ introduced: ["number"], retired: ["x"] }));
  assert.deepEqual(outside.entries, [{ type: "number" }, { values: { added: [], removed: ["x"] } }]);
  assert.equal(refusal([{ type: "number" }, { values: { removed: ["x"] } }]), "contradictory-change");
});

test("a delta that introduces and retires nothing, or that contradicts itself, derives no change", () => {
  const faults = (input: ValueDelta) => {
    const result = derivedChange(input);
    return result.ok ? undefined : result.fault.kind;
  };
  assert.equal(faults(delta()), "unsupported-change");
  assert.equal(faults(delta({ added: ["A"], retired: ["A"] })), "contradictory-change");
  assert.equal(faults(delta({ added: [Number.NaN] })), "unsupported-change");
});
