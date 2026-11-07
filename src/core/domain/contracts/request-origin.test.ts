import assert from "node:assert/strict";
import test from "node:test";
import { parseRequestChange } from "./request-change.ts";
import { decideProducer, type SettledOrigin } from "./request-origin.ts";
import type { ChangeInput } from "./change.ts";

const rejection = (change: ChangeInput) => {
  const parsed = parseRequestChange(change);
  assert.ok(parsed.ok);
  return parsed.value.rejected;
};
const at = (line: number) => ({ path: "a.ts", line });
const exact = (value: Extract<SettledOrigin, { kind: "exact" }>["value"], line = 1): SettledOrigin => ({ kind: "exact", value, at: at(line), hops: [], conditions: [] });
const frontier = (line = 1): SettledOrigin => ({ kind: "frontier", reason: "call-result", at: at(line), hops: [], conditions: [] });
const approximate = (): SettledOrigin => ({ kind: "approximate", class: "string", at: at(1), hops: [], conditions: [] });

test("an exact origin writing a rejected value makes the producer incompatible, with the witness it wrote", () => {
  const verdict = decideProducer([exact({ kind: "literal", value: "ok" }, 2), exact({ kind: "literal", value: null }, 7)], rejection("non-nullable"));
  assert.deepEqual(verdict, { kind: "incompatible", witness: { value: "null", at: at(7), hops: [], conditions: [] } });
});

test("absence is rejected only under required, and null only under non-nullable", () => {
  assert.equal(decideProducer([exact({ kind: "absent" })], rejection("required")).kind, "incompatible");
  assert.equal(decideProducer([exact({ kind: "absent" })], rejection("non-nullable")).kind, "admits");
  assert.equal(decideProducer([exact({ kind: "literal", value: null })], rejection("required")).kind, "admits");
});

test("a removed literal is rejected in its own class only, and a type rejects the classes it leaves out", () => {
  const removed = rejection({ values: { removed: ["A", 1] } });
  assert.equal(decideProducer([exact({ kind: "literal", value: "A" })], removed).kind, "incompatible");
  assert.equal(decideProducer([exact({ kind: "literal", value: "B" })], removed).kind, "admits");
  assert.equal(decideProducer([exact({ kind: "literal", value: true })], removed).kind, "admits");
  const typed = rejection({ type: "string" });
  assert.equal(decideProducer([exact({ kind: "object" })], typed).kind, "incompatible");
  assert.equal(decideProducer([exact({ kind: "literal", value: "x" })], typed).kind, "admits");
});

test("a frontier or an approximate origin that may be rejected leaves the producer to review, and a rejected exact origin still decides it", () => {
  assert.deepEqual(decideProducer([exact({ kind: "literal", value: "ok" }), frontier()], rejection("non-nullable")), { kind: "review", reason: "frontier" });
  assert.deepEqual(decideProducer([approximate()], rejection({ values: { removed: ["A"] } })), { kind: "review", reason: "approximate" });
  assert.equal(decideProducer([approximate()], rejection("non-nullable")).kind, "admits");
  assert.equal(decideProducer([frontier(), exact({ kind: "absent" })], rejection("required")).kind, "incompatible");
});

test("an empty origin set never admits", () => {
  assert.deepEqual(decideProducer([], rejection("required")), { kind: "review", reason: "no-origin" });
});

test("the first rejected origin in source order is the witness, whatever the order the walk found them in", () => {
  const verdict = decideProducer([exact({ kind: "literal", value: null }, 9), exact({ kind: "literal", value: null }, 3)], rejection("non-nullable"));
  assert.equal(verdict.kind === "incompatible" && verdict.witness.at.line, 3);
});
