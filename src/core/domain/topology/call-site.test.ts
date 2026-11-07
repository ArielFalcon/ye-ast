import { test } from "node:test";
import assert from "node:assert/strict";
import { unresolvedCallSite, unsettledCallSiteCut, type CallSite } from "./call-site.ts";

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
    reason: "unresolved",
    evidence: [{ path: "src/app/order.api.ts", line: 4 }],
    stated: { method: "GET", path: "/orders" },
  });
});

test("an unresolved call site keeps the library it goes through and drops a span of one line", () => {
  const place = unresolvedCallSite(site({ endLine: 4, target: { status: "unknown", reason: "unresolved", evidence: [{ path: "src/app/order.api.ts", line: 4, via: "com.shop.RestClient" }] } }));

  const siteEvidence = [{ path: "src/app/order.api.ts", line: 4, via: "com.shop.RestClient" }];
  assert.deepEqual(place, { path: "src/app/order.api.ts", line: 4, symbol: "OrderApi.create", transport: "http", reason: "unresolved", evidence: siteEvidence, via: "com.shop.RestClient" });
});

test("unresolved discovery retains the typed reason, diagnostic and every causal evidence span", () => {
  const evidence = [{ path: "src/app/order.api.ts", line: 4 }, { path: "(library)/lib/Client.java", line: 12 }];
  const diagnostic = { cause: "recursive" as const, source: "read" as const };
  const result = unresolvedCallSite(site({ diagnostic, target: { status: "unknown", reason: "source-unreadable", evidence } }));
  assert.equal(result.reason, "source-unreadable");
  assert.deepEqual(result.evidence, evidence);
  assert.deepEqual(result.diagnostic, diagnostic);
});

test("a call site the join could not settle is an unresolved-link cut at its file, then at its line", () => {
  assert.deepEqual(unsettledCallSiteCut(site({ file: "src/app/catalog.api.ts", line: 12 })), { kind: "unresolved-link", at: ["src/app/catalog.api.ts", "src/app/catalog.api.ts:12"] });
});
