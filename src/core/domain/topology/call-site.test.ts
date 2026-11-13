import { test } from "node:test";
import assert from "node:assert/strict";
import { callPlaceEvidence, compareCallSites, gatherUnresolvedCallSites, unresolvedCallSite, unsettledCallSiteCut, type CallSite } from "./call-site.ts";

function site(overrides: Partial<CallSite> = {}): CallSite {
  return { repo: "shop", file: "src/app/order.api.ts", line: 4, symbol: "OrderApi.create", transport: "http", target: { status: "unknown", reason: "unresolved", evidence: [{ path: "src/app/order.api.ts", line: 4 }] }, ...overrides };
}

test("an unresolved call cut retains its established method without claiming a path", () => {
  const call = site({ stated: { method: "DELETE" } });
  assert.deepEqual(unsettledCallSiteCut(call).reach, { kind: "call-site", transport: "http", method: "DELETE" });
  assert.deepEqual(unresolvedCallSite(call).stated, { method: "DELETE" });
});

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
  assert.deepEqual(unsettledCallSiteCut(site({ file: "src/app/catalog.api.ts", line: 12 })), { kind: "unresolved-link", at: ["src/app/catalog.api.ts", "src/app/catalog.api.ts:12"], reason: "join-unsettled", reach: { kind: "call-site", transport: "http" } });
});

test("call sites order by repository, file, line and symbol, then by the status of the target at one place", () => {
  const complete: CallSite["target"] = { status: "complete", value: { method: "GET", path: "/orders" }, evidence: [] };
  const sites = [
    site({ repo: "web", file: "a.ts", line: 1, symbol: "A" }),
    site({ file: "src/b.ts", line: 1, symbol: "A" }),
    site({ line: 10 }),
    site({ symbol: "OrderApi.list" }),
    site(),
    site({ target: complete }),
    site({ line: 9 }),
  ];

  const ordered = sites.toSorted(compareCallSites).map(({ repo, file, line, symbol, target }) => `${repo} ${file}:${line} ${symbol} ${target.status}`);

  assert.deepEqual(ordered, [
    "shop src/app/order.api.ts:4 OrderApi.create complete",
    "shop src/app/order.api.ts:4 OrderApi.create unknown",
    "shop src/app/order.api.ts:4 OrderApi.list unknown",
    "shop src/app/order.api.ts:9 OrderApi.create unknown",
    "shop src/app/order.api.ts:10 OrderApi.create unknown",
    "shop src/b.ts:1 A unknown",
    "web a.ts:1 A unknown",
  ]);
});

test("exact call evidence requires a column and joins occurrences independently of the enclosing symbol", () => {
  assert.equal(callPlaceEvidence(site()), undefined);
  assert.deepEqual(callPlaceEvidence(site({ column: 0, endLine: 20 })), { path: "src/app/order.api.ts", line: 4, column: 0 });
  assert.deepEqual(callPlaceEvidence(site({ column: 12, symbol: "Other.create" })), { path: "src/app/order.api.ts", line: 4, column: 12 });
});

test("same-line target status precedes column, which only orders otherwise tied sites", () => {
  const early = site({ column: 2 });
  const late = site({ column: 20, target: { status: "complete", value: { method: "GET", path: "/orders" }, evidence: [] } });
  const tied = site({ column: 5 });
  assert.deepEqual([early, late, tied].toSorted(compareCallSites), [late, early, tied]);
});

test("unresolved call sites that differ in anything but evidence stay separate entries", () => {
  const base = unresolvedCallSite(site());
  const kept = [{ ...base, line: 5 }, { ...base, symbol: "OrderApi.other" }, { ...base, stated: { method: "GET" as const } }, { ...base, deferred: true as const }, { ...base, column: 3 }];

  assert.equal(gatherUnresolvedCallSites([base, ...kept]).length, kept.length + 1);
  assert.deepEqual(gatherUnresolvedCallSites([base, { ...base, evidence: [{ path: "src/app/other.ts", line: 9 }] }]).map(({ evidence }) => evidence), [[{ path: "src/app/order.api.ts", line: 4 }, { path: "src/app/other.ts", line: 9 }]]);
});
