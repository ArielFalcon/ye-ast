import { test } from "node:test";
import assert from "node:assert/strict";
import type { Seed, ReachedEntrypoint } from "../../domain/impact/impact-fact.ts";
import { handlerKey, reachedBy } from "../../domain/topology/link-graph.ts";
import type { CallSite } from "../../domain/topology/call-site.ts";
import { createHttpCallSites } from "./http-call-sites.adapter.ts";

const reader = createHttpCallSites();

test("lexical bindings include destructuring and exclude sibling scopes", async () => {
  const file = source("scope.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "const route = 'outer'",
    "class Client {",
    "  constructor(private http: HttpClient) {}",
    "  load(request: unknown, outer: string) {",
    "    const { profile, nested: { coordinates } } = request as any",
    "    const nested = (route: string) => this.http.get(`/api/${route}/${profile}/${coordinates}/${outer}`)",
    "    { const route = 'sibling'; }",
    "    this.http.get(`/api/${route}`)",
    "  }",
    "}",
  ].join("\n"));
  assert.deepEqual(sites(await reader.of([file], "repo")), ["GET /api/{}/{}/{}/{}@scope.ts:7", "GET /api/outer@scope.ts:9"]);
});

test("encoding global string values and runtime bindings is safe, but shadowed or unknown encoders are not assumed", async () => {
  const file = source("encoding.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Client {",
    " constructor(private http: HttpClient) {}",
    " load(id: string) {",
    "  this.http.get(`/api/${encodeURIComponent(id)}`)",
    "  this.http.get(`/api/${encodeURIComponent('a b')}`)",
    "  this.http.get(`/api/${encodeURIComponent(missing)}`)",
    "  { const encodeURIComponent = custom; this.http.get(`/api/${encodeURIComponent(id)}`) }",
    "  fetch(id)",
    " }",
    "}",
  ].join("\n"));
  assert.deepEqual(sites(await reader.of([file], "repo")), ["GET /api/{}@encoding.ts:5", "GET /api/a%20b@encoding.ts:6", "unknown unresolved@encoding.ts:7", "unknown unresolved@encoding.ts:8", "unknown unresolved@encoding.ts:9"]);
});

test("initializers use their own lexical scope rather than a nested caller's shadow", async () => {
  const file = source("capture.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Client { constructor(private http: HttpClient) {}",
    " load() { const prefix = 'outer'; const path = prefix;",
    "  ((prefix: string) => this.http.get(`/api/${path}`))('inner')",
    " } }",
  ].join("\n"));
  assert.deepEqual(sites(await reader.of([file], "repo")), ["GET /api/outer@capture.ts:4"]);
});

test("an imported encoder is not treated as the global built-in", async () => {
  const file = source("imported.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "import { encodeURIComponent } from './missing'",
    "class Client { constructor(private http: HttpClient) {}",
    " load(id: string) { this.http.get(`/api/${encodeURIComponent(id)}`) } }",
  ].join("\n"));
  assert.deepEqual(sites(await reader.of([file], "repo")), ["unknown unresolved@imported.ts:4"]);
});

test("a named function expression shadows the global encoder inside its own body", async () => {
  const file = source("named.ts", "const fn = function encodeURIComponent(id: string) { if (id === 'x') return 'custom'; return fetch(`/api/${encodeURIComponent('x')}`) }");
  assert.deepEqual(sites(await reader.of([file], "repo")), ["unknown unresolved@named.ts:1"]);
});

test("a written global encoder is not evaluated as the built-in, even from another snapshot module", async () => {
  const mutation = source("mutation.ts", "encodeURIComponent = () => 'custom';");
  const direct = source("direct.ts", "fetch(`/api/${encodeURIComponent('x')}`)");
  assert.deepEqual(sites(await reader.of([mutation, direct], "repo")), ["unknown unresolved@direct.ts:1"]);
  const property = source("property.ts", "globalThis.encodeURIComponent = () => 'custom'; fetch(`/api/${encodeURIComponent('x')}`)");
  assert.deepEqual(sites(await reader.of([property], "repo")), ["unknown unresolved@property.ts:1"]);
  const escape = source("escape.ts", "Object.assign(globalThis, { encodeURIComponent: () => 'custom' }); fetch(`/api/${encodeURIComponent('x')}`)");
  assert.deepEqual(sites(await reader.of([escape], "repo")), ["unknown unresolved@escape.ts:1"]);
  const alias = source("alias.ts", "globalThis['window'].encodeURIComponent = () => 'custom'; fetch(`/api/${encodeURIComponent('x')}`)");
  assert.deepEqual(sites(await reader.of([alias], "repo")), ["unknown unresolved@alias.ts:1"]);
});

