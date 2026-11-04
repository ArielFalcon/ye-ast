import { test } from "node:test";
import assert from "node:assert/strict";
import type { Seed, ReachedEntrypoint } from "../../domain/impact/impact-fact.ts";
import { handlerKey, reachedBy } from "../../domain/topology/link-graph.ts";
import type { CallSite } from "../../domain/topology/call-site.ts";
import { createHttpCallSites } from "./http-call-sites.adapter.ts";

const reader = createHttpCallSites();

function source(path: string, content: string): { path: string; content: string } {
  return { path, content };
}

const API = "src/app/core/rest/services/client/rest-client.service.ts";

test("HTTP sites carry their actual named AST ancestors", async () => {
  const component = source("src/client.ts", ["import { HttpClient } from '@angular/common/http'", "class Client {", "  constructor(private http: HttpClient) {}", "  send() {", "    function nested() {", "      this.http.get('/orders')", "    }", "  }", "}"].join("\n"));
  const [site] = await reader.of([component], "web");
  assert.deepEqual(site?.ancestors, [{ symbol: "nested", line: 5, endLine: 7 }, { symbol: "send", line: 4, endLine: 8 }, { symbol: "Client", line: 2, endLine: 9 }]);
});

test("inbound joins use a named nested function's owner instead of its enclosing method", async () => {
  const component = source("src/client.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Client {",
    "  constructor(private http: HttpClient) {}",
    "  send() {",
    "    const nested = () => this.http.get('/orders')",
    "    const callback = function inner() { return this.http.get('/products') }",
    "  }",
    "}",
  ].join("\n"));
  const sites = await reader.of([component], "web");
  const handler = { path: "src/controller.ts", symbol: "Controller.get", line: 3 };
  const reached: ReachedEntrypoint = { kind: "http-route", name: "GET /orders", handler, depth: 1, confidence: 1, seeds: [0] };
  const outer: Seed = { file: component.path, symbol: "send", line: 4, endLine: 7, basis: "requested" };
  assert.deepEqual(sites.map((site) => site.symbol), ["Client.nested", "Client.inner"]);
  assert.deepEqual(sites[0]?.ancestors?.map((ancestor) => ancestor.symbol), ["nested", "send", "Client"]);
  assert.deepEqual(sites[1]?.ancestors?.map((ancestor) => ancestor.symbol), ["inner", "callback", "send", "Client"]);
  assert.equal(reachedBy([outer], [reached], sites).size, 0);
  for (const [index, symbol] of ["nested", "inner"].entries()) {
    const line = index + 5;
    const seed: Seed = { ...outer, symbol, line, endLine: line };
    assert.deepEqual(reachedBy([seed], [reached], sites).get(handlerKey(handler)), [sites[index]]);
  }
});

/** The rest client of a project: its methods take the path and reach `HttpClient`, so they are wrappers. */
const REST_CLIENT = [
  "import { HttpClient } from '@angular/common/http'",
  "import { inject, Injectable } from '@angular/core'",
  "@Injectable({ providedIn: 'root' })",
  "export class RestClientService {",
  "  private readonly http = inject(HttpClient)",
  "  get(path: string): void {",
  "    this.http.get(path)",
  "  }",
  "  post(path: string, body: unknown): void {",
  "    this.http.post(path, body)",
  "  }",
  "}",
].join("\n");

function sites(callSites: readonly CallSite[]): string[] {
  return callSites.map((site) => {
    if (site.target.status === "unknown") return `unknown ${site.target.reason}@${site.file}:${site.line}`;
    const target = site.target.value;
    return "path" in target ? `${target.method} ${target.path}${target.base === undefined ? "" : ` via ${target.base}`}@${site.file}:${site.line}` : `${target.protocol} ${target.destination}@${site.file}:${site.line}`;
  });
}

