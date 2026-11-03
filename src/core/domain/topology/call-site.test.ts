import { test } from "node:test";
import assert from "node:assert/strict";
import { unresolvedCallSite, type CallSite } from "./call-site.ts";

function site(overrides: Partial<CallSite> = {}): CallSite {
  return { repo: "shop", file: "src/app/order.api.ts", line: 4, symbol: "OrderApi.create", transport: "http", target: { status: "unknown", reason: "unresolved", evidence: [{ path: "src/app/order.api.ts", line: 4 }] }, ...overrides };
}

test("an unresolved call site names its declaration, its transport and the request the code states", () => {
  assert.deepEqual(unresolvedCallSite(site({ endLine: 6, stated: { method: "GET", path: "/orders" } })), {
    path: "src/app/order.api.ts",
    line: 4,
    endLine: 6,
    symbol: "OrderApi.create",
    transport: "http",
    stated: { method: "GET", path: "/orders" },
  });
});

test("an unresolved call site keeps the library it goes through and drops a span of one line", () => {
  const place = unresolvedCallSite(site({ endLine: 4, target: { status: "unknown", reason: "unresolved", evidence: [{ path: "src/app/order.api.ts", line: 4, via: "com.shop.RestClient" }] } }));

  assert.deepEqual(place, { path: "src/app/order.api.ts", line: 4, symbol: "OrderApi.create", transport: "http", via: "com.shop.RestClient" });
});