test("a class static block's var does not shadow its enclosing function's route", async () => {
  const file = source("static.ts", "const route = 'outer'; function load() { class Nested { static { var route = 'inner' } } fetch(`/api/${route}`) }");
  assert.deepEqual(sites(await reader.of([file], "repo")), ["GET /api/outer@static.ts:1"]);
});

test("global object inspection and unrelated property names do not count as escaping the global object", async () => {
  const file = source("read.ts", "typeof window; 'ontouchstart' in globalThis; const position = { global: true }; position.global; (globalThis as any).location; fetch(`/api/${encodeURIComponent('x')}`)");
  assert.deepEqual(sites(await reader.of([file], "repo")), ["GET /api/x@read.ts:1"]);
  const copied = source("copy.ts", "const copy = { ...window }; const other = { ...(globalThis as any) };");
  assert.deepEqual(sites(await reader.of([copied, file], "repo")), ["GET /api/x@read.ts:1"]);
  const augmented = source("support.ts", "declare global { interface Window { app: string } }\nexport {};");
  assert.deepEqual(sites(await reader.of([augmented, file], "repo")), ["GET /api/x@read.ts:1"]);
});

test("function-scoped var bindings shadow outer constants outside their block", async () => {
  const file = source("var.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "const route = 'wrong'",
    "class Client { constructor(private http: HttpClient) {}",
    " load(value: string) { if (value) { var route = value }",
    "  this.http.get(`/api/${route}`) } }",
  ].join("\n"));
  assert.deepEqual(sites(await reader.of([file], "repo")), ["GET /api/{}@var.ts:5"]);
});

test("a top-level block var shadows the global encoder", async () => {
  const shadow = source("shadow.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "if (true) { var encodeURIComponent = custom }",
    "class Client { constructor(private http: HttpClient) {}",
    " load(id: string) { this.http.get(`/api/${encodeURIComponent(id)}`) } }",
  ].join("\n"));
  assert.deepEqual(sites(await reader.of([shadow], "repo")), ["unknown unresolved@shadow.ts:4"]);
});

test("an encoded value is one segment whatever it is, unless it reads nothing the code fills at run time and the snapshot cannot read it", async () => {
  const found = await reader.of([component("    this.http.get(`/api/${encodeURIComponent(this.identifierOf(method))}`)", "    this.http.get(`/api/${encodeURIComponent(`${method}/${method}`)}`)", "    this.http.get(`/api/${encodeURIComponent(lookup())}`)", "    this.http.get(`/api/${encodeURIComponent('\\uD800')}`)")], "shop-web");

  assert.deepEqual(sites(found), ["GET /api/{}@src/app/app.component.ts:6", "GET /api/{}@src/app/app.component.ts:7", "unknown unresolved@src/app/app.component.ts:8", "unknown unresolved@src/app/app.component.ts:9"]);
});

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

test("a receiver is read in the class whose code calls it: another class's HttpClient field of the same name does not make it one", async () => {
  const file = source("two.ts", ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "import { Cache } from './cache'", "class A { private readonly http = inject(HttpClient) }", "class B { private readonly http = inject(Cache)", "  load() { this.http.get('/items') } }"].join("\n"));

  assert.deepEqual(sites(await reader.of([file], "shop-web")), []);
});

test("an HttpClient field a class inherits from an imported base is its receiver", async () => {
  const base = source("src/app/base.service.ts", ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "export class BaseService { protected readonly http = inject(HttpClient) }"].join("\n"));
  const child = source("src/app/items.service.ts", ["import { BaseService } from './base.service'", "export class ItemsService extends BaseService {", "  load() { this.http.get('/items') } }"].join("\n"));

  assert.deepEqual(sites(await reader.of([base, child], "shop-web")), ["GET /items@src/app/items.service.ts:3"]);
});

