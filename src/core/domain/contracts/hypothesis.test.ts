import assert from "node:assert/strict";
import test from "node:test";
import { formatHypothesis, parseHypothesis, type HypothesisInput } from "./hypothesis.ts";

function input(overrides: Partial<HypothesisInput> = {}): HypothesisInput {
  return { method: "get", path: "/api/owners/{id}", target: "response", property: "[].owner.name", change: "nullable", ...overrides };
}

test("a hypothesis is normalized: the verb in capitals and the property as an access path", () => {
  const parsed = parseHypothesis(input());
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, { method: "GET", path: "/api/owners/{id}", target: "response", property: ["[]", "owner", "name"], change: "nullable" });
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
  assert.equal(refusal({ property: "a..b" }), "invalid-property");
  assert.equal(refusal({ property: "" }), "invalid-property");
  assert.equal(refusal({ property: "owners[]" }), "element-is-not-a-property");
});
