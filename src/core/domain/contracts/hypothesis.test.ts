import assert from "node:assert/strict";
import test from "node:test";
import { formatHypothesis, parseHypothesis, type HypothesisInput } from "./hypothesis.ts";

function input(overrides: Partial<HypothesisInput> = {}): HypothesisInput {
  return { method: "get", path: "/api/owners/{id}", target: "response", property: "[].owner.name", change: "nullable", ...overrides };
}

test("a hypothesis is normalized: the verb in capitals and the property as an access path", () => {
  const parsed = parseHypothesis(input());
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, { method: "GET", path: "/api/owners/{id}", target: "response", property: ["[]", "owner", "name"], change: { entries: ["nullable"], introduced: ["null"], alwaysAbsent: false } });
  assert.equal(formatHypothesis(parsed.value), "GET /api/owners/{id} response [].owner.name nullable");
});

test("input the slice does not support or that contradicts itself is refused with a typed reason", () => {
  const refusal = (overrides: Partial<HypothesisInput>) => {
    const parsed = parseHypothesis(input(overrides));
    return parsed.ok ? undefined : parsed.fault.kind;
  };
  assert.equal(refusal({ method: "FETCH" }), "invalid-method");
  assert.equal(refusal({ path: "api/owners" }), "invalid-path");
  assert.equal(refusal({ target: "request" }), "unsupported-target");
  assert.equal(refusal({ change: "renamed" }), "unsupported-change");
  assert.equal(refusal({ change: { type: "string" } }), "unsupported-change");
  assert.equal(refusal({ change: { renamed: "owner.name" } }), "unsupported-change");
  assert.equal(refusal({ change: { renamed: "fullName", type: "string" } }), "unsupported-change");
  assert.equal(refusal({ change: [] }), "unsupported-change");
  assert.equal(refusal({ property: "a..b" }), "invalid-property");
  assert.equal(refusal({ property: "" }), "invalid-property");
  assert.equal(refusal({ property: "owners[]" }), "element-is-not-a-property");
});

test("a combined change is normalized once: each entry once, in a fixed order, with the values they introduce united", () => {
  const parsed = parseHypothesis(input({ change: ["optional", "nullable", "optional"] }));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.change, { entries: ["nullable", "optional"], introduced: ["null", "undefined"], alwaysAbsent: false });
  assert.equal(formatHypothesis(parsed.value), 'GET /api/owners/{id} response [].owner.name ["nullable","optional"]');
});

test("a rename is always absent and moves the property: its last segment takes the new name", () => {
  const parsed = parseHypothesis(input({ change: { renamed: "fullName" } }));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.change, { entries: [{ renamed: "fullName" }], introduced: ["undefined"], alwaysAbsent: true, renamedTo: ["[]", "owner", "fullName"] });
});

test("a change that contradicts itself is refused, and a repeated entry is no contradiction", () => {
  const refusal = (change: HypothesisInput["change"]) => {
    const parsed = parseHypothesis(input({ change }));
    return parsed.ok ? undefined : parsed.fault.kind;
  };
  assert.equal(refusal(["removed", "nullable"]), "contradictory-change");
  assert.equal(refusal(["optional", { renamed: "fullName" }]), "contradictory-change");
  assert.equal(refusal([{ renamed: "fullName" }, { renamed: "label" }]), "contradictory-change");
  assert.equal(refusal(["removed", "removed"]), undefined);
});