test("a constructor parameter is a field only when it declares one, and the parameter itself is a receiver where it is in scope", async () => {
  const file = source("ctor.ts", ["import { HttpClient } from '@angular/common/http'", "class Client {", "  constructor(http: HttpClient) { http.get('/boot') }", "  load() { this.http.get('/items') } }"].join("\n"));

  assert.deepEqual(sites(await reader.of([file], "shop-web")), ["GET /boot@ctor.ts:3"]);
});

test("an injected client's receiver is not the URL supplied to its verb", async () => {
  const caller = source("src/service.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "import { inject } from '@angular/core'",
    "class Service {",
    "  private http = inject(HttpClient)",
    "  private entityUrl = 'http://localhost:9966/api/' + 'owners'",
    "  load() { return this.http.get(this.entityUrl) }",
    "}",
  ].join("\n"));
  assert.deepEqual(sites(await reader.of([caller], "web")), ["GET http://localhost:9966/api/owners@src/service.ts:6"]);
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

test("a property of a value the code fills at run time is one too, its root read through the binding the code declares", async () => {
  const file = source("props.ts", ["import { HttpClient } from '@angular/common/http'", "const category = { id: 'literal' }", "class Client { constructor(private http: HttpClient) {}", "  load(category: unknown, event: any) {", "    this.http.patch(`/categories/${category.id}/visible`, {})", "    this.http.delete('/contents/' + event.data.id)", "    this.http.delete('/pages/' + event!.data.id)", "  } }"].join("\n"));

  assert.deepEqual(sites(await reader.of([file], "shop-web")), ["PATCH /categories/{}/visible@props.ts:5", "DELETE /contents/{}@props.ts:6", "DELETE /pages/{}@props.ts:7"]);
});

test("a field the class declares without an initializer, or as a constructor parameter, holds a value the code fills at run time", async () => {
  const file = source("fields.ts", ["import { HttpClient } from '@angular/common/http'", "class Page { uniqueCode: string; content: any", "  constructor(private http: HttpClient, private readonly tenant: string) {}", "  load() {", "    this.http.get('/boxes/' + this.uniqueCode)", "    this.http.put('/boxes/' + this.content.id, {})", "    this.http.get(`/tenants/${this.tenant}/boxes`)", "  } }"].join("\n"));

  assert.deepEqual(sites(await reader.of([file], "shop-web")), ["GET /boxes/{}@fields.ts:5", "PUT /boxes/{}@fields.ts:6", "GET /tenants/{}/boxes@fields.ts:7"]);
});

test("a field the code assigns besides its initializer, in its class or a subclass, or a subclass declares again, holds a value the code fills at run time", async () => {
  const file = source("assigned.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Base { constructor(protected http: HttpClient) {} protected version = 'v1'; protected kind = 'all'; protected page = 'p1'; protected area = 'a1'",
    "  constructor2() { this.page += 'x' }",
    "  load() { this.http.get(`/api/${this.version}/${this.kind}/${this.page}/${this.area}/items`) } }",
    "class Child extends Base { protected kind = 'mine'; start() { this.version = 'v2'; this.area++ } }",
  ].join("\n"));

  assert.deepEqual(sites(await reader.of([file], "shop-web")), ["GET /api/{}/{}/{}/{}/items@assigned.ts:4"]);
});

test("a class that writes fields it does not name may write any of them", async () => {
  const file = source("dynamic.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class A { constructor(private http: HttpClient) {} version = 'v1'; set(key: string) { this[key] = 'v2' } load() { this.http.get(`/a/${this.version}/items`) } }",
    "class B { constructor(private http: HttpClient, init: object) { Object.assign(this, init) } version = 'v1'; load() { this.http.get(`/b/${this.version}/items`) } }",
  ].join("\n"));

  assert.deepEqual(sites(await reader.of([file], "shop-web")), ["GET /a/{}/items@dynamic.ts:2", "GET /b/{}/items@dynamic.ts:3"]);
});

