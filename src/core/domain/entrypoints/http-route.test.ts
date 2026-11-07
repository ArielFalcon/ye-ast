import assert from "node:assert/strict";
import test from "node:test";
import { httpRouteName, parseHttpRouteName } from "./http-route.ts";

test("a route name reads back as the method, path and version that wrote it, and nothing else reads as one", () => {
  for (const route of [{ method: "GET", path: "/orders/{id}" }, { method: "ANY", path: "/orders", version: "1.2+" }] as const) {
    assert.deepEqual(parseHttpRouteName(httpRouteName(route)), route);
  }
  assert.deepEqual(["FETCH /orders", "GET", "GET /orders 1", "GET /orders v1 extra"].map(parseHttpRouteName), [undefined, undefined, undefined, undefined]);
});
