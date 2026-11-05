import { test } from "node:test";
import assert from "node:assert/strict";
import type { Listener } from "../../domain/entrypoints/entrypoint.ts";
import type { HttpRoute } from "../../domain/entrypoints/http-route.ts";
import type { CallSite, EventTarget, HttpTarget } from "../../domain/topology/call-site.ts";
import type { RepositoryEntrypoints } from "../../domain/topology/link-match.ts";
import { inferGateways, matchCallSite, matchEventCallSite, prefixOf } from "../../domain/topology/link-match.ts";

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

test("gateway prefixes come from URL paths, never schemes or authorities", () => {
  assert.equal(prefixOf({ method: "GET", path: "http://localhost:9966/api/orders" }), "api");
  assert.equal(prefixOf({ method: "GET", path: "//example.test/api/orders" }), "api");
  assert.equal(prefixOf({ method: "GET", path: "https://example.test" }), undefined);
  assert.equal(prefixOf({ method: "GET", path: "http:" }), undefined);
  assert.equal(prefixOf({ method: "GET", path: "/gateway/orders" }), "gateway");
  assert.equal(prefixOf({ method: "GET", path: "{}/orders" }), undefined);
});

test("an absolute URL can infer and use a gateway from its path", () => {
  const call = site("http://localhost:9966/api/orders");
  const repos = repositories([route("GET", "/orders")]);
  const gateways = inferGateways([call], repos, []);
  assert.deepEqual(gateways, [{ prefix: "api", repo: "orders", basis: "route-overlap" }]);
  assert.equal(joined(matchCallSite(call, targetOf(call), repos, gateways)), "route-overlap 1 -> orders GET /orders");
});

test("absolute URL matching rates path equality without asserting host ownership", () => {
  const call = site("https://external.example/orders");
  assert.equal(joined(matchCallSite(call, targetOf(call), repositories([route("GET", "/orders")]), [])), "exact 1 -> orders GET /orders");
});

test("URL authority cannot select one of two repositories with the same exact path", () => {
  const call = site("//orders.example/orders");
  const repos = [...repositories([route("GET", "/orders")]), ...repositories([route("GET", "/orders")], "billing")];
  const result = matchCallSite(call, targetOf(call), repos, []);
  assert.equal(result.link, undefined);
  assert.deepEqual(result.ambiguous?.repos, ["billing", "orders"]);
});

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

const CONSUMER = { path: "src/main/java/app/OrdersListener.java", symbol: "OrdersListener.on", line: 8 };

function listener(protocol: Listener["protocol"], destination: string, handler = CONSUMER): Listener {
  return { kind: "listener", name: `${protocol} ${destination}`, protocol, destination, handler };
}

function published(protocol: EventTarget["protocol"], destination: string, repo = "shop-web"): CallSite {
  return {
    repo,
    file: "src/main/java/app/Orders.java",
    line: 7,
    symbol: "Orders.publish",
    transport: "event",
    target: { status: "complete", value: { protocol, destination, role: "publish" }, evidence: [] },
  };
}

function eventTargetOf(call: CallSite): EventTarget {
  return call.target.status === "complete" && "protocol" in call.target.value ? call.target.value : ({} as EventTarget);
}

function consumed(result: ReturnType<typeof matchEventCallSite>): string {
  if (result.link === undefined) return result.ambiguous === undefined ? "none" : `ambiguous ${result.ambiguous.repos.join(",")}`;
  const { basis, confidence, transport, to } = result.link;
  return `${basis} ${confidence} ${transport} -> ${to.repo} ${to.kind} ${to.name} at ${to.handler.symbol}`;
}

function consumedBy(call: CallSite, listeners: readonly Listener[], repo = "orders"): string {
  return consumed(matchEventCallSite(call, eventTargetOf(call), [{ repo, entrypoints: listeners }]));
}

test("a published destination equal to a listener's is one link at full confidence, for every protocol that matches by destination", () => {
  for (const protocol of ["kafka", "rabbit", "jms", "event"] as const) {
    assert.equal(consumedBy(published(protocol, "orders.created"), [listener(protocol, "orders.created")]), `event-destination 1 event -> orders listener ${protocol} orders.created at OrdersListener.on`);
  }
});

test("a destination that differs in a literal token is no match", () => {
  assert.equal(consumedBy(published("kafka", "orders.refunded"), [listener("kafka", "orders.created")]), "none");
  assert.equal(consumedBy(published("nats", "orders.refunded"), [listener("nats", "orders.created")]), "none");
});

test("a listener of the repository that publishes is never a candidate", () => {
  const call = published("kafka", "orders.created", "orders");

  assert.equal(consumedBy(call, [listener("kafka", "orders.created")]), "none");
});

test("a listener that states another protocol does not consume the message", () => {
  assert.equal(consumedBy(published("kafka", "orders.created"), [listener("jms", "orders.created")]), "none");
});

test("a NATS listener token `*` stands for exactly one token", () => {
  assert.equal(consumedBy(published("nats", "orders.created"), [listener("nats", "orders.*")]), "event-destination 1 event -> orders listener nats orders.* at OrdersListener.on");
  assert.equal(consumedBy(published("nats", "orders.created.eu"), [listener("nats", "orders.*")]), "none");
});

test("a NATS listener token `>` stands for one or more trailing tokens", () => {
  assert.equal(consumedBy(published("nats", "orders.created.eu"), [listener("nats", "orders.>")]), "event-destination 1 event -> orders listener nats orders.> at OrdersListener.on");
  assert.equal(consumedBy(published("nats", "orders"), [listener("nats", "orders.>")]), "none");
});

test("a token the publisher fills at run time stands for exactly one listener token", () => {
  assert.equal(consumedBy(published("nats", "orders.{}.created"), [listener("nats", "orders.eu.created")]), "event-destination 1 event -> orders listener nats orders.eu.created at OrdersListener.on");
  assert.equal(consumedBy(published("nats", "orders.created"), [listener("nats", "orders.eu.created")]), "none");
});

test("a destination two repositories consume is a cut, never a pick", () => {
  const call = published("kafka", "orders.created");
  const shared: RepositoryEntrypoints[] = [
    { repo: "orders", entrypoints: [listener("kafka", "orders.created", { ...CONSUMER, symbol: "OrdersListener.on", line: 8 })] },
    { repo: "billing", entrypoints: [listener("kafka", "orders.created", { ...CONSUMER, symbol: "BillingListener.on", line: 3 })] },
  ];

  assert.equal(consumed(matchEventCallSite(call, eventTargetOf(call), shared)), "ambiguous billing,orders");
});

test("a destination one repository consumes with two listeners is a cut as well", () => {
  const call = published("kafka", "orders.created");

  assert.equal(consumedBy(call, [listener("kafka", "orders.created"), listener("kafka", "orders.created", { ...CONSUMER, symbol: "OrdersListener.audit", line: 20 })]), "ambiguous orders");
});