test("a variable the code reassigns is not its initializer, so its path is undecided", async () => {
  const file = source("let.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "let BASE = '/a'",
    "var ROOT = '/r'",
    "export function move() { BASE = '/b'; ROOT = '/s' }",
    "class Client { constructor(private http: HttpClient) {}",
    "  load(archived: boolean, pair: string[]) {",
    "    this.http.get(BASE + '/x')",
    "    this.http.get(ROOT + '/y')",
    "    let url = '/orders'; if (archived) { url = '/orders/archived' }; this.http.get(url)",
    "    let path = '/items'; path += '/archived'; this.http.get(path)",
    "    let next = '/pages'; [next] = pair; this.http.get(next)",
    "  } }",
  ].join("\n"));

  assert.deepEqual(sites(await reader.of([file], "shop-web")), ["unknown unresolved@let.ts:7", "unknown unresolved@let.ts:8", "unknown unresolved@let.ts:9", "unknown unresolved@let.ts:10", "unknown unresolved@let.ts:11"]);
});

test("a variable the code only extends with a query or a fragment keeps its initializer's path", async () => {
  const found = await reader.of([component("    let url = '/owners'; if (method) { url += '?lastName=' + method }; this.http.get(url)", "    let page = '/pages?size=10'; page += '&page=' + method; this.http.get(page)", "    this.http.get(`/r/${encodeURIComponent(url)}`)")], "shop-web");

  assert.deepEqual(sites(found), ["GET /owners@src/app/app.component.ts:6", "GET /pages@src/app/app.component.ts:7", "GET /r/{}@src/app/app.component.ts:8"]);
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
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "const BASE = 'orders-api'", "export class OrderService {", "  private readonly http = inject(HttpClient)", "  load(BASE: string): void {", "    this.http.get(`/api/${BASE}/orders`)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([service], "shop-web")), ["GET /api/{}/orders@src/app/order/order.service.ts:7"]);
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
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "export class OrderService {", "  private readonly http = inject(HttpClient)", "  load(orderId: string): void {", "    const url = orderId", "    this.http.get(`/orders/${url}/lines`)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([service], "shop-web")), ["GET /orders/{}/lines@src/app/order/order.service.ts:7"]);
});

test("a run-time value that does not start a path segment leaves the path undecided, since it may hold an origin or a base path", async () => {
  const found = await reader.of([component("    this.http.get(`${method}/orders`)", "    this.http.get('' + method + '/orders')", "    this.http.get(`/api/v1${method}`)", "    this.http.get(`/api/${method}/orders`)")], "shop-web");

  assert.deepEqual(sites(found), ["unknown unresolved@src/app/app.component.ts:6", "unknown unresolved@src/app/app.component.ts:7", "unknown unresolved@src/app/app.component.ts:8", "GET /api/{}/orders@src/app/app.component.ts:9"]);
});

