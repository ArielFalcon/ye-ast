import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpRoute } from "../../domain/entrypoints/http-route.ts";
import type { CallSite, HttpTarget } from "../../domain/topology/call-site.ts";
import type { RepositoryEntrypoints } from "../../domain/topology/link-match.ts";
import { inferGateways, matchCallSite } from "../../domain/topology/link-match.ts";

function route(method: HttpRoute["method"], path: string, handler = { path: "src/main/java/app/Orders.java", symbol: "Orders.orders", line: 10 }, basePath = {}): HttpRoute {
  return { kind: "http-route", name: `${method} ${path}`, method, path, handler, basePath: { status: "complete", value: { default: basePath, profiles: {} }, evidence: [] } };
}

function site(path: string, method: HttpTarget["method"] = "GET", base?: string): CallSite {
  return {
    repo: "shop-web",
    file: "src/app/order.api.ts",
    line: 7,
    symbol: "OrderApi.create",
    transport: "http",
    target: { status: "complete", value: { method, path, ...(base === undefined ? {} : { base }) }, evidence: [] },
  };
}

function repositories(entrypoints: readonly HttpRoute[], repo = "orders"): RepositoryEntrypoints[] {
  return [{ repo, entrypoints }];
}

function joined(result: ReturnType<typeof matchCallSite>): string {
  if (result.link === undefined) return result.ambiguous === undefined ? `none ${result.unmatched ?? ""}`.trim() : `ambiguous ${result.ambiguous.repos.join(",")}`;
  const { basis, confidence, profiles } = result.link;
  return `${basis} ${confidence}${profiles === undefined ? "" : ` ${profiles.join(",")}`} -> ${result.link.to.repo} ${result.link.to.name}`;
}

test("a call whose path and verb equal a route's is an exact link at full confidence", () => {
  const call = site("orders");

  assert.equal(joined(matchCallSite(call, targetOf(call), repositories([route("GET", "/orders")]), [])), "exact 1 -> orders GET /orders");
});

test("a route that names no verb serves every call of its path", () => {
  const call = site("orders", "DELETE");

  assert.equal(joined(matchCallSite(call, targetOf(call), repositories([route("ANY", "/orders")]), [])), "exact 1 -> orders ANY /orders");
});

test("a call that carries a declared gateway prefix matches once the prefix is removed, at full confidence", () => {
  const call = site("orders-api/orders", "POST");

  assert.equal(joined(matchCallSite(call, targetOf(call), repositories([route("POST", "/orders")]), [{ prefix: "orders-api", repo: "orders", basis: "gateway-prefix" }])), "gateway-prefix 1 -> orders POST /orders");
});

test("a call that carries the base path the route's configuration adds matches through it, naming no profile", () => {
  const call = site("billing/orders");

  assert.equal(joined(matchCallSite(call, targetOf(call), repositories([route("GET", "/orders", undefined, { contextPath: "/billing" })]), [])), "base-path 1 -> orders GET /orders");
});

test("a route that names the call's segment wins over one that takes a parameter there, whatever the order they are declared in", () => {
  const call = site("users/me");
  const routes = [route("GET", "/users/{userId}", { path: "src/Users.java", symbol: "Users.one", line: 1 }), route("GET", "/users/me", { path: "src/Users.java", symbol: "Users.me", line: 2 })];

  assert.equal(joined(matchCallSite(call, targetOf(call), repositories(routes), [])), "exact 1 -> orders GET /users/me");
  assert.equal(joined(matchCallSite(call, targetOf(call), repositories([...routes].reverse()), [])), "exact 1 -> orders GET /users/me");
});

test("a base path that only profiles set matches under every profile that sets it, and the link names them", () => {
  const call = site("billing/orders");
  const profiled: HttpRoute = { ...route("GET", "/orders"), basePath: { status: "complete", value: { default: {}, profiles: { prod: { contextPath: "/billing" }, dev: { contextPath: "/billing" }, test: { contextPath: "/other" } } }, evidence: [] } };

  assert.equal(joined(matchCallSite(call, targetOf(call), repositories([profiled]), [])), "base-path 1 dev,prod -> orders GET /orders");
});

