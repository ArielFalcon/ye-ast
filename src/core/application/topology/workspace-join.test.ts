import { test } from "node:test";
import assert from "node:assert/strict";
import type { Listener } from "../../domain/entrypoints/entrypoint.ts";
import type { HttpRoute } from "../../domain/entrypoints/http-route.ts";
import type { CallSite, EventTarget } from "../../domain/topology/call-site.ts";
import type { RequestUrlPart } from "../../domain/topology/request-url.ts";
import type { WorkspaceRepository } from "../../ports/workspace-repos.port.ts";
import { entrypointsOf, joinWorkspace, linkMapOf } from "./workspace-join.ts";

function publishing(repo: string, target: EventTarget): CallSite {
  return { repo, file: "src/main/java/app/Orders.java", line: 7, symbol: "Orders.publish", transport: "event", target: { status: "complete", value: target, evidence: [] } };
}

function listening(protocol: Listener["protocol"], destination: string, symbol: string): Listener {
  return { kind: "listener", name: `${protocol} ${destination}`, protocol, destination, handler: { path: "src/main/java/app/Listeners.java", symbol, line: 3 } };
}

function repository(repo: string, callSites: readonly CallSite[], entrypoints: readonly (Listener | HttpRoute)[]): WorkspaceRepository {
  return { repo, snapshot: { repo, kind: "sha", sha: "a".repeat(40) }, callSites, entrypoints: entrypoints.map((value) => ({ status: "complete", value, evidence: [] })) };
}

function joined(repositories: readonly WorkspaceRepository[], gateways: readonly { prefix: string; repo: string }[] = []): ReturnType<typeof linkMapOf> {
  return linkMapOf(joinWorkspace(repositories, repositories.map(entrypointsOf), gateways).joined);
}

const UNDECIDED_BASE: RequestUrlPart = { kind: "unknown", cause: "destination-undecidable", evidence: [{ path: "src/app/api.service.ts", line: 9 }] };

/** A request whose base URL the snapshot does not decide, with the URL parts the code states after it. */
function requesting(method: HttpRoute["method"], ...parts: readonly RequestUrlPart[]): CallSite {
  return {
    repo: "web",
    file: "src/app/profiles.api.ts",
    line: 11,
    symbol: "ProfilesApi.follow",
    transport: "http",
    target: { status: "unknown", reason: "unresolved", evidence: [] },
    stated: { method, expressions: [parts] },
  };
}

function serving(method: HttpRoute["method"], path: string, symbol: string): HttpRoute {
  return { kind: "http-route", name: `${method} ${path}`, method, path, handler: { path: "src/main/java/app/Api.java", symbol, line: 5 }, basePath: { status: "complete", value: { default: {}, profiles: {} }, evidence: [] } };
}

const text = (value: string): RequestUrlPart => ({ kind: "text", text: value });
const RUNTIME: RequestUrlPart = { kind: "runtime" };

function described({ links, unlinked }: ReturnType<typeof linkMapOf>): string[] {
  return [
    ...links.map(({ to, basis, confidence, authority }) => `link ${to.repo} ${to.name} ${basis} ${confidence} ${authority ?? "decided"}`),
    ...unlinked.map(({ outcome, repos }) => `${outcome} ${(repos ?? []).join(",")}`.trim()),
  ];
}

test("the join links an in-process application event to the listener of its own repository", () => {
  const orders = repository("orders", [publishing("orders", { protocol: "event", destination: "app.OrderPlaced", role: "publish" })], [listening("event", "app.OrderPlaced", "Audit.on")]);

  assert.deepEqual(joined([orders]).links.map(({ from, to }) => `${from.repo} -> ${to.repo} ${to.handler.symbol}`), ["orders -> orders Audit.on"]);
});

test("a published message some listeners consume and another could keeps its links and is one could-match item", () => {
  const shop = repository("shop", [publishing("shop", { protocol: "nats", destination: "orders.created", role: "publish" })], []);
  const orders = repository("orders", [], [listening("nats", "orders.*", "Orders.on"), listening("nats", "orders.{}", "Orders.audit")]);

  const { links, unlinked } = joined([shop, orders]);

  assert.deepEqual([links.map(({ to }) => to.handler.symbol), unlinked.map(({ outcome, name }) => `${outcome} ${name}`)], [["Orders.on"], ["could-match orders.created"]]);
});

