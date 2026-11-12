import { test } from "node:test";
import assert from "node:assert/strict";
import { readRequestValue, valueUnknown, UNKNOWN_VALUE, type RequestValue, type RequestValueRead } from "./request-values.ts";

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

const lit = (value: string): RequestValue => ({ kind: "literal", value });
const plus = (...operands: RequestValue[]): RequestValue => operands.reduce((left, right) => ({ kind: "operation", operator: "+", operands: [left, right] }));

test("a partial string decides startsWith and trim-start by its stated prefix and stays undecided where a hole could change the answer", () => {
  const base = valueUnknown([{ path: "base.ts", line: 1 }]);
  const resolved = (path: RequestValue): RequestValue => ({
    kind: "choose",
    condition: { kind: "operation", operator: "||", operands: [{ kind: "operation", operator: "startsWith", operands: [path, lit("http://")] }, { kind: "operation", operator: "startsWith", operands: [path, lit("https://")] }] },
    yes: path,
    no: plus(base, lit("/"), { kind: "operation", operator: "trim-start", operands: [path] }),
  });
  const hole: RequestValue = { kind: "parameter", index: 0 };
  assert.deepEqual(readRequestValue(resolved(plus(lit("/orders/"), hole))).url, [
    { kind: "unknown", cause: "destination-undecidable", evidence: [{ path: "base.ts", line: 1 }] }, { kind: "text", text: "/orders/" }, { kind: "runtime" },
  ]);
  for (const path of [plus(hole, lit("/orders")), plus(lit("h"), hole)]) {
    assert.ok(readRequestValue(resolved(path)).url.every((part) => part.kind === "unknown"));
  }
  assert.equal(readRequestValue(resolved(plus(lit("//"), hole))).url.at(-1)?.kind, "unknown");
  assert.deepEqual(readRequestValue(resolved(lit("http"))).url, [{ kind: "unknown", cause: "destination-undecidable", evidence: [{ path: "base.ts", line: 1 }] }, { kind: "text", text: "/http" }]);
  assert.deepEqual(readRequestValue(resolved(plus(lit("http://"), hole))).url, [{ kind: "text", text: "http://" }, { kind: "runtime" }]);
});

test("one undecided condition yields an alternative per outcome only when the outcomes state different URLs", () => {
  const condition = valueUnknown([{ path: "c.ts", line: 2 }]);
  const split = (yes: RequestValue, no: RequestValue): RequestValueRead => readRequestValue(plus(lit("/articles"), { kind: "choose", condition, yes, no }));
  assert.deepEqual(split(lit("/feed"), lit("")).alternatives?.map((url) => url.map((part) => (part.kind === "text" ? part.text : part.kind))), [["/articles/feed"], ["/articles"]]);
  assert.equal(split({ kind: "literal", value: 1 }, { kind: "literal", value: 2 }).alternatives, undefined);
  const twice = readRequestValue(plus(lit("/a"), { kind: "choose", condition, yes: lit("/b"), no: lit("") }, { kind: "choose", condition, yes: lit("/c"), no: lit("") }));
  assert.equal(twice.alternatives, undefined);
});