test("a variable whose undecided initializer reads nothing the code fills at run time is undecided, and one that reads such a value is one", async () => {
  const found = await reader.of([component("    const part = compute()", "    this.http.get(`/api/${part}/tail`)", "    const code = this.store.merchant()", "    this.http.get(`/stores/${code}/logo`)")], "shop-web");

  assert.deepEqual(sites(found), ["unknown unresolved@src/app/app.component.ts:7", "GET /stores/{}/logo@src/app/app.component.ts:9"]);
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

test("a fetch takes its method from the init object it states, GET when that names none, and is undecided when the init may state another", async () => {
  const found = await reader.of([component("    fetch('/items', { method: 'DELETE' })", "    fetch('/items', { headers: {} })", "    fetch('/items', { ...this.defaults })", "    fetch('/items', this.options)", "    fetch('/items', { ...this.defaults, method: 'PUT' })")], "shop-web");

  assert.deepEqual(sites(found), ["DELETE /items@src/app/app.component.ts:6", "GET /items@src/app/app.component.ts:7", "unknown unresolved@src/app/app.component.ts:8", "unknown unresolved@src/app/app.component.ts:9", "PUT /items@src/app/app.component.ts:10"]);
});

test("a fetch the code declares itself is not the global fetch, so its call is no request", async () => {
  assert.deepEqual(sites(await reader.of([component("    { const fetch = (url: string) => url; fetch('/items') }")], "shop-web")), []);
});

test("a request object's url and method may be shorthand, and a spread after them may replace them", async () => {
  const found = await reader.of([component("    const url = '/receipts'", "    httpResource(() => ({ url, method: 'POST' }))", "    httpResource(() => ({ url: '/receipts', ...this.request }))")], "shop-web");

  assert.deepEqual(sites(found), ["POST /receipts@src/app/app.component.ts:7", "unknown unresolved@src/app/app.component.ts:8"]);
});

test("an httpResource whose function returns undefined requests nothing then, so its request is the one it returns otherwise", async () => {
  const found = await reader.of([component("    httpResource(() => { if (!method) { return undefined } if (method === 'none') { return } return { url: '/orders', params: { method } } })")], "shop-web");

  assert.deepEqual(sites(found), ["GET /orders@src/app/app.component.ts:6"]);
});

function pathFunction(...body: string[]): { path: string; content: string } {
  return source("paths.ts", ["import { HttpClient } from '@angular/common/http'", "function orderPath(open: boolean) {", ...body, "}", "class Client { constructor(private http: HttpClient) {}", " load(open: boolean) { this.http.get(orderPath(open)) } }"].join("\n"));
}

test("requests and paths a function returns in different branches are undecided, never its first branch", async () => {
  const resource = component("    httpResource(() => { if (method) { return '/orders/open' } return '/orders' })");

  assert.deepEqual(sites(await reader.of([resource, pathFunction(" if (open) { return '/orders/open' }", " return '/orders'")], "shop-web")), ["unknown unresolved@paths.ts:7", "unknown unresolved@src/app/app.component.ts:6"]);
});

test("a path function is read at its own returns, never at a return of a function it declares", async () => {
  assert.deepEqual(sites(await reader.of([pathFunction(" const pick = () => { return '/wrong' }", " return '/orders'")], "shop-web")), ["GET /orders@paths.ts:7"]);
});

test("what follows the query or the fragment of a path never leaves it undecided", async () => {
  const found = await reader.of([component("    this.http.get(`/orders?page=${this.page()}`)", "    this.http.get('/orders#' + this.anchor())")], "shop-web");

  assert.deepEqual(sites(found), ["GET /orders@src/app/app.component.ts:6", "GET /orders@src/app/app.component.ts:7"]);
});

test("an encoded text whose query was cut is never encoded as if it were the whole value", async () => {
  assert.deepEqual(sites(await reader.of([component("    this.http.get(`/api/${encodeURIComponent(`a?${this.page()}`)}`)")], "shop-web")), ["GET /api/{}@src/app/app.component.ts:6"]);
});

test("a text that holds a cut text is cut too, so it is never encoded whole", async () => {
  const found = await reader.of([component("    const query = `a?${this.page()}`", "    this.http.get(`/api/${encodeURIComponent(`${query}`)}`)", "    this.http.get(`/api/${encodeURIComponent('' + query)}`)")], "shop-web");

  assert.deepEqual(sites(found), ["GET /api/{}@src/app/app.component.ts:7", "GET /api/{}@src/app/app.component.ts:8"]);
});

test("an encoded text that states a question mark itself is encoded whole", async () => {
  assert.deepEqual(sites(await reader.of([component("    this.http.get(`/api/${encodeURIComponent('a?b')}`)")], "shop-web")), ["GET /api/a%3Fb@src/app/app.component.ts:6"]);
});

test("a path function that calls itself is undecided, never a hang", async () => {
  assert.deepEqual(sites(await reader.of([pathFunction(" return orderPath(!open)")], "shop-web")), ["unknown unresolved@paths.ts:6"]);
});

test("a variable a request function declares is read in the function's own scope", async () => {
  const found = await reader.of([component("    httpResource(() => { const id = method; return `/orders/${id}` })")], "shop-web");

  assert.deepEqual(sites(found), ["GET /orders/{}@src/app/app.component.ts:6"]);
});

test("a path function whose end is reachable without a return may return undefined, so its path is undecided", async () => {
  assert.deepEqual(sites(await reader.of([pathFunction(" if (open) { return '/orders' }")], "shop-web")), ["unknown unresolved@paths.ts:6"]);
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
    ["import { HttpClient } from '@angular/common/http'", "import { inject, Injectable } from '@angular/core'", "@Injectable({ providedIn: 'root' })", "export class RestClientService {", "  private readonly http = inject(HttpClient)", "  get(path: string): void {", "    const url = this.resolve(path)", "    this.http.get(url)", "  }", "  item(id: string): void {", "    this.http.get(`/items/${id}`)", "  }", "  private resolve(path: string): string {", "    return this.base + '/' + path", "  }", "  private readonly base = 'api'", "}"].join("\n"),
  );
  const page = source("src/app/items/items.page.ts", ["import { inject } from '@angular/core'", "import { RestClientService } from '../core/rest/services/client/rest-client.service'", "export class ItemsPage {", "  private readonly rest = inject(RestClientService)", "  load(): void {", "    this.rest.get('/items')", "    this.rest.item('7')", "  }", "}"].join("\n"));

  assert.deepEqual(sites(await reader.of([client, page], "shop-web")), [`GET /items/{}@${API}:11`, "GET /items@src/app/items/items.page.ts:6"]);
});

test("a method that puts its parameter inside a path segment is no wrapper, so its own request is the call site and a call to it is none", async () => {
  const service = source("src/app/items.service.ts", ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "export class ItemsService {", "  private readonly http = inject(HttpClient)", "  delete(name: string) { return this.http.delete(`/items/${encodeURIComponent(name)}`) }", "  put(id: string) { return this.http.put(`/items/${id}/details`, {}) }", "  get(id: string) { return this.http.get(this.itemUrl(id)) }", "  itemUrl(id: string) { return `/items/${encodeURIComponent(id)}` }", "}"].join("\n"));
  const dialog = source("src/app/items.dialog.ts", ["import { inject } from '@angular/core'", "import { ItemsService } from './items.service'", "export class ItemsDialog {", "  private readonly items = inject(ItemsService)", "  confirm(name: string) { this.items.delete(name); this.items.put(name); this.items.get(name) }", "}"].join("\n"));

  assert.deepEqual(sites(await reader.of([service, dialog], "shop-web")), ["DELETE /items/{}@src/app/items.service.ts:5", "PUT /items/{}/details@src/app/items.service.ts:6", "unknown unresolved@src/app/items.service.ts:7"]);
});