test("a request whose route is stated and whose base is undecided links to the one route that ends with it, at suffix confidence", () => {
  const web = repository("web", [requesting("POST", UNDECIDED_BASE, text("/profiles/"), RUNTIME, text("/follow"))], []);
  const api = repository("api", [], [serving("POST", "/api/profiles/{username}/follow", "Profiles.follow"), serving("DELETE", "/api/profiles/{username}/follow", "Profiles.unfollow")]);

  assert.deepEqual(described(joined([web, api])), ["link api POST /api/profiles/{username}/follow suffix 0.5 undecided"]);
});

test("a request with an undecided base reads its route without the query or the fragment it writes", () => {
  const queried = requesting("GET", UNDECIDED_BASE, text("/restaurants-api/restaurants/daily-menus?restaurantId="), RUNTIME);
  const anchored = requesting("GET", UNDECIDED_BASE, text("/restaurants-api/restaurants/daily-menus#today"));
  const api = repository("api", [], [serving("GET", "/restaurants/daily-menus", "Restaurants.dailyMenus")]);

  assert.deepEqual([queried, anchored].map((site) => described(joined([repository("web", [site], []), api]))), [["link api GET /restaurants/daily-menus suffix 0.5 undecided"], ["link api GET /restaurants/daily-menus suffix 0.5 undecided"]]);
});

test("a request with an undecided base that two repositories serve is ambiguous, never a link", () => {
  const web = repository("web", [requesting("GET", UNDECIDED_BASE, text("/orders/"), RUNTIME)], []);
  const orders = repository("orders", [], [serving("GET", "/orders/{id}", "Orders.get")]);
  const archive = repository("archive", [], [serving("GET", "/v1/orders/{id}", "Archive.get")]);

  assert.deepEqual(described(joined([web, orders, archive])), ["ambiguous archive,orders"]);
});

test("a request with an undecided base joins nothing when no stated segment agrees as text or another value is undecided", () => {
  const holesOnly = requesting("GET", UNDECIDED_BASE, text("/"), RUNTIME);
  const undecidedMiddle = requesting("GET", UNDECIDED_BASE, text("/orders/"), UNDECIDED_BASE);
  const api = repository("api", [], [serving("GET", "/{section}", "Api.section"), serving("GET", "/orders/{id}", "Orders.get")]);

  assert.deepEqual([holesOnly, undecidedMiddle].map((site) => described(joined([repository("web", [site], []), api]))), [[], []]);
});

test("a request with an undecided base under a gateway prefix links only to the repository the prefix routes to, at suffix confidence", () => {
  const web = repository("web", [requesting("POST", UNDECIDED_BASE, text("/orders-api/orders/checkout"))], []);
  const orders = repository("orders", [], [serving("POST", "/orders/checkout", "Orders.checkout")]);
  const legacy = repository("legacy", [], [serving("POST", "/orders/checkout", "Legacy.checkout")]);
  const repositories = [web, orders, legacy];

  const inferred = joinWorkspace([web, orders], [web, orders].map(entrypointsOf), []).gateways;

  assert.deepEqual([described(joined(repositories, [{ prefix: "orders-api", repo: "orders" }])), inferred], [["link orders POST /orders/checkout suffix 0.5 undecided"], [{ prefix: "orders-api", repo: "orders", basis: "route-overlap" }]]);
});

function alternatives(method: HttpRoute["method"], ...expressions: readonly (readonly RequestUrlPart[])[]): CallSite {
  const site = requesting(method);
  return { ...site, stated: { method, expressions } };
}

test("a request that states several URL expressions links each one that states its route, once per route", () => {
  const api = repository("api", [], [serving("GET", "/api/articles/feed", "Articles.feed"), serving("GET", "/api/articles", "Articles.list")]);
  const both = repository("web", [alternatives("GET", [UNDECIDED_BASE, text("/articles/feed")], [UNDECIDED_BASE, text("/articles")])], []);
  const same = repository("web", [alternatives("GET", [UNDECIDED_BASE, text("/articles"), RUNTIME], [UNDECIDED_BASE, text("/articles")])], []);
  const onlyFeed = repository("web", [alternatives("GET", [UNDECIDED_BASE, text("/articles/feed")], [UNDECIDED_BASE, text("/articles/feed")])], []);

  assert.deepEqual(described(joined([both, api])), ["link api GET /api/articles suffix 0.5 undecided", "link api GET /api/articles/feed suffix 0.5 undecided"]);
  assert.equal(described(joined([onlyFeed, api])).length, 1);
  assert.equal(described(joined([same, repository("api", [], [serving("GET", "/api/articles", "Articles.list")])])).length, 1);
});

