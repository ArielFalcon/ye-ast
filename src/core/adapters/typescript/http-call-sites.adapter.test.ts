import { test } from "node:test";
import assert from "node:assert/strict";
import type { CallSite } from "../../domain/topology/call-site.ts";
import { createHttpCallSites } from "./http-call-sites.adapter.ts";

const reader = createHttpCallSites();

function source(path: string, content: string): { path: string; content: string } {
  return { path, content };
}

const API = "src/app/core/rest/services/client/rest-client.service.ts";

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