test("a call through a wrapper takes the method of the request the wrapper makes, not the wrapper's name", async () => {
  const client = source(API, ["import { HttpClient } from '@angular/common/http'", "import { inject, Injectable } from '@angular/core'", "@Injectable({ providedIn: 'root' })", "export class RestClientService {", "  private readonly http = inject(HttpClient)", "  get(path: string) { return this.http.post(path, {}) }", "}"].join("\n"));
  const page = source("src/app/items/items.page.ts", ["import { inject } from '@angular/core'", "import { RestClientService } from '../core/rest/services/client/rest-client.service'", "export class ItemsPage {", "  private readonly rest = inject(RestClientService)", "  load(): void { this.rest.get('/items') }", "}"].join("\n"));

  assert.deepEqual(sites(await reader.of([client, page], "shop-web")), ["POST /items@src/app/items/items.page.ts:5"]);
});

const CONSTANTS = "src/app/app.constants.ts";
const SERVICE = "src/app/order/order.service.ts";

function workspace(define: unknown, configurations?: Record<string, unknown>, builder = "@angular/build:application"): { path: string; content: string } {
  const options = define === undefined ? {} : { define };
  const build = { builder, options, ...(configurations === undefined ? {} : { configurations }) };
  return source("angular.json", JSON.stringify({ projects: { web: { root: "", architect: { build } } } }));
}

function orderService(...methods: string[]): { path: string; content: string } {
  return source(
    SERVICE,
    [
      "import { HttpClient } from '@angular/common/http'",
      "import { inject } from '@angular/core'",
      "import { serverApiUrl } from '../app.constants'",
      "export class OrderService {",
      "  protected readonly resourceUrl = `${serverApiUrl}api/orders`",
      "  private readonly http = inject(HttpClient)",
      ...methods.map((body, index) => `  m${index}(id: number): void { ${body} }`),
      "}",
    ].join("\n"),
  );
}

const constants = source(CONSTANTS, ["declare const SERVER_API_URL: string;", "export const serverApiUrl = SERVER_API_URL;"].join("\n"));