test("an alternative that is ambiguous across repositories does not block the alternative that links", () => {
  const web = repository("web", [alternatives("GET", [UNDECIDED_BASE, text("/orders/"), RUNTIME], [UNDECIDED_BASE, text("/profiles/me")])], []);
  const orders = repository("orders", [], [serving("GET", "/orders/{id}", "Orders.get")]);
  const archive = repository("archive", [], [serving("GET", "/v1/orders/{id}", "Archive.get")]);
  const profiles = repository("profiles", [], [serving("GET", "/api/profiles/me", "Profiles.me")]);

  assert.deepEqual(described(joined([web, orders, archive, profiles])), ["link profiles GET /api/profiles/me suffix 0.5 undecided", "ambiguous archive,orders"]);
});

function hosted(repo: string, url: string): CallSite {
  return { repo, file: "src/app/shop.api.ts", line: 4, symbol: "ShopApi.call", transport: "http", target: { status: "complete", value: { method: "GET", path: url }, evidence: [] } };
}

test("a request to an origin the workspace links into, matching no route, is listed unmatched with its URL; a never-linked origin stays out of the list", () => {
  const shop = repository("shop", [], [serving("GET", "/orders", "Orders.list")]);
  const web = repository("web", [
    hosted("web", "http://localhost:8080/orders"),
    hosted("web", "http://localhost:8080/refunds"),
    hosted("web", "http://localhost:9090/refunds"),
  ], []);

  const { links, unlinked } = joined([shop, web]);

  assert.deepEqual(links.map(({ to }) => to.name), ["GET /orders"]);
  assert.deepEqual(unlinked.map(({ outcome, name }) => `${outcome} ${name}`), ["unmatched http://localhost:8080/refunds"]);
});

/** A request that states its path in full, as a client call to a service of the workspace. */
function calling(path: string, method: HttpRoute["method"] = "GET"): CallSite {
  return { repo: "web", file: "src/app/menus.service.ts", line: 4, symbol: "MenusService.load", transport: "http", target: { status: "complete", value: { method, path }, evidence: [] } };
}

function typed(route: HttpRoute, parameterTypes: NonNullable<HttpRoute["parameterTypes"]>): HttpRoute {
  return { ...route, parameterTypes };
}

test("a link whose literal segment fills a producer variable of a type that cannot parse it stays and carries the drift", () => {
  const web = repository("web", [calling("/restaurants/daily-menus"), calling("/private/product/new", "PUT")], []);
  const api = repository("api", [], [
    typed(serving("GET", "/restaurants/{id}", "Restaurants.get"), { id: "UUID" }),
    typed(serving("PUT", "/private/product/{productId}", "Products.update"), { productId: "Long" }),
  ]);

  assert.deepEqual(joined([web, api]).links.map(({ to, drift }) => [to.name, drift]), [
    ["GET /restaurants/{id}", [{ segment: "daily-menus", parameter: "id", type: "UUID" }]],
    ["PUT /private/product/{productId}", [{ segment: "new", parameter: "productId", type: "Long" }]],
  ]);
});

test("a link carries no drift when the literal parses, the variable is untyped or the value is filled at run time", () => {
  const web = repository("web", [calling("/private/product/42"), calling("/names/daily-menus"), calling("/restaurants/{}")], []);
  const api = repository("api", [], [
    typed(serving("GET", "/private/product/{id}", "Products.get"), { id: "Long" }),
    serving("GET", "/names/{name}", "Names.get"),
    typed(serving("GET", "/restaurants/{id}", "Restaurants.get"), { id: "UUID" }),
  ]);

  const { links } = joined([web, api]);

  assert.deepEqual(links.map(({ to, drift }) => [to.name, drift]), [
    ["GET /names/{name}", undefined],
    ["GET /private/product/{id}", undefined],
    ["GET /restaurants/{id}", undefined],
  ]);
});

test("two propagated sites that make one link carry the bodies of both, once each and in place order", () => {
  const site = requesting("GET", UNDECIDED_BASE, text("/restaurants/daily-menus"));
  const later = { kind: "body", file: "src/app/b.ts", line: 4, column: 3 } as const;
  const earlier = { kind: "body", file: "src/app/a.ts", line: 9, column: 1 } as const;
  const api = repository("api", [], [serving("GET", "/restaurants/daily-menus", "Restaurants.dailyMenus")]);
  const { links } = joined([repository("web", [{ ...site, propagatedThrough: [later] }, { ...site, propagatedThrough: [earlier, later] }], []), api]);

  assert.deepEqual(links.map((link) => link.propagatedThrough), [[earlier, later]]);
});
