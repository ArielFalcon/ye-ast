import assert from "node:assert/strict";
import test from "node:test";
import { carrierKey, sourceUnreadable, type CarrierSite } from "./consumer-flow.ts";

const read = (overrides: Partial<Extract<CarrierSite, { kind: "member-read" }>> = {}): CarrierSite => ({ kind: "member-read", repo: "web", file: "src/a.ts", line: 4, column: 7, owner: "Store", member: "items", ...overrides });
const parameter = (overrides: Partial<Extract<CarrierSite, { kind: "method-parameter" }>> = {}): CarrierSite => ({ kind: "method-parameter", repo: "web", file: "src/a.ts", owner: "Page", method: "add", index: 0, ...overrides });
const templateResult = (overrides: Partial<Extract<CarrierSite, { kind: "template-call-result" }>> = {}): CarrierSite => ({ kind: "template-call-result", repo: "web", resource: "src/a.html", start: 10, end: 24, callee: "label", argument: 0, ...overrides });

test("the carriers of the member reads, method parameters and template call results are told apart by everything that identifies them", () => {
  const same = (a: CarrierSite, b: CarrierSite) => carrierKey(a) === carrierKey(b);
  assert.ok(same(read(), read()));
  for (const other of [read({ line: 5 }), read({ column: 8 }), read({ member: "other" }), read({ owner: "Other" }), read({ file: "src/b.ts" })]) assert.ok(!same(read(), other));
  assert.ok(same(parameter(), parameter()));
  for (const other of [parameter({ index: 1 }), parameter({ method: "remove" }), parameter({ owner: "Other" })]) assert.ok(!same(parameter(), other));
  assert.ok(same(templateResult(), templateResult()));
  for (const other of [templateResult({ start: 11 }), templateResult({ end: 25 }), templateResult({ callee: "other" }), templateResult({ argument: 1 }), templateResult({ resource: "src/b.html" })]) assert.ok(!same(templateResult(), other));
  assert.ok(!same({ kind: "member", repo: "web", file: "src/a.ts", owner: "Store", member: "items" }, read({ line: 1, column: 1 })));
});

test("a site the reader cannot read is a frontier at its file or template, on the line when the site has one", () => {
  const at = (site: CarrierSite) => sourceUnreadable(site).frontiers.map(({ at: place, cause, reason }) => [place.path, place.line, cause, reason]);
  assert.deepEqual(at(read()), [["src/a.ts", 4, "unmodelled-flow", "source-unreadable"]]);
  assert.deepEqual(at(parameter()), [["src/a.ts", 1, "unmodelled-flow", "source-unreadable"]]);
  assert.deepEqual(at(templateResult()), [["src/a.html", 1, "unmodelled-flow", "source-unreadable"]]);
});