test("an ambient constant that the build target's define states as a string literal is that string", async () => {
  const service = orderService("this.http.get(this.resourceUrl)");
  assert.deepEqual(sites(await reader.of([workspace({ SERVER_API_URL: "''" }), constants, service], "shop-web")), [`GET api/orders@${SERVICE}:7`]);
  assert.deepEqual(sites(await reader.of([workspace({ SERVER_API_URL: "'/gateway/'" }), constants, service], "shop-web")), [`GET /gateway/api/orders@${SERVICE}:7`]);
});

test("an ambient constant stays unknown when no define states it, the define is not a string literal, or the configurations disagree", async () => {
  const service = orderService("this.http.get(this.resourceUrl)");
  const unknown = [`unknown unresolved@${SERVICE}:7`];
  assert.deepEqual(sites(await reader.of([constants, service], "shop-web")), unknown);
  assert.deepEqual(sites(await reader.of([workspace({ OTHER: "''" }), constants, service], "shop-web")), unknown);
  assert.deepEqual(sites(await reader.of([workspace({ SERVER_API_URL: "process.env.URL" }), constants, service], "shop-web")), unknown);
  assert.deepEqual(sites(await reader.of([workspace({ SERVER_API_URL: "''" }, { production: { define: { SERVER_API_URL: "'/prod/'" } } }), constants, service], "shop-web")), unknown);
  assert.deepEqual(sites(await reader.of([workspace(undefined, { production: { define: { SERVER_API_URL: "''" } } }), constants, service], "shop-web")), unknown);
  assert.deepEqual(sites(await reader.of([workspace({ SERVER_API_URL: "''" }, undefined, "@angular-devkit/build-angular:browser"), constants, service], "shop-web")), unknown);
});

test("a field a class does not declare is its base class's, here or through an import; a field the class declares wins", async () => {
  const base = source("src/app/order/order-base.ts", ["import { serverApiUrl } from '../app.constants'", "export class OrdersBase {", "  protected readonly resourceUrl = `${serverApiUrl}api/orders`", "}"].join("\n"));
  const service = source(
    SERVICE,
    [
      "import { HttpClient } from '@angular/common/http'",
      "import { inject } from '@angular/core'",
      "import { OrdersBase } from './order-base'",
      "export class OrderService extends OrdersBase {",
      "  private readonly http = inject(HttpClient)",
      "  find(id: number): void { this.http.get(`${this.resourceUrl}/${encodeURIComponent(id)}`) }",
      "}",
      "export class LegacyOrderService extends OrdersBase {",
      "  protected readonly resourceUrl = 'legacy/orders'",
      "  private readonly http = inject(HttpClient)",
      "  all(): void { this.http.get(this.resourceUrl) }",
      "}",
    ].join("\n"),
  );
  assert.deepEqual(sites(await reader.of([workspace({ SERVER_API_URL: "''" }), constants, base, service], "shop-web")), [`GET api/orders/{}@${SERVICE}:6`, `GET legacy/orders@${SERVICE}:11`]);
});

test("a variable the file declares is its own value, never a define of the same name", async () => {
  const service = orderService("this.http.get(this.resourceUrl)");
  for (const declaration of ["let SERVER_API_URL: string;", "var SERVER_API_URL: string;"]) {
    const bound = source(CONSTANTS, [declaration, "SERVER_API_URL = '/runtime/';", "export const serverApiUrl = SERVER_API_URL;"].join("\n"));
    assert.deepEqual(sites(await reader.of([workspace({ SERVER_API_URL: "'/build/'" }), bound, service], "shop-web")), [`unknown unresolved@${SERVICE}:7`]);
  }
});

test("a configuration's own define replaces the whole define of the options, as the Angular CLI merges them", async () => {
  const service = orderService("this.http.get(this.resourceUrl)");
  const replaced = workspace({ SERVER_API_URL: "''" }, { production: { define: { OTHER: "''" } } });
  assert.deepEqual(sites(await reader.of([replaced, constants, service], "shop-web")), [`unknown unresolved@${SERVICE}:7`]);
});