test("a call whose path ends with a route's is matched by suffix at half confidence, never more", () => {
  const call = site("restaurants/daily-menus");

  assert.equal(joined(matchCallSite(call, targetOf(call), repositories([route("GET", "/daily-menus")]), [])), "suffix 0.5 -> orders GET /daily-menus");
});

test("a call that reaches a service and matches nothing is unmatched, not silently dropped", () => {
  const call = site("orders-api/refunds", "POST");

  assert.equal(joined(matchCallSite(call, targetOf(call), repositories([route("GET", "/orders")]), [{ prefix: "orders-api", repo: "orders", basis: "gateway-prefix" }])), "none orders-api/refunds");
});

test("a prefix two repositories would serve is ambiguous, never a pick", () => {
  const call = site("orders-api/orders", "GET");

  assert.equal(joined(matchCallSite(call, targetOf(call), [{ repo: "orders", entrypoints: [route("GET", "/orders")] }, { repo: "billing", entrypoints: [route("GET", "/orders")] }], [])), "ambiguous billing,orders");
});

test("a gateway the workspace does not declare is inferred by route overlap: one repository matches under the prefix and the rest match nothing", () => {
  const calls = [site("orders-api/orders", "GET"), site("orders-api/checkout", "POST"), site("orders-api/refunds", "POST")];
  const repositories: RepositoryEntrypoints[] = [{ repo: "orders", entrypoints: [route("GET", "/orders"), route("POST", "/checkout")] }, { repo: "billing", entrypoints: [route("GET", "/invoices")] }];

  const gateways = inferGateways(calls, repositories, []);

  assert.deepEqual(gateways.map((gateway) => `${gateway.prefix} -> ${gateway.repo} (${gateway.basis})`), ["orders-api -> orders (route-overlap)"]);
});

test("a call under an inferred gateway links with basis route-overlap, and a prefix of the call's own repository infers nothing", () => {
  const call = site("orders-api/orders", "GET");
  const served: RepositoryEntrypoints[] = [{ repo: "orders", entrypoints: [route("GET", "/orders")] }];

  assert.equal(joined(matchCallSite(call, targetOf(call), served, inferGateways([call], served, []))), "route-overlap 1 -> orders GET /orders");
  assert.deepEqual(inferGateways([{ ...call, repo: "orders" }], served, []), []);
});

test("a path that equals a route's is exact even when its first segment is a declared gateway prefix", () => {
  const call = site("orders-api/orders", "GET");

  assert.equal(joined(matchCallSite(call, targetOf(call), repositories([route("GET", "/orders-api/orders")]), [{ prefix: "orders-api", repo: "orders", basis: "gateway-prefix" }])), "exact 1 -> orders GET /orders-api/orders");
});

test("a call under a gateway prefix never falls to the suffix rung of another repository", () => {
  const call = site("orders-api/refunds", "POST");
  const served: RepositoryEntrypoints[] = [{ repo: "orders", entrypoints: [route("GET", "/orders")] }, { repo: "billing", entrypoints: [route("POST", "/refunds")] }];

  assert.equal(joined(matchCallSite(call, targetOf(call), served, [{ prefix: "orders-api", repo: "orders", basis: "gateway-prefix" }])), "none orders-api/refunds");
});

test("a declared gateway overrides the inferred one, and a prefix two repositories match under is inferred for neither", () => {
  const calls = [site("orders-api/orders", "GET")];
  const sharing: RepositoryEntrypoints[] = [{ repo: "orders", entrypoints: [route("GET", "/orders")] }, { repo: "billing", entrypoints: [route("GET", "/orders")] }];

  assert.deepEqual(inferGateways(calls, sharing, []), []);
  assert.deepEqual(inferGateways(calls, [{ repo: "orders", entrypoints: [route("GET", "/invoices")] }], [{ prefix: "orders-api", repo: "orders" }]).map((gateway) => `${gateway.repo} ${gateway.basis}`), ["orders gateway-prefix"]);
});

function targetOf(call: CallSite): HttpTarget {
  return call.target.status === "complete" && "path" in call.target.value ? call.target.value : ({} as HttpTarget);
}
