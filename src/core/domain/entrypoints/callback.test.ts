import { test } from "node:test";
import assert from "node:assert/strict";
import { callbackName } from "./entrypoint.ts";
import { sortFindings } from "./finding-order.ts";

test("callback names use fully qualified contracts and findings sort and deduplicate", () => {
  assert.equal(callbackName("a.b.C", "m"), "a.b.C.m");
  assert.equal(callbackName("a.b.A"), "a.b.A");
  const evidence = [{ path: "a.java", line: 1 }];
  const callback = { status: "complete" as const, value: { kind: "callback", name: "a.b.A" }, evidence };
  const route = { status: "complete" as const, value: { kind: "http-route", name: "GET /" }, evidence };
  assert.deepEqual(sortFindings([route, callback, callback]), [callback, route]);
});