test("configurations that state the same define value, or inherit it, keep it", async () => {
  const service = orderService("this.http.get(this.resourceUrl)");
  const configured = workspace({ SERVER_API_URL: "''" }, { production: { define: { SERVER_API_URL: "''" } }, development: {} });
  assert.deepEqual(sites(await reader.of([configured, constants, service], "shop-web")), [`GET api/orders@${SERVICE}:7`]);
});

test("a define reaches only the sources of the project that declares it", async () => {
  const nested = source("angular.json", JSON.stringify({ projects: { web: { root: "", architect: { build: { builder: "@angular/build:application", options: { define: { SERVER_API_URL: "''" } } } } }, lib: { root: "projects/lib", architect: { build: { builder: "@angular/build:ng-packagr" } } } } }));
  const inLib = { path: `projects/lib/${CONSTANTS}`, content: constants.content };
  const libService = { path: `projects/lib/${SERVICE}`, content: orderService("this.http.get(this.resourceUrl)").content };
  assert.deepEqual(sites(await reader.of([nested, inLib, libService], "shop-web")), [`unknown unresolved@projects/lib/${SERVICE}:7`]);
  const reversed = source("angular.json", JSON.stringify({ projects: { web: { root: "", architect: { build: { builder: "@angular/build:application" } } }, lib: { root: "projects/lib", architect: { build: { builder: "@angular/build:application", options: { define: { SERVER_API_URL: "''" } } } } } } }));
  assert.deepEqual(sites(await reader.of([reversed, inLib, libService], "shop-web")), [`GET api/orders@projects/lib/${SERVICE}:7`]);
});

test("a path parameter written as encodeURIComponent, String or toString of a run-time value is a placeholder", async () => {
  const service = orderService(
    "this.http.get(`${this.resourceUrl}/${encodeURIComponent(id)}`)",
    "this.http.get(`${this.resourceUrl}/${String(id)}`)",
    "this.http.get(`${this.resourceUrl}/${id.toString()}`)",
    "this.http.get(this.resourceUrl, { observe: 'response' })",
  );
  const local = { ...service, content: service.content.replace("import { serverApiUrl } from '../app.constants'", "const serverApiUrl = ''") };
  assert.deepEqual(sites(await reader.of([local], "shop-web")), [
    `GET api/orders/{}@${SERVICE}:7`,
    `GET api/orders/{}@${SERVICE}:8`,
    `GET api/orders/{}@${SERVICE}:9`,
    `GET api/orders@${SERVICE}:10`,
  ]);
});

test("String and toString write what a template writes, whatever the value's type", async () => {
  const file = source("unk.ts", ["import { HttpClient } from '@angular/common/http'", "class C { constructor(private http: HttpClient) {}", " a(id: unknown) { this.http.get(`/api/${String(id)}`) }", " b(id: unknown) { this.http.get(`/api/${id.toString()}`) } }"].join("\n"));
  assert.deepEqual(sites(await reader.of([file], "repo")), ["GET /api/{}@unk.ts:3", "GET /api/{}@unk.ts:4"]);
});

test("an httpResource whose url is a field resolves, as an object's url or as the returned string", async () => {
  const service = source(
    SERVICE,
    [
      "import { httpResource } from '@angular/common/http'",
      "import { serverApiUrl } from '../app.constants'",
      "export class OrderService {",
      "  protected readonly resourceUrl = `${serverApiUrl}api/orders`",
      "  all = httpResource<string[]>(() => ({ url: this.resourceUrl, params: {} }))",
      "  one = httpResource(() => this.resourceUrl)",
      "}",
    ].join("\n"),
  );
  const local = { ...service, content: service.content.replace("import { serverApiUrl } from '../app.constants'", "const serverApiUrl = ''") };
  assert.deepEqual(sites(await reader.of([local], "shop-web")), [`GET api/orders@${SERVICE}:5`, `GET api/orders@${SERVICE}:6`]);
});

test("a name imported from a module the snapshot does not hold is not replaced by a define of the same name", async () => {
  const imported = source(CONSTANTS, ["import { SERVER_API_URL } from './missing'", "export const serverApiUrl = SERVER_API_URL;"].join("\n"));
  assert.deepEqual(sites(await reader.of([workspace({ SERVER_API_URL: "''" }), imported, orderService("this.http.get(this.resourceUrl)")], "shop-web")), [`unknown unresolved@${SERVICE}:7`]);
});