test("a verb of HttpClient that a component calls is a call site with its method and path", async () => {
  const component = source(
    "src/app/app.component.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "export class AppComponent {", "  private readonly http = inject(HttpClient)", "  load(): void {", "    this.http.get('orders/7')", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([component], "shop-web")), ["GET orders/7@src/app/app.component.ts:6"]);
});

test("a path exported by another file resolves through the import, and a template literal composes it", async () => {
  const api = source("src/app/order/api/order.api.ts", ["export const ORDER_BASE_URL = 'orders-api/'", "export const ORDERS_PATH = `${ORDER_BASE_URL}orders`", "export const ORDERS_CHECKOUT_PATH = `${ORDERS_PATH}/checkout`"].join("\n"));
  const caller = source(
    "src/app/order/order.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { ORDERS_CHECKOUT_PATH } from './api/order.api'", "export class OrderService {", "  constructor(private http: HttpClient) {}", "  checkout(): void {", "    this.http.post(ORDERS_CHECKOUT_PATH, {})", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([api, caller], "shop-web")), ["POST orders-api/orders/checkout@src/app/order/order.service.ts:6"]);
});

test("a parameter the code fills at run time is a placeholder: `${expr}` and `:name` are both `{}`", async () => {
  const component = source(
    "src/app/app.component.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "export class AppComponent {", "  private readonly http = inject(HttpClient)", "  load(orderId: string, page: number): void {", "    this.http.get(`orders/${orderId}/lines?page=${page}`)", "    this.http.delete('orders/:id')", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([component], "shop-web")), ["GET orders/{}/lines@src/app/app.component.ts:6", "DELETE orders/{}@src/app/app.component.ts:7"]);
});

test("a path part that names a field of the class is the value its initializer states", async () => {
  const service = source(
    "src/app/order/order.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "export class OrderService {", "  private readonly base = 'shop-api'", "  private readonly http = inject(HttpClient)", "  load(): void {", "    this.http.get(`${this.base}/orders/7`)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([service], "shop-web")), ["GET shop-api/orders/7@src/app/order/order.service.ts:7"]);
});

test("a path part that names a static member is the value its initializer states", async () => {
  const service = source(
    "src/app/order/order.api.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "export class OrderApi {", "  private static readonly BASE = 'shop-api'", "  private readonly http = inject(HttpClient)", "  load(): void {", "    this.http.get(`${OrderApi.BASE}/orders`)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([service], "shop-web")), ["GET shop-api/orders@src/app/order/order.api.ts:7"]);
});

test("a field whose initializer the snapshot does not decide keeps the path undecided", async () => {
  const service = source(
    "src/app/order/order.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "export class OrderService {", "  private readonly base = this.pick()", "  private readonly http = inject(HttpClient)", "  private pick(): string { return 'shop-api' }", "  load(): void {", "    this.http.get(`${this.base}/orders`)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([service], "shop-web")), ["unknown unresolved@src/app/order/order.service.ts:8"]);
});

test("a static member of an imported class resolves through the import", async () => {
  const api = source("src/app/order/order.api.ts", ["export class OrderApi {", "  static readonly BASE = 'shop-api'", "}"].join("\n"));
  const service = source(
    "src/app/order/order.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "import { OrderApi } from './order.api'", "export class OrderService {", "  private readonly http = inject(HttpClient)", "  load(): void {", "    this.http.get(`${OrderApi.BASE}/orders`)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([api, service], "shop-web")), ["GET shop-api/orders@src/app/order/order.service.ts:7"]);
});

test("a name a barrel re-exports with `export *` resolves through it", async () => {
  const orders = source("src/app/api/orders.ts", "export const ORDERS = 'orders-api/orders'");
  const barrel = source("src/app/api/index.ts", "export * from './orders'");
  const service = source(
    "src/app/order/order.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "import { ORDERS } from '../api'", "export class OrderService {", "  private readonly http = inject(HttpClient)", "  load(): void {", "    this.http.get(ORDERS)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([orders, barrel, service], "shop-web")), ["GET orders-api/orders@src/app/order/order.service.ts:7"]);
});

test("a name a barrel re-exports by name resolves through it", async () => {
  const orders = source("src/app/api/orders.ts", "export const ORDERS = 'orders-api/orders'");
  const barrel = source("src/app/api/index.ts", "export { ORDERS } from './orders'");
  const service = source(
    "src/app/order/order.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "import { ORDERS } from '../api'", "export class OrderService {", "  private readonly http = inject(HttpClient)", "  load(): void {", "    this.http.get(ORDERS)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([orders, barrel, service], "shop-web")), ["GET orders-api/orders@src/app/order/order.service.ts:7"]);
});

test("a member read through a namespace import resolves", async () => {
  const paths = source("src/app/api/paths.ts", "export const ORDERS = 'orders-api/orders'");
  const service = source(
    "src/app/order/order.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "import * as api from '../api/paths'", "export class OrderService {", "  private readonly http = inject(HttpClient)", "  load(): void {", "    this.http.get(api.ORDERS)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([paths, service], "shop-web")), ["GET orders-api/orders@src/app/order/order.service.ts:7"]);
});

test("a member of a default-exported object resolves", async () => {
  const environment = source("src/environments/environment.ts", "export default { apiUrl: 'shop-api' }");
  const service = source(
    "src/app/order/order.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "import environment from '../../environments/environment'", "export class OrderService {", "  private readonly http = inject(HttpClient)", "  load(): void {", "    this.http.get(`${environment.apiUrl}/orders`)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([environment, service], "shop-web")), ["GET shop-api/orders@src/app/order/order.service.ts:7"]);
});

test("a path two literals add resolves", async () => {
  const service = source(
    "src/app/order/order.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "const BASE = 'orders-api'", "export class OrderService {", "  private readonly http = inject(HttpClient)", "  load(): void {", "    this.http.get(BASE + '/orders')", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([service], "shop-web")), ["GET orders-api/orders@src/app/order/order.service.ts:7"]);
});

test("a barrel cycle is undecided, never a hang", async () => {
  const a = source("src/app/api/a.ts", "export * from './b'");
  const b = source("src/app/api/b.ts", "export * from './a'");
  const service = source(
    "src/app/order/order.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "import { ORDERS } from './api/a'", "export class OrderService {", "  private readonly http = inject(HttpClient)", "  load(): void {", "    this.http.get(ORDERS)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([a, b, service], "shop-web")), ["unknown unresolved@src/app/order/order.service.ts:7"]);
});

test("a parameter that shadows a const of the file is still a value the code fills at run time", async () => {
  const service = source(
    "src/app/order/order.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "const BASE = 'orders-api'", "export class OrderService {", "  private readonly http = inject(HttpClient)", "  load(BASE: string): void {", "    this.http.get(`${BASE}/orders`)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([service], "shop-web")), ["GET {}/orders@src/app/order/order.service.ts:7"]);
});

test("a const a method declares with a literal initializer resolves", async () => {
  const service = source(
    "src/app/order/order.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "export class OrderService {", "  private readonly http = inject(HttpClient)", "  load(): void {", "    const base = 'orders-api'", "    this.http.get(`${base}/orders`)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([service], "shop-web")), ["GET orders-api/orders@src/app/order/order.service.ts:7"]);
});

test("a path part imported from a module the snapshot does not hold is undecided, never a value the code fills at run time", async () => {
  const service = source(
    "src/app/order/order.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "import { BASE } from './missing.api'", "export class OrderService {", "  private readonly http = inject(HttpClient)", "  load(): void {", "    this.http.get(`${BASE}/orders`)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([service], "shop-web")), ["unknown unresolved@src/app/order/order.service.ts:7"]);
});

test("a variable a method declares from its own parameter is still a value the code fills at run time", async () => {
  const service = source(
    "src/app/order/order.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "export class OrderService {", "  private readonly http = inject(HttpClient)", "  load(orderId: string): void {", "    const url = orderId", "    this.http.get(`${url}/lines`)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([service], "shop-web")), ["GET {}/lines@src/app/order/order.service.ts:7"]);
});

test("a path held as a member of a constant object literal still resolves", async () => {
  const service = source(
    "src/app/order/order.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "const PATHS = { orders: 'orders-api/orders' }", "export class OrderService {", "  private readonly http = inject(HttpClient)", "  load(): void {", "    this.http.get(PATHS.orders)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([service], "shop-web")), ["GET orders-api/orders@src/app/order/order.service.ts:7"]);
});

test("a call through a wrapper the repository declares is a call site: the wrapper's own parameter is the path", async () => {
  const component = source(
    "src/app/order/order.api.ts",
    ["import { inject } from '@angular/core'", "import { RestClientService } from '@core/rest'", "export const ORDERS_PATH = 'orders-api/orders'", "export class OrderApi {", "  private readonly rest = inject(RestClientService)", "  create(): void {", "    this.rest.post(ORDERS_PATH, {})", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([source(API, REST_CLIENT), component], "shop-web")), ["POST orders-api/orders@src/app/order/order.api.ts:7"]);
});

test("a path the snapshot does not decide is an unknown target at the call, never a guessed path", async () => {
  const component = source(
    "src/app/app.component.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "export class AppComponent {", "  private readonly http = inject(HttpClient)", "  load(path: string): void {", "    this.http.get(path)", "  }", "}"].join("\n"),
  );

  const found = await reader.of([component], "shop-web");

  assert.deepEqual(sites(found), ["unknown unresolved@src/app/app.component.ts:6"]);
  assert.deepEqual(found[0]?.target.status === "unknown" ? found[0].target.evidence : [], [{ path: "src/app/app.component.ts", line: 6 }]);
});

test("a base URL the call declares is carried beside the path", async () => {
  const component = source(
    "src/app/app.component.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "const DIRECTIONS_URL = 'https://maps.example.com/directions'", "export class AppComponent {", "  private readonly http = inject(HttpClient)", "  route(): void {", "    this.http.get('/route', { baseUrl: DIRECTIONS_URL })", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([component], "shop-web")), ["GET /route via https://maps.example.com/directions@src/app/app.component.ts:7"]);
});

/** A component that holds `HttpClient` and makes the request the body lines state. */
function component(...body: string[]): { path: string; content: string } {
  return source(
    "src/app/app.component.ts",
    ["import { HttpClient, HttpRequest, httpResource } from '@angular/common/http'", "import { inject } from '@angular/core'", "export class AppComponent {", "  private readonly http = inject(HttpClient)", "  load(method: string): void {", ...body, "  }", "}"].join("\n"),
  );
}

test("a request with an explicit method takes the method from its first argument and the path from its second", async () => {
  assert.deepEqual(sites(await reader.of([component("    this.http.request('PUT', '/orders/7')")], "shop-web")), ["PUT /orders/7@src/app/app.component.ts:6"]);
});

test("a request whose method the snapshot does not decide is an unknown target, never a guessed method", async () => {
  assert.deepEqual(sites(await reader.of([component("    this.http.request(method, '/orders/7')")], "shop-web")), ["unknown unresolved@src/app/app.component.ts:6"]);
});

test("a request sent as an HttpRequest takes its method and path from the request it constructs", async () => {
  assert.deepEqual(sites(await reader.of([component("    this.http.request(new HttpRequest('DELETE', '/orders/7'))")], "shop-web")), ["DELETE /orders/7@src/app/app.component.ts:6"]);
});

test("an httpResource is a call site: a URL its function returns is a GET, a request object states its method", async () => {
  const found = await reader.of([component("    httpResource(() => `/orders/${method}`)", "    httpResource.text(() => ({ url: '/receipts', method: 'POST' }))")], "shop-web");

  assert.deepEqual(sites(found), ["GET /orders/{}@src/app/app.component.ts:6", "POST /receipts@src/app/app.component.ts:7"]);
});

test("a base URL the call declares but the snapshot does not decide is an unknown target, never a call with no base", async () => {
  assert.deepEqual(sites(await reader.of([component("    this.http.get('/route', { baseUrl: method })")], "shop-web")), ["unknown unresolved@src/app/app.component.ts:6"]);
});

test("a request whose base the snapshot does not decide still states the method and the path the code writes", async () => {
  const [site] = await reader.of([component("    this.http.get('/route', { baseUrl: method })")], "shop-web");

  assert.equal(site?.target.status, "unknown");
  assert.deepEqual(site?.stated, { method: "GET", path: "/route" });
});

test("a request whose method the snapshot does not decide states no request", async () => {
  const [site] = await reader.of([component("    this.http.request(method, '/orders/7')")], "shop-web");

  assert.equal(site?.target.status, "unknown");
  assert.equal(site?.stated, undefined);
});

test("a class another class injects that makes its requests with paths it states keeps them as call sites: only a method that forwards its own parameter as the path is a wrapper", async () => {
  const api = source(
    "src/app/items/items.api.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject, Injectable } from '@angular/core'", "@Injectable({ providedIn: 'root' })", "export class ItemsApi {", "  private readonly http = inject(HttpClient)", "  featured(): void {", "    this.http.get('/items/featured')", "  }", "}"].join("\n"),
  );
  const page = source("src/app/items/items.page.ts", ["import { inject } from '@angular/core'", "import { ItemsApi } from './items.api'", "export class ItemsPage {", "  private readonly api = inject(ItemsApi)", "  load(): void {", "    this.api.featured()", "  }", "}"].join("\n"));

  assert.deepEqual(sites(await reader.of([api, page], "shop-web")), ["GET /items/featured@src/app/items/items.api.ts:7"]);
});

test("a wrapper's path may be computed from its parameter; a method whose name is no verb keeps its own call site, since a call to it is not read as a request", async () => {
  const client = source(
    API,
    ["import { HttpClient } from '@angular/common/http'", "import { inject, Injectable } from '@angular/core'", "@Injectable({ providedIn: 'root' })", "export class RestClientService {", "  private readonly http = inject(HttpClient)", "  get(path: string): void {", "    const url = this.resolve(path)", "    this.http.get(url)", "  }", "  item(id: string): void {", "    this.http.get(`/items/${id}`)", "  }", "  private resolve(path: string): string {", "    return path", "  }", "}"].join("\n"),
  );
  const page = source("src/app/items/items.page.ts", ["import { inject } from '@angular/core'", "import { RestClientService } from '../core/rest/services/client/rest-client.service'", "export class ItemsPage {", "  private readonly rest = inject(RestClientService)", "  load(): void {", "    this.rest.get('/items')", "    this.rest.item('7')", "  }", "}"].join("\n"));

  assert.deepEqual(sites(await reader.of([client, page], "shop-web")), [`GET /items/{}@${API}:11`, "GET /items@src/app/items/items.page.ts:6"]);
});
