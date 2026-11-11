import { test } from "node:test";
import assert from "node:assert/strict";
import type { Listener } from "../../domain/entrypoints/entrypoint.ts";
import type { HttpRoute } from "../../domain/entrypoints/http-route.ts";
import type { CallSite, EventTarget, HttpTarget } from "../../domain/topology/call-site.ts";
import type { RepositoryEntrypoints } from "../../domain/topology/link-match.ts";
import { excludedFrom, inferGateways, matchCallSite, matchDeclaredOperation, matchEventCallSite, prefixOf } from "../../domain/topology/link-match.ts";

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
  const [link] = result.links ?? [];
  if (link === undefined) {
    if (result.ambiguous !== undefined) return `ambiguous ${result.ambiguous.repos.join(",")}`;
    return result.undecided !== undefined ? `undecided ${result.undecided}` : result.external === true ? "external" : `none ${result.unmatched ?? ""}`.trim();
  }
  const { basis, confidence, profiles } = link;
  return `${basis} ${confidence}${profiles === undefined ? "" : ` ${profiles.join(",")}`} -> ${link.to.repo} ${link.to.name}`;
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
  assert.equal(result.links, undefined);
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

function published(protocol: EventTarget["protocol"], destination: string, repo = "shop-web", exchange?: string): CallSite {
  return {
    repo,
    file: "src/main/java/app/Orders.java",
    line: 7,
    symbol: "Orders.publish",
    transport: "event",
    target: { status: "complete", value: { protocol, destination, role: "publish", ...(exchange === undefined ? {} : { exchange }) }, evidence: [] },
  };
}

function eventTargetOf(call: CallSite): EventTarget {
  return call.target.status === "complete" && "protocol" in call.target.value ? call.target.value : ({} as EventTarget);
}

function consumed(result: ReturnType<typeof matchEventCallSite>): string {
  const answers = [
    ...(result.links ?? []).map(({ basis, confidence, transport, to }) => `${basis} ${confidence} ${transport} -> ${to.repo} ${to.kind} ${to.name} at ${to.handler.symbol}`),
    ...(result.undecided === undefined ? [] : [`could-match ${result.undecided}`]),
  ];
  if (answers.length > 0) return answers.join(" | ");
  return result.ambiguous === undefined ? "none" : `ambiguous ${result.ambiguous.repos.join(",")}`;
}

function consumedBy(call: CallSite, listeners: readonly Listener[], repo = "orders"): string {
  return consumed(matchEventCallSite(call, eventTargetOf(call), [{ repo, entrypoints: listeners }]));
}

