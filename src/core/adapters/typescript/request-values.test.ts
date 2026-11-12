import { test } from "node:test";
import assert from "node:assert/strict";
import { readRequestValue, valueUnknown, UNKNOWN_VALUE, type RequestValue } from "./request-values.ts";

test("URL components keep unknown provenance and encoded parameters through substitution", () => {
  const evidence = [{ path: "config.ts", line: 7 }];
  const parameter: RequestValue = { kind: "operation", operator: "encode", operands: [{ kind: "parameter", index: 1 }] };
  const value: RequestValue = { kind: "operation", operator: "+", operands: [
    { kind: "operation", operator: "+", operands: [valueUnknown(evidence), { kind: "literal", value: "/items/" }] }, parameter,
  ] };
  assert.deepEqual(readRequestValue(value).url, [
    { kind: "unknown", cause: "destination-undecidable", evidence }, { kind: "text", text: "/items/" }, { kind: "runtime", encoded: true },
  ]);
  const supplied = readRequestValue({ kind: "apply", body: value, arguments: [{ kind: "literal", value: "unused" }, { kind: "literal", value: "a/b" }] });
  assert.deepEqual(supplied.url, [{ kind: "unknown", cause: "destination-undecidable", evidence }, { kind: "text", text: "/items/a%2Fb" }]);
  const alternatives = readRequestValue({ kind: "choose", condition: valueUnknown(evidence), yes: value, no: { kind: "literal", value: "/other" } });
  assert.ok(alternatives.url.every((part) => part.kind === "unknown"));
  assert.deepEqual(alternatives.unresolved?.evidence, evidence);
});

test("undecided value reductions retain applicable source evidence and exclude unreachable branches", () => {
  const condition = valueUnknown([{ path: "condition.ts", line: 3 }]);
  const missing = valueUnknown([{ path: "base.ts", line: 19 }], "recursive");
  const fallback: RequestValue = { kind: "literal", value: "/fallback" };
  const choice = readRequestValue({ kind: "choose", condition, yes: missing, no: fallback });
  assert.equal(choice.unresolved?.cause, "recursive");
  assert.deepEqual(choice.unresolved?.evidence.map((item) => item.path).sort(), ["base.ts", "condition.ts"]);
  for (const operator of ["??", "||", "&&", "!", "startsWith"] as const) {
    const read = readRequestValue({ kind: "operation", operator, operands: [missing, fallback] });
    assert.equal(read.unresolved?.cause, "recursive", operator);
    assert.deepEqual(read.unresolved?.evidence, [{ path: "base.ts", line: 19 }]);
  }
  const decided = readRequestValue({ kind: "choose", condition: { kind: "literal", value: false }, yes: missing, no: fallback });
  assert.equal(decided.text, "/fallback");
  assert.equal(decided.unresolved, undefined);
});

test("value projection reuses a convergent return graph independently of unused arguments", () => {
  const depth = 8;
  let body: RequestValue = { kind: "parameter", index: 0 };
  for (let level = 0; level < depth; level++) {
    const application = (value: string): RequestValue => ({ kind: "apply", body, arguments: [{ kind: "parameter", index: 0 }, { kind: "literal", value }] });
    body = { kind: "choose", condition: UNKNOWN_VALUE, yes: application("left"), no: application("right") };
  }
  const work = { evaluations: 0, inspections: 0 };
  const read = readRequestValue({ kind: "apply", body, arguments: [{ kind: "literal", value: "/orders" }] }, work);
  assert.equal(read.text, "/orders");
  assert.equal(read.unresolved, undefined);
  assert.ok(work.evaluations + work.inspections <= 20 * (depth + 1), `evaluated ${work.evaluations} states and inspected ${work.inspections} terms`);
});

test("encoding malformed UTF-16 yields an unknown value without losing surrounding URL components", () => {
  for (const invalid of ["\uD800", "a\uDC00"]) {
    const read = readRequestValue({ kind: "operation", operator: "+", operands: [
      { kind: "literal", value: "/items/" },
      { kind: "operation", operator: "encode", operands: [{ kind: "literal", value: invalid }] },
    ] });
    assert.deepEqual(read.url, [{ kind: "text", text: "/items/" }, { kind: "unknown", cause: "destination-undecidable", evidence: [] }]);
    assert.equal(read.unresolved?.cause, "destination-undecidable");
  }
});

test("source provenance fills generic uncertainty without replacing specific causes or resolved values", () => {
  const evidence = [{ path: "routes.ts", line: 2 }];
  const value: RequestValue = { kind: "provenance", gap: { cause: "dispatch-disagreement", evidence }, value: { kind: "operation", operator: "+", operands: [
    { kind: "literal", value: "/api/" },
    { kind: "choose", condition: UNKNOWN_VALUE, yes: { kind: "parameter", index: 0 }, no: { kind: "literal", value: "other" } },
  ] } };
  assert.deepEqual(readRequestValue(value).url, [{ kind: "text", text: "/api/" }, { kind: "unknown", cause: "dispatch-disagreement", evidence }]);
  const known = readRequestValue({ kind: "apply", body: value, arguments: [{ kind: "literal", value: "other" }] });
  assert.deepEqual(known.url, [{ kind: "text", text: "/api/other" }]);
  const specific = readRequestValue({ kind: "provenance", gap: { cause: "dispatch-disagreement", evidence }, value: valueUnknown([{ path: "cycle.ts", line: 3 }], "recursive") });
  assert.equal(specific.unresolved?.cause, "recursive");
});
