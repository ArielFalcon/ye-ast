import { test } from "node:test";
import assert from "node:assert/strict";
import { readRequestValue, valueUnknown, UNKNOWN_VALUE, type RequestValue } from "./request-values.ts";

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