test("a published destination equal to a listener's of another repository is one link at full confidence, for every cross-process protocol", () => {
  for (const protocol of ["kafka", "rabbit", "jms"] as const) {
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

test("an in-process application event reaches the listeners of the repository that publishes it, and no other repository's", () => {
  const call = published("event", "app.OrderPlaced", "orders");
  const repositories: RepositoryEntrypoints[] = [
    { repo: "orders", entrypoints: [listener("event", "app.OrderPlaced")] },
    { repo: "billing", entrypoints: [listener("event", "app.OrderPlaced", { ...CONSUMER, symbol: "BillingListener.on" })] },
  ];

  assert.equal(consumed(matchEventCallSite(call, eventTargetOf(call), repositories)), "event-destination 1 event -> orders listener event app.OrderPlaced at OrdersListener.on");
});

test("a destination with a part the publisher fills at run time could match a listener whose name that part may hold, never a silent miss", () => {
  assert.equal(consumedBy(published("kafka", "orders-{}"), [listener("kafka", "orders-eu")]), "could-match orders-{}");
  assert.equal(consumedBy(published("nats", "orders.created-{}"), [listener("nats", "orders.created-eu")]), "could-match orders.created-{}");
  assert.equal(consumedBy(published("kafka", "orders-{}"), [listener("kafka", "billing-eu")]), "none");
});

test("a listener subject with a part the subscriber fills at run time could match any token that part may hold", () => {
  assert.equal(consumedBy(published("nats", "orders.created"), [listener("nats", "orders.{}")]), "could-match orders.created");
});

test("a message some listeners consume and others could is their links plus one could-match, never a silent drop", () => {
  const call = published("nats", "orders.created");
  assert.equal(
    consumedBy(call, [listener("nats", "orders.*"), listener("nats", "orders.{}", { ...CONSUMER, symbol: "OrdersListener.audit", line: 20 })]),
    "event-destination 1 event -> orders listener nats orders.* at OrdersListener.on | could-match orders.created",
  );
});

test("a RabbitMQ message published to a named exchange reaches queues through bindings the snapshot does not read: it could match, never a link", () => {
  assert.equal(consumedBy(published("rabbit", "orders.created", "shop-web", "orders"), [listener("rabbit", "orders.created")]), "could-match orders.created");
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

test("a destination two repositories consume is one link per listener, since a published message reaches every subscriber", () => {
  const call = published("kafka", "orders.created");
  const shared: RepositoryEntrypoints[] = [
    { repo: "orders", entrypoints: [listener("kafka", "orders.created", { ...CONSUMER, symbol: "OrdersListener.on", line: 8 })] },
    { repo: "billing", entrypoints: [listener("kafka", "orders.created", { ...CONSUMER, symbol: "BillingListener.on", line: 3 })] },
  ];

  assert.equal(
    consumed(matchEventCallSite(call, eventTargetOf(call), shared)),
    "event-destination 1 event -> orders listener kafka orders.created at OrdersListener.on | event-destination 1 event -> billing listener kafka orders.created at BillingListener.on",
  );
});

test("a destination one repository consumes with two listeners is one link per listener as well", () => {
  const call = published("kafka", "orders.created");

  assert.equal(
    consumedBy(call, [listener("kafka", "orders.created"), listener("kafka", "orders.created", { ...CONSUMER, symbol: "OrdersListener.audit", line: 20 })]),
    "event-destination 1 event -> orders listener kafka orders.created at OrdersListener.on | event-destination 1 event -> orders listener kafka orders.created at OrdersListener.audit",
  );
});

test("an operation a contract declares lands on the route that serves it by an equal path or by the base path its configuration adds, and on two repositories it is ambiguous", () => {
  const target = (path: string): HttpTarget => ({ method: "GET", path });
  const prefixed = route("GET", "/orders/{id}", undefined, { contextPath: "/api" });
  const name = (match: ReturnType<typeof matchDeclaredOperation>) => (match !== undefined && "route" in match ? `${match.repo} ${match.route.name}` : match);
  assert.equal(name(matchDeclaredOperation(target("/orders/{orderId}"), repositories([prefixed]))), "orders GET /orders/{id}");
  assert.equal(name(matchDeclaredOperation(target("/api/orders/{orderId}"), repositories([prefixed]))), "orders GET /orders/{id}");
  assert.equal(name(matchDeclaredOperation(target("/api/orders/{id}"), repositories([route("GET", "/api/orders/{id}")]))), "orders GET /api/orders/{id}");
  assert.equal(matchDeclaredOperation(target("/other/{id}"), repositories([prefixed])), undefined);
  assert.deepEqual(matchDeclaredOperation(target("/api/orders/{id}"), [...repositories([prefixed]), ...repositories([prefixed], "billing")]), { ambiguous: ["billing", "orders"] });
});

test("an HTTP or event link starts at its call site's column only when the reader placed it", () => {
  const http = site("orders");
  const event = published("kafka", "orders.created");
  const httpFrom = (call: CallSite) => matchCallSite(call, targetOf(call), repositories([route("GET", "/orders")]), []).links?.map(link => link.from.column);
  const eventFrom = (call: CallSite) => matchEventCallSite(call, eventTargetOf(call), [{ repo: "orders", entrypoints: [listener("kafka", "orders.created")] }]).links?.map(link => link.from.column);

  assert.deepEqual([httpFrom(http), httpFrom({ ...http, column: 12 }), eventFrom(event), eventFrom({ ...event, column: 5 })], [[undefined], [12], [undefined], [5]]);
});

function handled(method: HttpRoute["method"], path: string, symbol: string, line: number): HttpRoute {
  return route(method, path, { path: "src/main/java/app/Catalog.java", symbol, line });
}

test("a segment the call fills partly at run time matches a route segment of the same shape, as a parity", () => {
  const call = site("/api/user-{}");

  assert.equal(joined(matchCallSite(call, targetOf(call), repositories([route("GET", "/api/user-{id}")]), [])), "exact 0.6 -> orders GET /api/user-{id}");
});

test("a route's `*` segment takes exactly one segment of the call", () => {
  const owners = repositories([route("GET", "/owners/*/pets/{petId}")]);

  assert.equal(joined(matchCallSite(site("/owners/7/pets/{}"), targetOf(site("/owners/7/pets/{}")), owners, [])), "exact 0.6 -> orders GET /owners/*/pets/{petId}");
  assert.equal(joined(matchCallSite(site("/owners/7/8/pets/{}"), targetOf(site("/owners/7/8/pets/{}")), owners, [])), "none /owners/7/8/pets/{}");
});

test("a route's `**` or `{*rest}` takes the rest of the call's path, none of it included", () => {
  const files = repositories([route("GET", "/files/**"), route("GET", "/docs/{*path}"), route("GET", "/assets/img/**")]);
  const name = (path: string) => joined(matchCallSite(site(path), targetOf(site(path)), files, []));

  assert.equal(name("/files/a/b"), "exact 1 -> orders GET /files/**");
  assert.equal(name("/docs"), "exact 1 -> orders GET /docs/{*path}");
  assert.equal(name("/other/a"), "none /other/a");
  assert.equal(name("/assets"), "none /assets");
});

test("a route segment that states part of the call's text wins over a bare parameter there", () => {
  const call = site("/api/user-7");
  const routes = [handled("GET", "/api/{id}", "Users.byId", 1), handled("GET", "/api/user-{id}", "Users.user", 2)];

  assert.equal(joined(matchCallSite(call, targetOf(call), repositories(routes), [])), "exact 1 -> orders GET /api/user-{id}");
  assert.equal(joined(matchCallSite(call, targetOf(call), repositories([...routes].reverse()), [])), "exact 1 -> orders GET /api/user-{id}");
});

test("a value the call fills at run time never stands for a literal segment the route names, on any rung", () => {
  const latest = repositories([route("GET", "/api/orders/latest")], "shop-api");

  assert.equal(joined(matchCallSite(site("/api/orders/{}"), targetOf(site("/api/orders/{}")), latest, [])), "none /api/orders/{}");
  assert.equal(joined(matchCallSite(site("/orders/{}"), targetOf(site("/orders/{}")), latest, [])), "none /orders/{}");
});

test("on the suffix rung a route parameter takes a literal of the call, whichever path is longer", () => {
  const call = site("/v1/user/DEFAULT/reset/{}");

  assert.equal(joined(matchCallSite(call, targetOf(call), repositories([route("GET", "/api/v1/user/{store}/reset/{token}")]), [])), "suffix 0.5 -> orders GET /api/v1/user/{store}/reset/{token}");
});

test("a suffix match needs one literal segment both paths state", () => {
  const call = site("/v1/manufacturers/{}");

  assert.equal(joined(matchCallSite(call, targetOf(call), repositories([route("GET", "/static/files/{store}/{type}/{name}")]), [])), "none /v1/manufacturers/{}");
});

test("a call that states its origin states its whole path, so a longer route cannot end with it; a relative call still can", () => {
  const owners = repositories([route("GET", "/api/owners/{ownerId}")]);
  const absolute = site("/owners/{}", "GET", "http://customers-service");
  const inPath = site("http://customers-service/owners/{}");
  const relative = site("/owners/{}");

  assert.equal(joined(matchCallSite(absolute, targetOf(absolute), owners, [])), "external");
  assert.equal(joined(matchCallSite(inPath, targetOf(inPath), owners, [])), "external");
  assert.equal(joined(matchCallSite(relative, targetOf(relative), owners, [])), "suffix 0.5 -> orders GET /api/owners/{ownerId}");
});

test("a gateway prefix whose removal leaves no literal the route states is no evidence: nothing is inferred and a declared one links nothing", () => {
  const call = site("http://vets-service/vets");
  const root = repositories([route("ANY", "/")], "clinic");

  assert.deepEqual(inferGateways([call], root, []), []);
  assert.equal(joined(matchCallSite(call, targetOf(call), root, [{ prefix: "vets", repo: "clinic", basis: "gateway-prefix" }])), "none http://vets-service/vets");
});

test("two routes of one repository that take a call equally are ambiguous, naming both routes, never a pick", () => {
  const call = site("/category/{}");
  const result = matchCallSite(call, targetOf(call), repositories([handled("GET", "/category/{id}", "Catalog.byId", 3), handled("GET", "/category/{friendlyUrl}", "Catalog.byUrl", 9)]), []);

  assert.equal(result.links, undefined);
  assert.deepEqual(result.ambiguous, { key: "category", repos: ["orders"], routes: ["GET /category/{friendlyUrl}", "GET /category/{id}"] });
});

test("a route that states the call's verb wins over one that names none, whatever the order they are declared in", () => {
  const call = site("/orders", "POST");
  const routes = [handled("ANY", "/orders", "Orders.any", 1), handled("POST", "/orders", "Orders.create", 2)];

  assert.equal(joined(matchCallSite(call, targetOf(call), repositories(routes), [])), "exact 1 -> orders POST /orders");
  assert.equal(joined(matchCallSite(call, targetOf(call), repositories([...routes].reverse()), [])), "exact 1 -> orders POST /orders");
});

test("a literal of the call that fills a route parameter keeps full confidence; a value filled at run time is a parity", () => {
  const orders = repositories([route("GET", "/orders/{id}")]);

  assert.equal(joined(matchCallSite(site("/orders/7"), targetOf(site("/orders/7")), orders, [])), "exact 1 -> orders GET /orders/{id}");
  assert.equal(joined(matchCallSite(site("/orders/{}"), targetOf(site("/orders/{}")), orders, [])), "exact 0.6 -> orders GET /orders/{id}");
});

test("a call that matches no route is unmatched when it states no host, and external when it names one", () => {
  const orders = repositories([route("GET", "/orders")], "shop-api");
  const relative = site("/geo/provinces");
  const hosted = site("https://geo.example/provinces");
  const hostedByBase = site("/provinces", "GET", "https://geo.example");

  assert.deepEqual(matchCallSite(relative, targetOf(relative), orders, []), { unmatched: "/geo/provinces" });
  assert.deepEqual(matchCallSite(hosted, targetOf(hosted), orders, []), { external: true });
  assert.deepEqual(matchCallSite(hostedByBase, targetOf(hostedByBase), orders, []), { external: true });
  const runTimeHost = site("/provinces", "GET", "http://");
  assert.deepEqual(matchCallSite(runTimeHost, targetOf(runTimeHost), orders, []), { unmatched: "/provinces" });
});

test("a segment the call fills partly that some route text could hold is undecided, and so is a later rung's match behind it", () => {
  const call = site("/api/user-{}");
  const admin = repositories([route("GET", "/api/user-admin")], "shop-api");

  assert.deepEqual(matchCallSite(call, targetOf(call), admin, []), { undecided: "/api/user-{}" });
  assert.deepEqual(matchCallSite(call, targetOf(call), [...admin, ...repositories([route("GET", "/user-{id}")], "users")], []), { undecided: "/api/user-{}" });
});

test("a call may reach an operation through a gateway prefix, a configured base path or a suffix, and through no rung once its template matches nothing (ADR-0042 fixture 7)", () => {
  const reaches = (method: string, template: string, served: HttpRoute, gateways: Parameters<typeof excludedFrom>[2] = [], repo = "orders") =>
    !excludedFrom(served.name, repositories([served], repo), gateways)({ kind: "call-site", transport: "http", method, template });
  assert.equal(reaches("POST", "orders-api/orders", route("POST", "/orders"), [{ prefix: "orders-api", repo: "orders", basis: "gateway-prefix" }]), true);
  assert.equal(reaches("GET", "billing/orders", route("GET", "/orders", undefined, { contextPath: "/billing" })), true);
  assert.equal(reaches("GET", "restaurants/daily-menus", route("GET", "/daily-menus")), true);
  assert.equal(reaches("GET", "orders/{id}", route("GET", "/orders/{orderId}")), true);
  assert.equal(reaches("GET", "invoices/latest", route("GET", "/orders")), false);
  assert.equal(reaches("POST", "/orders", route("GET", "/orders")), false);
  assert.equal(reaches("GET", "https://pay.example.test/orders/x", route("GET", "/orders"), [], "shop"), false);
});

test("a call site is excluded only by positive route proof, keeping an unknown path for a compatible method", () => {
  const routes = repositories([route("GET", "/orders"), route("GET", "/invoices")]);
  const excludes = excludedFrom("GET /orders", routes, []);
  assert.equal(excludes({ kind: "call-site", transport: "http", method: "GET", template: "/invoices" }), true);
  assert.equal(excludes({ kind: "call-site", transport: "http", method: "GET", template: "/orders" }), false);
  assert.equal(excludes({ kind: "call-site", transport: "http", method: "GET" }), false);
  assert.equal(excludes({ kind: "call-site", transport: "http", method: "POST" }), true);
  assert.equal(excludedFrom("GET /absent", routes, [])({ kind: "call-site", transport: "http", method: "POST" }), false);
  assert.equal(excludedFrom("ANY /orders", repositories([route("ANY", "/orders")]), [])({ kind: "call-site", transport: "http", method: "POST" }), false);
  assert.equal(excludes({ kind: "call-site", transport: "http", template: "/invoices" }), false);
});
