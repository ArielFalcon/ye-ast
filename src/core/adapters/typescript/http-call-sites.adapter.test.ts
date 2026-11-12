import { providerValueFiles } from "./provider-values.testing.ts";
import { angularProviderContribution } from "./angular-provider-values.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Seed, ReachedEntrypoint } from "../../domain/impact/impact-fact.ts";
import { handlerKey, reachedBy } from "../../domain/topology/link-graph.ts";
import type { CallSite } from "../../domain/topology/call-site.ts";
import { createHttpCallSites, createRequestCallLookup } from "./http-call-sites.adapter.ts";

const reader = createHttpCallSites();

test("partial URL expressions survive wrappers without becoming proven route paths", async () => {
  const capture = (prefix: string, suffix: string) => [source("partial.ts", [
    "import { HttpClient } from '@angular/common/http'",
    prefix,
    "class Api { constructor(private http: HttpClient) {} get(path: string) { return this.http.get(`${BASE}${path}`) } }",
    `class Service { constructor(private api: Api) {} load(id: string) { return this.api.get(\`${suffix}/\${id}\`) } }`,
  ].join("\n"))];
  const first = await reader.of(capture("declare const BASE: string", "/articles"), "repo");
  const partial = first.find((site) => site.line === 4);
  assert.equal(partial?.target.status, "unknown");
  assert.equal(partial?.stated?.path, undefined);
  assert.deepEqual(partial?.stated?.expressions?.[0]?.map((part) => part.kind), ["unknown", "text", "runtime"]);
  assert.equal(partial?.stated?.expressions?.[0]?.[1]?.kind === "text" && partial.stated.expressions[0][1].text, "/articles/");
  const changed = await reader.of(capture("declare const BASE: string", "/comments"), "repo");
  assert.notDeepEqual(changed[0]?.stated?.expressions, partial?.stated?.expressions);
  const known = await reader.of(capture("const BASE = 'https://example.test/api'", "/articles"), "repo");
  assert.ok(known.some((site) => site.target.status === "complete" && "path" in site.target.value && site.target.value.path === "https://example.test/api/articles/{}"));
  const query = await reader.of(capture("const BASE = 'https://example.test/api?redirect='", "/articles"), "repo");
  assert.ok(query.every((site) => site.target.status === "complete" && "path" in site.target.value && site.target.value.path === "https://example.test/api"));
});

test("identified requests retain targets alongside later independent enumeration gaps", async () => {
  const files = [source("scoped.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Api { handler: any; constructor(private http: HttpClient) { this.handler = opaqueFactory() }",
    "remove(id: string) { return this.http.delete('/items/' + id).pipe(this.handler('remove', 0)) }",
    "} class Page { constructor(private api: Api) {} remove() { return this.api.remove('42') } }",
  ].join("\n"))];
  const sites = await reader.of(files, "repo");
  assert.ok(sites.some((site) => site.target.status === "complete" && "path" in site.target.value && site.target.value.path === "/items/42"));
  assert.ok(sites.some((site) => site.target.status === "unknown" && site.diagnostic?.cause === "dispatch-disagreement"));
});

test("separate request occurrences do not become alternatives for one target", async () => {
  const files = [source("multiple.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Api { constructor(private http: HttpClient) {} send(id: string) { this.http.post('/items/' + id, {}); return this.http.get('/audit/' + id) } }",
    "class Page { constructor(private api: Api) {} send() { return this.api.send('42') } }",
  ].join("\n"))];
  const sites = await reader.of(files, "repo");
  assert.deepEqual(sites.flatMap((site) => site.target.status === "complete" && "path" in site.target.value ? [site.target.value.path] : []).sort(), ["/audit/42", "/items/42"]);
  const lookup = await createRequestCallLookup(files);
  const call = lookup.at({ file: "multiple.ts", line: 3, symbol: "Page.send" });
  assert.ok(call !== undefined);
  assert.equal(lookup.of(call)?.result.kind, "unknown");
});

test("uncertainty in a request argument still blocks its target", async () => {
  const sites = await reader.of([source("blocked.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Api { handler: any; constructor(private http: HttpClient) { this.handler = opaqueFactory() }",
    "remove(id: string) { return this.http.delete(this.handler(id)) }",
    "} class Page { constructor(private api: Api) {} remove() { return this.api.remove('42') } }",
  ].join("\n"))], "repo");
  assert.ok(sites.length > 0);
  assert.ok(sites.every((site) => site.target.status === "unknown"));
});

test("an unresolved earlier argument cannot be proved independent of the request", async () => {
  const sites = await reader.of([source("ordered.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Api { handler: any; constructor(private http: HttpClient) { this.handler = opaqueFactory() }",
    "remove(id: string) { return combine(this.handler(), this.http.delete('/items/' + id)) }",
    "} class Page { constructor(private api: Api) {} remove() { return this.api.remove('42') } }",
  ].join("\n"))], "repo");
  assert.ok(sites.some((site) => site.line === 4));
  assert.ok(sites.filter((site) => site.line === 4).every((site) => site.target.status === "unknown"));
});

test("request relevance is rebuilt for each captured source generation", async () => {
  const capture = (expression: string) => [source("live.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Api { handler: any; constructor(private http: HttpClient) { this.handler = opaqueFactory() }",
    `remove(id: string) { return ${expression} }`,
    "} class Page { constructor(private api: Api) {} remove() { return this.api.remove('42') } }",
  ].join("\n"))];
  const first = reader.of(capture("this.http.delete('/items/' + id).pipe(this.handler())"), "repo");
  const second = reader.of(capture("combine(this.handler(), this.http.delete('/items/' + id))"), "repo");
  assert.ok((await first).some((site) => site.line === 4 && site.target.status === "complete"));
  assert.ok((await second).filter((site) => site.line === 4).every((site) => site.target.status === "unknown"));
});

test("response ambiguity survives outer wrappers and distinct calls of the same leaf", async () => {
  for (const body of ["this.http.post('/a/' + id, {}); return this.http.get('/b/' + id)", "this.load(id); return this.load(id)"]) {
    const files = [source("response-occurrences.ts", [
      "import { HttpClient } from '@angular/common/http'",
      `class Api { constructor(private http: HttpClient) {} load(id: string) { return this.http.get('/b/' + id) } run(id: string) { ${body} } }`,
      "class Page { constructor(private api: Api) {} run(id: string) { return this.api.run(id) } }",
      "class App { constructor(private page: Page) {} run() { return this.page.run('1') } }",
    ].join("\n"))];
    const lookup = await createRequestCallLookup(files);
    for (const [line, symbol] of [[3, "Page.run"], [4, "App.run"]] as const) {
      const call = lookup.at({ file: "response-occurrences.ts", line, symbol });
      assert.ok(call !== undefined);
      assert.equal(lookup.of(call)?.result.kind, "unknown");
    }
  }
});

test("the lookup carries each direct request's result and fetch body access", async () => {
  const files = [source("results.ts", [
    "import { HttpClient, httpResource } from '@angular/common/http'",
    "class Api { constructor(private http: HttpClient) {}",
    "response() { return this.http.get('/x', { observe: 'response' }) }",
    "unknown(observe: string) { return this.http.get('/x', { observe }) }",
    "resource() { return httpResource(() => '/x') }",
    "fetch() { return fetch('/x') } }",
  ].join("\n"))];
  const lookup = await createRequestCallLookup(files);
  const at = (line: number, symbol: string) => lookup.at({ file: "results.ts", line, symbol: `Api.${symbol}` })!;
  assert.deepEqual(lookup.of(at(3, "response"))?.result, { kind: "body", container: "observable", observed: "response" });
  assert.equal(lookup.of(at(4, "unknown"))?.result.kind, "unknown");
  assert.deepEqual(lookup.of(at(5, "resource"))?.result, { kind: "body", container: "resource", observed: "body" });
  assert.deepEqual(lookup.of(at(6, "fetch"))?.result, { kind: "body", container: "promise", observed: "body" });
  const fetchResult = lookup.of(at(6, "fetch"));
  assert.ok(fetchResult !== undefined && "bodyAccess" in fetchResult && fetchResult.bodyAccess === "json");
});

test("virtual wrappers disagree when their response body access differs", async () => {
  const files = [source("virtual-results.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Base { constructor(protected http: HttpClient) {} load(id: string) { return from(fetch('/users/' + id)) } }",
    "class Child extends Base { load(id: string) { return this.http.get('/users/' + id) } }",
    "class Page { constructor(private api: Base) {} load() { return this.api.load('1') } }",
  ].join("\n"))];
  const lookup = await createRequestCallLookup(files);
  const call = lookup.at({ file: "virtual-results.ts", line: 4, symbol: "Page.load" });
  assert.ok(call !== undefined);
  const result = lookup.of(call)?.result;
  assert.ok(result?.kind === "unknown" && result.cause === "dispatch-disagreement");
});

test("a recognized request retains its method when its URL cannot be established", async () => {
  const found = await reader.of([source("unknown-url.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Client { constructor(private http: HttpClient) {}",
    "remove() { return this.http.delete(opaque()) }",
    "load() { return fetch(opaque()) }",
    "request(verb: string) { return this.http.request(verb, opaque()) } }",
  ].join("\n"))], "repo");
  assert.deepEqual(found.map((site) => [site.target.status, site.stated]), [["unknown", { method: "DELETE" }], ["unknown", { method: "GET" }], ["unknown", undefined]]);
});

test("guarded helper returns retain a supplied path without inventing identity for a replacement", async () => {
  for (const [early, supplied] of [["path", true], ["'/other'", false]] as const) {
    const files = [source("guarded.ts", [
      "import { HttpClient } from '@angular/common/http'; import { base } from './unread'",
      "class Client { constructor(private http: HttpClient) {}",
      `transform(path: string, params: unknown) { if (!params) return ${early}; return opaque(path, params) }`,
      "post(path: string, options: any) { const url = '/api/' + base + this.transform(path, options?.params); return this.http.post(url, {}) }",
      "}",
      "class Api { constructor(private client: Client) {} send() { return this.client.post('/orders', {}) } }",
    ].join("\n"))];
    const found = await reader.of(files, "repo");
    assert.equal(found.some((site) => site.line === 6), supplied);
    assert.ok(found.every((site) => site.target.status === "unknown"));
    if (supplied) assert.equal(found.some((site) => site.line === 4), false);
  }
});

test("guarded path facts distinguish omitted options from mutable or opaque objects", async () => {
  const fixture = (before: string, argument: string, extra = ""): string => [
    "import { HttpClient } from '@angular/common/http'; import { base } from './unread'",
    extra,
    "class Client { constructor(private http: HttpClient) {}",
    "transform(path: string, params: unknown) { if (!params) return path; return opaque(path, params) }",
    `post(path: string, options: any = {}) { ${before} const url = base + this.transform(path, options?.params); return this.http.post(url, {}) }`,
    "}",
    `class Api { constructor(private client: Client) {} send() { return this.client.post('/orders'${argument}) } }`,
  ].join("\n");
  for (const [before, argument, extra, selected] of [
    ["", "", "", true],
    ["", ", { params: { id: 'known' } }", "", false],
    ["options.params = { id: 1 };", ", {}", "", false],
    ["const alias = options; alias.params = { id: 1 };", ", {}", "", false],
    ["escape(options);", ", {}", "", false],
    ["const mutate = () => { options.params = { id: 1 } }; mutate();", ", {}", "", false],
    ["", ", { ...dynamic }", "", false],
    ["", ", { get params() { return dynamic } }", "", false],
    ["", ", {}", "Object.prototype.params = dynamic;", false],
  ] as const) {
    const found = await reader.of([source("options.ts", fixture(before, argument, extra))], "repo");
    assert.equal(found.some((site) => site.line === 7), selected, before || argument || extra);
    assert.ok(found.every((site) => site.target.status === "unknown"));
  }
});

test("caller-local object facts are withdrawn after mutation or escape", async () => {
  for (const [change, selected] of [
    ["", true],
    ["options.params = { id: 1 };", false],
    ["const alias = options; alias.params = { id: 1 };", false],
    ["escape(options);", false],
    ["const mutate = () => { options.params = { id: 1 } }; mutate();", false],
  ] as const) {
    const files = [source("local-options.ts", [
      "import { HttpClient } from '@angular/common/http'; import { base } from './unread'",
      "class Client { constructor(private http: HttpClient) {}",
      "transform(path: string, params: unknown) { if (!params) return path; return opaque(path, params) }",
      "post(path: string, options: any) { const url = base + this.transform(path, options?.params); return this.http.post(url, {}) }",
      "}",
      `class Api { constructor(private client: Client) {} send() { const options: any = {}; ${change} return this.client.post('/orders', options) } }`,
    ].join("\n"))];
    const found = await reader.of(files, "repo");
    assert.equal(found.some((site) => site.line === 6), selected, change);
    assert.ok(found.every((site) => site.target.status === "unknown"));
  }
});

test("guarded URL operations retain uncertainty when their builtin is replaced", async () => {
  const fixture = (write: string): string => [
    "import { HttpClient } from '@angular/common/http'; import { base } from './unread'",
    write,
    "class Client { constructor(private http: HttpClient) {}",
    "path(value: string) { if (value.startsWith('https://')) return value; return base + '/' + value.replace(/^\\/+/, '') }",
    "get(path: string) { return this.http.get(this.path(path)) } }",
    "class Api { constructor(private client: Client) {} send() { return this.client.get('/orders') } }",
  ].join("\n");
  for (const [write, selected] of [["", true], ["String.prototype.startsWith = other;", false]] as const) {
    const found = await reader.of([source("builtin.ts", fixture(write))], "repo");
    assert.equal(found.some((site) => site.line === 6), selected);
    assert.ok(found.every((site) => site.target.status === "unknown"));
  }
});

test("helper return agreement preserves encoding and parameter identity", async () => {
  for (const statements of [
    "if (flag) return encodeURIComponent(id); return id",
    "if (flag) return id; return encodeURIComponent(id)",
    "if (flag) return id; return other",
  ]) {
    const files = [source("merge.ts", [
      `class Client { path(id: string, other: string) { ${statements} }`,
      "get(id: string, other: string) { return fetch('/items/' + this.path(id, other)) }",
      "load() { return this.get('a/b', 'different') } }",
    ].join("\n"))];
    const found = await reader.of(files, "repo");
    const caller = found.find((site) => site.symbol === "Client.load");
    assert.ok(caller);
    assert.equal(caller.target.status, "unknown");
  }
});

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

test("whatever function encodeURIComponent names at run time, what it encodes from a run-time value is a run-time value", async () => {
  const listener = source("resize.ts", "import { fromEvent } from 'rxjs'; fromEvent(window, 'resize').subscribe(() => {});");
  const encoded = source("encoded.ts", "export function load(id: string) { return fetch(`/api/items/${encodeURIComponent(id)}`) }");
  const literal = source("literal.ts", "fetch(`/api/${encodeURIComponent('x')}`)");
  assert.deepEqual(sites(await reader.of([listener, encoded, literal], "repo")), ["GET /api/items/{}@encoded.ts:1", "unknown unresolved@literal.ts:1"]);
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
  const component = source("src/client.ts", ["import { HttpClient } from '@angular/common/http'", "class Client {", "  constructor(private http: HttpClient) {}", "  send() {", "    function nested(http: HttpClient) {", "      http.get('/orders')", "    }", "  }", "}"].join("\n"));
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
    "    const callback = function inner(http: HttpClient) { return http.get('/products') }",
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

  assert.deepEqual(sites(await reader.of([component], "shop-web")), ["GET /orders/7@src/app/app.component.ts:6"]);
});

test("only Angular's inject, under any import name, makes a field an HttpClient: an inject from another module proves nothing", async () => {
  const service = (path: string, inject: string, call: string) =>
    source(path, ["import { HttpClient } from '@angular/common/http'", inject, "export class Api {", `  private readonly http = ${call}(HttpClient)`, "  load(): void {", "    this.http.get('orders/7')", "  }", "}"].join("\n"));
  const aliased = service("aliased.ts", "import { inject as di } from '@angular/core'", "di");
  const namespaced = service("namespaced.ts", "import * as ng from '@angular/core'", "ng.inject");
  const foreign = service("foreign.ts", "import { inject } from './container'", "inject");

  assert.deepEqual(sites(await reader.of([aliased, namespaced, foreign], "shop-web")), ["GET /orders/7@aliased.ts:6", "GET /orders/7@namespaced.ts:6"]);
});

test("this inside a function expression or an object literal's method is not the class: its fields are not the receiver's", async () => {
  const file = source("rebound.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Client {",
    "  constructor(private http: HttpClient) {}",
    "  load() {",
    "    const later = function () { return this.http.get('/function') }",
    "    const handlers = { run() { return this.http.get('/method') } }",
    "    return () => this.http.get('/arrow')",
    "  }",
    "}",
  ].join("\n"));

  assert.deepEqual(sites(await reader.of([file], "shop-web")), ["GET /arrow@rebound.ts:7"]);
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

  assert.deepEqual(sites(await reader.of([api, caller], "shop-web")), ["POST /orders-api/orders/checkout@src/app/order/order.service.ts:6"]);
});

test("a parameter the code fills at run time is a placeholder: `${expr}` and `:name` are both `{}`", async () => {
  const component = source(
    "src/app/app.component.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "export class AppComponent {", "  private readonly http = inject(HttpClient)", "  load(orderId: string, page: number): void {", "    this.http.get(`orders/${orderId}/lines?page=${page}`)", "    this.http.delete('orders/:id')", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([component], "shop-web")), ["GET /orders/{}/lines@src/app/app.component.ts:6", "DELETE /orders/{}@src/app/app.component.ts:7"]);
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

  assert.deepEqual(sites(await reader.of([service], "shop-web")), ["GET /shop-api/orders/7@src/app/order/order.service.ts:7"]);
});

test("a path part that names a static member is the value its initializer states", async () => {
  const service = source(
    "src/app/order/order.api.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "export class OrderApi {", "  private static readonly BASE = 'shop-api'", "  private readonly http = inject(HttpClient)", "  load(): void {", "    this.http.get(`${OrderApi.BASE}/orders`)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([service], "shop-web")), ["GET /shop-api/orders@src/app/order/order.api.ts:7"]);
});

test("a field whose initializer the snapshot does not decide keeps the path undecided", async () => {
  const service = source(
    "src/app/order/order.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "export class OrderService {", "  private readonly base = this.pick()", "  private readonly http = inject(HttpClient)", "  private pick(): string { return lookup() }", "  load(): void {", "    this.http.get(`${this.base}/orders`)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([service], "shop-web")), ["unknown unresolved@src/app/order/order.service.ts:8"]);
});

test("a static member of an imported class resolves through the import", async () => {
  const api = source("src/app/order/order.api.ts", ["export class OrderApi {", "  static readonly BASE = 'shop-api'", "}"].join("\n"));
  const service = source(
    "src/app/order/order.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "import { OrderApi } from './order.api'", "export class OrderService {", "  private readonly http = inject(HttpClient)", "  load(): void {", "    this.http.get(`${OrderApi.BASE}/orders`)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([api, service], "shop-web")), ["GET /shop-api/orders@src/app/order/order.service.ts:7"]);
});

test("a member of an enum the snapshot holds is the text its initializer states, and only a stated text", async () => {
  const settings = source("src/app/settings.models.ts", ["export const GENERAL = 'outer'", "export enum Settings { GENERAL = 'general', 'QUICK_LINKS' = 'quick-links', COUNT = 1, NEXT, ALIAS = GENERAL }"].join("\n"));
  const service = source(
    "src/app/settings.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "import { Settings } from './settings.models'", "enum Local { DOCS = 'docs' }", "export class SettingsService {", "  private readonly http = inject(HttpClient)", "  load(): void {",
      "    this.http.get(`/api/settings/${Settings.GENERAL}`)", "    this.http.get(`/api/settings/${Settings.QUICK_LINKS}`)", "    this.http.get(`/api/settings/${Local.DOCS}`)", "    this.http.get(`/api/settings/${Settings.NEXT}`)", "    this.http.get(`/api/settings/${Settings.ALIAS}`)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([settings, service], "shop-web")), [
    "GET /api/settings/general@src/app/settings.service.ts:8",
    "GET /api/settings/quick-links@src/app/settings.service.ts:9",
    "GET /api/settings/docs@src/app/settings.service.ts:10",
    "unknown unresolved@src/app/settings.service.ts:11",
    "unknown unresolved@src/app/settings.service.ts:12",
  ]);
});

test("a name a barrel re-exports with `export *` resolves through it", async () => {
  const orders = source("src/app/api/orders.ts", "export const ORDERS = 'orders-api/orders'");
  const barrel = source("src/app/api/index.ts", "export * from './orders'");
  const service = source(
    "src/app/order/order.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "import { ORDERS } from '../api'", "export class OrderService {", "  private readonly http = inject(HttpClient)", "  load(): void {", "    this.http.get(ORDERS)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([orders, barrel, service], "shop-web")), ["GET /orders-api/orders@src/app/order/order.service.ts:7"]);
});

test("a barrel resolves only a name the language exports through it: never one two star exports both supply, nor one its target does not export", async () => {
  const service = (path: string, from: string) =>
    source(path, ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", `import { ORDERS } from '${from}'`, "export class OrderService {", "  private readonly http = inject(HttpClient)", "  load(): void {", "    this.http.get(ORDERS)", "  }", "}"].join("\n"));
  const files = [
    source("src/a/orders.ts", "export const ORDERS = 'a/orders'"),
    source("src/a/legacy.ts", "export const ORDERS = 'legacy/orders'"),
    source("src/a/index.ts", "export * from './orders'\nexport * from './legacy'"),
    source("src/b/hidden.ts", "const ORDERS = 'hidden/orders'\nexport const OTHER = 'other'"),
    source("src/b/index.ts", "export * from './hidden'"),
    service("src/ambiguous.ts", "./a"),
    service("src/hidden.ts", "./b"),
  ];

  assert.deepEqual(sites(await reader.of(files, "shop-web")), ["unknown unresolved@src/ambiguous.ts:7", "unknown unresolved@src/hidden.ts:7"]);
});

test("a name a barrel re-exports by name resolves through it", async () => {
  const orders = source("src/app/api/orders.ts", "export const ORDERS = 'orders-api/orders'");
  const barrel = source("src/app/api/index.ts", "export { ORDERS } from './orders'");
  const service = source(
    "src/app/order/order.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "import { ORDERS } from '../api'", "export class OrderService {", "  private readonly http = inject(HttpClient)", "  load(): void {", "    this.http.get(ORDERS)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([orders, barrel, service], "shop-web")), ["GET /orders-api/orders@src/app/order/order.service.ts:7"]);
});

test("a member read through a namespace import resolves", async () => {
  const paths = source("src/app/api/paths.ts", "export const ORDERS = 'orders-api/orders'");
  const service = source(
    "src/app/order/order.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "import * as api from '../api/paths'", "export class OrderService {", "  private readonly http = inject(HttpClient)", "  load(): void {", "    this.http.get(api.ORDERS)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([paths, service], "shop-web")), ["GET /orders-api/orders@src/app/order/order.service.ts:7"]);
});

test("a member of a default-exported object resolves", async () => {
  const environment = source("src/environments/environment.ts", "export default { apiUrl: 'shop-api' }");
  const service = source(
    "src/app/order/order.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "import environment from '../../environments/environment'", "export class OrderService {", "  private readonly http = inject(HttpClient)", "  load(): void {", "    this.http.get(`${environment.apiUrl}/orders`)", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([environment, service], "shop-web")), ["GET /shop-api/orders@src/app/order/order.service.ts:7"]);
  const barrel = source("src/environments/index.ts", "export { default as environment } from './environment'");
  const throughBarrel = source("src/app/order/order.service.ts", service.content.replace("import environment from '../../environments/environment'", "import { environment } from '../../environments'"));
  assert.deepEqual(sites(await reader.of([environment, barrel, throughBarrel], "shop-web")), ["GET /shop-api/orders@src/app/order/order.service.ts:7"]);
});

test("a path two literals add resolves", async () => {
  const service = source(
    "src/app/order/order.service.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "const BASE = 'orders-api'", "export class OrderService {", "  private readonly http = inject(HttpClient)", "  load(): void {", "    this.http.get(BASE + '/orders')", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([service], "shop-web")), ["GET /orders-api/orders@src/app/order/order.service.ts:7"]);
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

  assert.deepEqual(sites(await reader.of([service], "shop-web")), ["GET /orders-api/orders@src/app/order/order.service.ts:7"]);
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

  assert.deepEqual(sites(await reader.of([service], "shop-web")), ["GET /orders-api/orders@src/app/order/order.service.ts:7"]);
});

test("a call through a wrapper the repository declares is a call site: the wrapper's own parameter is the path", async () => {
  const component = source(
    "src/app/order/order.api.ts",
    ["import { inject } from '@angular/core'", "import { RestClientService } from '../core/rest/services/client/rest-client.service'", "export const ORDERS_PATH = 'orders-api/orders'", "export class OrderApi {", "  private readonly rest = inject(RestClientService)", "  create(): void {", "    this.rest.post(ORDERS_PATH, {})", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([source(API, REST_CLIENT), component], "shop-web")), [`unknown unresolved@${API}:7`, "POST /orders-api/orders@src/app/order/order.api.ts:7"]);
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

test("a base URL the call declares leads the path", async () => {
  const component = source(
    "src/app/app.component.ts",
    ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "const DIRECTIONS_URL = 'https://maps.example.com/directions'", "export class AppComponent {", "  private readonly http = inject(HttpClient)", "  route(): void {", "    this.http.get('/route', { baseUrl: DIRECTIONS_URL })", "  }", "}"].join("\n"),
  );

  assert.deepEqual(sites(await reader.of([component], "shop-web")), ["GET https://maps.example.com/directions/route@src/app/app.component.ts:7"]);
});

test("a base URL written as a shorthand or under a quoted key is the base the call declares", async () => {
  const component = (path: string, options: string) =>
    source(path, ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "const baseUrl = 'https://maps.example.com'", "export class AppComponent {", "  private readonly http = inject(HttpClient)", "  route(): void {", `    this.http.get('/route', ${options})`, "  }", "}"].join("\n"));

  assert.deepEqual(sites(await reader.of([component("shorthand.ts", "{ baseUrl }"), component("quoted.ts", "{ 'baseUrl': baseUrl }")], "shop-web")), [
    "GET https://maps.example.com/route@quoted.ts:7",
    "GET https://maps.example.com/route@shorthand.ts:7",
  ]);
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

test("a method called on a receiver of a class the snapshot holds is read at its returns, and every override of a subclass must agree", async () => {
  const paging = source("src/app/paging.ts", [
    "export class Paging { constructor(public size: number) {}",
    "  toQuery(): string { let query = `?size=${this.size}`; if (this.size > 9) { query += '&big=1' } return query } }",
    "export class TimePaging extends Paging { start = 0",
    "  toQuery(): string { let query = super.toQuery(); query += `&start=${this.start}`; return query } }",
    "export class Route { value(): string { return '/a' } }",
    "export class OtherRoute extends Route { value(): string { return '/b' } }",
  ].join("\n"));
  const service = source("src/app/devices.service.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "import { inject } from '@angular/core'",
    "import { Paging, Route } from './paging'",
    "export class DevicesService { private readonly http = inject(HttpClient)",
    "  load(paging: Paging, route: Route) {",
    "    this.http.get(`/api/devices${paging.toQuery()}`)",
    "    this.http.get(`/api${route.value()}`)",
    "    this.http.get(`/api/${this.area()}/devices`)",
    "  }",
    "  private area(): string { return 'eu' } }",
  ].join("\n"));

  assert.deepEqual(sites(await reader.of([paging, service], "shop-web")), ["GET /api/devices@src/app/devices.service.ts:6", "unknown unresolved@src/app/devices.service.ts:7", "GET /api/eu/devices@src/app/devices.service.ts:8"]);
});

test("a method that reads its own parameters is not read, so a path it builds from an argument stays undecided", async () => {
  const file = source("helper.ts", ["import { HttpClient } from '@angular/common/http'", "class Client { constructor(private http: HttpClient) {}", "  url(path: string) { return `/items/${path}` }", "  load() { this.http.get(this.url('orders/active')) } }"].join("\n"));

  assert.deepEqual(sites(await reader.of([file], "shop-web")), ["unknown unresolved@helper.ts:4"]);
});

test("an override must agree whatever name the subclass's file gives the class it extends", async () => {
  const base = source("src/app/base.ts", "export class Base { path(): string { return '/old' } }");
  const child = source("src/app/child.ts", "import { Base as Parent } from './base'\nexport class Child extends Parent { override path(): string { return '/new' } }");
  const use = source("src/app/use.ts", "import { Base } from './base'\nexport function load(p: Base) { return fetch(p.path()) }");

  assert.deepEqual(sites(await reader.of([base, child, use], "shop-web")), ["unknown unresolved@src/app/use.ts:2"]);
});

test("a method the class or a subclass assigns through this is not read from its declaration", async () => {
  const file = source("paths.ts", [
    "class Field { path = () => '/old'; constructor() { this.path = () => '/new' } }",
    "class Method { path(): string { return '/old' } constructor() { this.path = () => '/new' } }",
    "class Base { path(): string { return '/old' } }",
    "class Sub extends Base { constructor() { super(); this.path = () => '/new' } }",
    "class Kept { path(): string { return '/kept' } }",
    "export function load(field: Field, method: Method, base: Base, kept: Kept) { fetch(field.path()); fetch(method.path()); fetch(base.path()); fetch(kept.path()) }",
  ].join("\n"));

  assert.deepEqual(sites(await reader.of([file], "shop-web")), ["GET /kept@paths.ts:6", "unknown unresolved@paths.ts:6", "unknown unresolved@paths.ts:6", "unknown unresolved@paths.ts:6"]);
});

test("a class or a function an import names is found through re-exports, local export aliases and default exports", async () => {
  const base = source("src/app/base.ts", "export class Base { path(): string { return '/old' } }\nexport default Base");
  const use = source("src/app/use.ts", "import { Base } from './base'\nexport function load(p: Base) { return fetch(p.path()) }");
  const barrel = source("src/app/barrel.ts", "export { Base as Parent } from './base'");
  const alias = source("src/app/alias.ts", "import { Base } from './base'\nexport { Base as Root }");
  const throughBarrel = source("src/app/a.ts", "import { Parent } from './barrel'\nexport class A extends Parent { override path(): string { return '/a' } }");
  const throughDefault = source("src/app/b.ts", "import Parent from './base'\nexport class B extends Parent { override path(): string { return '/b' } }");
  const throughAlias = source("src/app/c.ts", "import { Root } from './alias'\nexport class C extends Root { override path(): string { return '/c' } }");
  const anonymous = source("src/app/d.ts", "import { Base } from './base'\nexport default class extends Base { override path(): string { return '/d' } }");
  const paths = source("src/app/paths.ts", "export function itemsPath(): string { return '/api/items' }");
  const index = source("src/app/index.ts", "export * from './paths'");
  const caller = source("src/app/caller.ts", "import { itemsPath } from './index'\nexport function list() { return fetch(itemsPath()) }");

  assert.deepEqual(sites(await reader.of([base, use], "shop-web")), ["GET /old@src/app/use.ts:2"]);
  assert.deepEqual(sites(await reader.of([base, use, barrel, throughBarrel], "shop-web")), ["unknown unresolved@src/app/use.ts:2"]);
  assert.deepEqual(sites(await reader.of([base, use, throughDefault], "shop-web")), ["unknown unresolved@src/app/use.ts:2"]);
  assert.deepEqual(sites(await reader.of([base, use, alias, throughAlias], "shop-web")), ["unknown unresolved@src/app/use.ts:2"]);
  assert.deepEqual(sites(await reader.of([base, use, anonymous], "shop-web")), ["unknown unresolved@src/app/use.ts:2"]);
  assert.deepEqual(sites(await reader.of([paths, index, caller], "shop-web")), ["GET /api/items@src/app/caller.ts:2"]);
});

test("a member a class anywhere in the instance's hierarchy assigns through this is not read from its declaration", async () => {
  const file = source("hierarchy.ts", [
    "class Base { path(): string { return '/old' } constructor() { this.path = () => '/new' } }",
    "class Child extends Base { override path(): string { return '/child' } }",
    "class Top { url?: string; reset() { this.url = '/reset' } }",
    "class Mid extends Top { override url = '/mid' }",
    "class Leaf extends Mid { load() { fetch(this.url) } }",
    "export function load(child: Child) { fetch(child.path()) }",
  ].join("\n"));

  assert.deepEqual(sites(await reader.of([file], "shop-web")), ["unknown unresolved@hierarchy.ts:5", "unknown unresolved@hierarchy.ts:6"]);
});

test("an override the snapshot cannot read as a method leaves the call undecided", async () => {
  const file = source("accessor.ts", ["class Base { path(): string { return '/old' } }", "class Child extends Base { get path() { return () => '/new' } }", "export function load(p: Base) { fetch(p.path()) }"].join("\n"));

  assert.deepEqual(sites(await reader.of([file], "shop-web")), ["unknown unresolved@accessor.ts:3"]);
});

test("a parameter or a local the function assigns or declares again no longer types its receiver", async () => {
  const file = source("rebound.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "import { inject } from '@angular/core'",
    "export function load(http: HttpClient) { var http = new Map<string, string>() as any; http.get('/cached') }",
    "export function save(http: HttpClient) { http = other(); http.post('/saved', {}) }",
    "export function swap() { let http = inject(HttpClient); http = other(); http.get('/swapped') }",
    "export function keep(http: HttpClient) { const client = inject(HttpClient); http.get('/kept'); client.get('/client') }",
  ].join("\n"));

  assert.deepEqual(sites(await reader.of([file], "shop-web")), ["GET /kept@rebound.ts:6", "GET /client@rebound.ts:6"]);
});

test("a receiver a loop or a catch clause binds is not typed by an outer parameter of the same name", async () => {
  const file = source("cache.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "export function load(http: HttpClient) {",
    "  for (const http of [new Map<string, string>()]) { http.get('/cached') }",
    "  try { http.get('/api/items') } catch (http) { http.get('/failed') }",
    "}",
  ].join("\n"));

  assert.deepEqual(sites(await reader.of([file], "shop-web")), ["GET /api/items@cache.ts:4"]);
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

test("a request without a URL and its caller stay unknown while a recursive URL helper is not a request", async () => {
  const file = source("missing-url.ts", [
    "function path() { return path() }",
    "function empty() { return fetch() }",
    "function use() { return empty() }",
    "function direct() { return fetch(path()) }",
  ].join("\n"));
  const found = await reader.of([file], "repo");
  assert.ok(found.some((site) => site.line === 2 && site.target.status === "unknown" && site.diagnostic?.cause === "destination-undecidable"));
  assert.ok(found.some((site) => site.line === 3 && site.target.status === "unknown" && site.diagnostic?.cause === "destination-undecidable"));
  assert.ok(found.some((site) => site.line === 4 && site.target.status === "unknown" && site.diagnostic?.cause === "recursive"));
  assert.equal(found.some((site) => site.line === 1), false);
});

test("an undecided call carries its cause: a path function that calls itself, overrides that disagree, or a base the snapshot does not decide", async () => {
  const routes = source("src/app/routes.ts", ["export class Route { value(): string { return '/a' } }", "export class OtherRoute extends Route { value(): string { return '/b' } }"].join("\n"));
  const service = source("src/app/devices.service.ts", ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "import { Route } from './routes'", "export class DevicesService { private readonly http = inject(HttpClient)", "  load(route: Route) { this.http.get(`/api${route.value()}`) } }"].join("\n"));
  const causes = async (files: readonly { path: string; content: string }[]) => (await reader.of(files, "shop-web")).map((site) => [site.target.status, site.diagnostic?.cause, site.stated === undefined ? undefined : { method: site.stated.method, ...(site.stated.path === undefined ? {} : { path: site.stated.path }) }]);

  assert.deepEqual(await causes([pathFunction(" return orderPath(!open)")]), [["unknown", "recursive", { method: "GET" }]]);
  assert.deepEqual(await causes([routes, service]), [["unknown", "dispatch-disagreement", { method: "GET" }]]);
  assert.deepEqual(await causes([component("    this.http.get('/route', { baseUrl: method })")]), [["unknown", "destination-undecidable", { method: "GET", path: "/route" }]]);
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

test("a URL that names its host, after `scheme://` or a bare `//`, overrides the base the call declares, decided or not", async () => {
  assert.deepEqual(sites(await reader.of([component("    this.http.get('//maps.example.com/route?q=1', { baseUrl: method })")], "shop-web")), ["GET //maps.example.com/route@src/app/app.component.ts:6"]);
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

test("wrapper paths computed by a helper and non-verb methods are placed at their callers", async () => {
  const client = source(
    API,
    ["import { HttpClient } from '@angular/common/http'", "import { inject, Injectable } from '@angular/core'", "@Injectable({ providedIn: 'root' })", "export class RestClientService {", "  private readonly http = inject(HttpClient)", "  get(path: string): void {", "    const url = this.resolve(path)", "    this.http.get(url)", "  }", "  item(id: string): void {", "    this.http.get(`/items/${id}`)", "  }", "  private resolve(path: string): string {", "    return this.base + '/' + path", "  }", "  private readonly base = 'api'", "}"].join("\n"),
  );
  const page = source("src/app/items/items.page.ts", ["import { inject } from '@angular/core'", "import { RestClientService } from '../core/rest/services/client/rest-client.service'", "export class ItemsPage {", "  private readonly rest = inject(RestClientService)", "  load(): void {", "    this.rest.get('/items')", "    this.rest.item('7')", "  }", "}"].join("\n"));

  assert.deepEqual(sites(await reader.of([client, page], "shop-web")), ["GET /api/items@src/app/items/items.page.ts:6", "GET /items/7@src/app/items/items.page.ts:7"]);
});

test("calls supplying wrapper parameters own sites even when the parameter is inside the path", async () => {
  const service = source("src/app/items.service.ts", ["import { HttpClient } from '@angular/common/http'", "import { inject } from '@angular/core'", "export class ItemsService {", "  private readonly http = inject(HttpClient)", "  delete(name: string) { return this.http.delete(`/items/${encodeURIComponent(name)}`) }", "  put(id: string) { return this.http.put(`/items/${id}/details`, {}) }", "  get(id: string) { return this.http.get(this.itemUrl(id)) }", "  itemUrl(id: string) { return `/items/${encodeURIComponent(id)}` }", "}"].join("\n"));
  const dialog = source("src/app/items.dialog.ts", ["import { inject } from '@angular/core'", "import { ItemsService } from './items.service'", "export class ItemsDialog {", "  private readonly items = inject(ItemsService)", "  confirm(name: string) { this.items.delete(name); this.items.put(name); this.items.get(name) }", "}"].join("\n"));

  assert.deepEqual(sites(await reader.of([service, dialog], "shop-web")), ["DELETE /items/{}@src/app/items.dialog.ts:5", "PUT /items/{}/details@src/app/items.dialog.ts:5", "GET /items/{}@src/app/items.dialog.ts:5"]);
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
  assert.deepEqual(sites(await reader.of([workspace({ SERVER_API_URL: "''" }), constants, service], "shop-web")), [`GET /api/orders@${SERVICE}:7`]);
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
  assert.deepEqual(sites(await reader.of([workspace({ SERVER_API_URL: "''" }), constants, base, service], "shop-web")), [`GET /api/orders/{}@${SERVICE}:6`, `GET /legacy/orders@${SERVICE}:11`]);
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
  assert.deepEqual(sites(await reader.of([configured, constants, service], "shop-web")), [`GET /api/orders@${SERVICE}:7`]);
});

test("a define reaches only the sources of the project that declares it", async () => {
  const nested = source("angular.json", JSON.stringify({ projects: { web: { root: "", architect: { build: { builder: "@angular/build:application", options: { define: { SERVER_API_URL: "''" } } } } }, lib: { root: "projects/lib", architect: { build: { builder: "@angular/build:ng-packagr" } } } } }));
  const inLib = { path: `projects/lib/${CONSTANTS}`, content: constants.content };
  const libService = { path: `projects/lib/${SERVICE}`, content: orderService("this.http.get(this.resourceUrl)").content };
  assert.deepEqual(sites(await reader.of([nested, inLib, libService], "shop-web")), [`unknown unresolved@projects/lib/${SERVICE}:7`]);
  const reversed = source("angular.json", JSON.stringify({ projects: { web: { root: "", architect: { build: { builder: "@angular/build:application" } } }, lib: { root: "projects/lib", architect: { build: { builder: "@angular/build:application", options: { define: { SERVER_API_URL: "''" } } } } } } }));
  assert.deepEqual(sites(await reader.of([reversed, inLib, libService], "shop-web")), [`GET /api/orders@projects/lib/${SERVICE}:7`]);
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
    `GET /api/orders/{}@${SERVICE}:7`,
    `GET /api/orders/{}@${SERVICE}:8`,
    `GET /api/orders/{}@${SERVICE}:9`,
    `GET /api/orders@${SERVICE}:10`,
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
  assert.deepEqual(sites(await reader.of([local], "shop-web")), [`GET /api/orders@${SERVICE}:5`, `GET /api/orders@${SERVICE}:6`]);
});

test("a name imported from a module the snapshot does not hold is not replaced by a define of the same name", async () => {
  const imported = source(CONSTANTS, ["import { SERVER_API_URL } from './missing'", "export const serverApiUrl = SERVER_API_URL;"].join("\n"));
  assert.deepEqual(sites(await reader.of([workspace({ SERVER_API_URL: "''" }), imported, orderService("this.http.get(this.resourceUrl)")], "shop-web")), [`unknown unresolved@${SERVICE}:7`]);
});

test("a nested wrapper places its request at the nearest call supplying the path", async () => {
  const file = source("nested.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "const environment = { apiUrl: 'http://h/api/v1' }",
    "class Crud {",
    "  constructor(private http: HttpClient) {}",
    "  get(path: string) { return this.http.get(`${environment.apiUrl}/${path}`) }",
    "}",
    "class Svc {",
    "  constructor(private crud: Crud) {}",
    "  item(id: string) { return this.crud.get(`items/${id}`) }",
    "}",
    "class Page {",
    "  constructor(private svc: Svc) {}",
    "  load() { return this.svc.item('42') }",
    "}",
  ].join("\n"));
  assert.deepEqual(sites(await reader.of([file], "repo")), ["GET http://h/api/v1/items/{}@nested.ts:9"]);
  const [placed] = await reader.placed([file], "repo");
  assert.deepEqual(placed?.origins?.map(({ kind, file: path, line }) => [kind, path, line]), [["body", "nested.ts", 5], ["leaf", "nested.ts", 5]]);
  assert.equal(placed?.column, file.content.split("\n")[8]!.indexOf("this.crud.get"));
});

test("encoded wrapper parameters never become unescaped literal path segments", async () => {
  const file = source("encoded-wrapper.ts", [
    "function get(id: string) { return fetch('/items/' + encodeURIComponent(id)) }",
    "function slash() { return get('a/b') }",
    "function query() { return get('a?b') }",
    "function fragment() { return get('a#b') }",
    "function plain() { return get('abc') }",
    "function direct() { return fetch('/items/' + encodeURIComponent('a/b')) }",
    "function raw(id: string) { return fetch('/other/' + id) }",
    "function relay(id: string) { return raw(encodeURIComponent(id)) }",
    "function caller() { return relay('a/b') }",
  ].join("\n"));
  assert.deepEqual(sites(await reader.of([file], "repo")), ["GET /items/{}@encoded-wrapper.ts:2", "GET /items/{}@encoded-wrapper.ts:3", "GET /items/{}@encoded-wrapper.ts:4", "GET /items/{}@encoded-wrapper.ts:5", "GET /items/a%2Fb@encoded-wrapper.ts:6", "GET /other/{}@encoded-wrapper.ts:8"]);
});

test("only a proven external factory without project callbacks leaves the represented request graph", async () => {
  const manifest = source("package.json", JSON.stringify({ dependencies: { "external-package": "1" } }));
  const make = (initializer: string, prefix = "import { factory } from 'external-package'\n") => source("factory.ts", `${prefix}class App { view = ${initializer}; run() { this.view() } start() { this.run() } }`);
  const external = await reader.placed([manifest, make("factory('token')")], "repo");
  assert.deepEqual(external, []);
  const inherited = source("factory.ts", "import { factory } from 'external-package'\nclass Token {} class Base { view = factory.required(Token) } class App extends Base { run() { this.view() } start() { this.run() } }");
  assert.deepEqual(await reader.placed([manifest, inherited], "repo"), []);
  for (const files of [
    [make("factory('token')")],
    [manifest, make("factory(callback)", "import { factory } from 'external-package'\nfunction callback() { return fetch('/x') }\n")],
    [manifest, make("factory()", "function factory() { return () => fetch('/x') }\n")],
    [manifest, make("factory('token')", "import type { factory } from 'external-package'\n")],
    [manifest, source("factory.ts", "import { factory } from 'external-package'\nclass App { get view() { return factory('x') } run() { this.view() } start() { this.run() } }")],
    [manifest, source("factory.ts", "import { factory } from 'external-package'\nclass App { view = factory('x'); swap() { this.view = () => fetch('/x') } run() { this.view() } start() { this.run() } }")],
    [manifest, source("factory.ts", "import { factory } from 'external-package'\nclass App { view = factory('x'); run() { this.view() } start() { this.run() } } class Child extends App { override view = () => fetch('/x') }")],
    [manifest, source("factory.ts", "import { factory } from 'external-package'\nfactory.required = () => () => fetch('/x'); class App { view = factory.required('x'); run() { this.view() } start() { this.run() } }")],
    [manifest, source("factory.ts", "import { factory } from 'external-package'\nconst factory = () => () => fetch('/x'); class App { view = factory(); run() { this.view() } start() { this.run() } }")],
  ]) {
    const sites = await reader.placed(files, "repo");
    assert.ok(sites.some(({ site }) => site.diagnostic?.cause === "dispatch-disagreement"));
  }
  const arrow = await reader.placed([source("factory.ts", "class App { view = (url: string) => fetch(url); run() { this.view('/x') } }")], "repo");
  assert.deepEqual(sites(arrow.map(({ site }) => site)), ["GET /x@factory.ts:1"]);
});

test("the first caller supplying any reordered hole owns the site even when another hole remains", async () => {
  const file = source("nearest.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Crud { constructor(private http: HttpClient) {}",
    "  get(left: string, right?: string) { return this.http.get(`/api/${right}/${left}`) } }",
    "class Svc { constructor(private crud: Crud) {}",
    "  item(id: string) { return this.crud.get(`id/${id}`) } }",
    "class Page { constructor(private svc: Svc) {}",
    "  load() { return this.svc.item('42') } }",
  ].join("\n"));
  assert.deepEqual(sites(await reader.of([file], "repo")), ["GET /api/{}/id/{}@nearest.ts:5"]);
});

test("request lookup requires a column when two requests share a line", async () => {
  const file = source("same-line.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Client { constructor(private http: HttpClient) {}",
    "load() { this.http.get('/a'); this.http.get('/b') } }",
  ].join("\n"));
  const lookup = await createRequestCallLookup([file]);
  const at = { file: file.path, line: 3, symbol: "Client.load" };
  assert.equal(lookup.at(at), undefined);
  const column = file.content.split("\n")[2]!.indexOf("this.http.get('/b')") + 1;
  const call = lookup.at({ ...at, column });
  assert.equal(call?.getText(), "this.http.get('/b')");
  assert.ok(call !== undefined && lookup.isRequest(call));
});

test("two identical wrapper calls on the same line remain distinct sites", async () => {
  const file = source("same-wrapper.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Crud { constructor(private http: HttpClient) {} get(path: string) { return this.http.get(path) } }",
    "class Page { constructor(private crud: Crud) {} load() { this.crud.get('/items'); this.crud.get('/items') } }",
  ].join("\n"));
  const found = await reader.of([file], "repo");
  assert.equal(found.length, 2);
  assert.notEqual(found[0]?.column, found[1]?.column);
});

test("a wrapper with an unread callee does not assert its known request as the only possible request", async () => {
  const file = source("gap.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "abstract class Unread { abstract load(): unknown }",
    "class Crud { constructor(private http: HttpClient, private unread: Unread) {}",
    "  get(path: string) { this.unread.load(); return this.http.get(path) } }",
    "class Svc { constructor(private crud: Crud) {}",
    "  load() { return this.crud.get('/items') } }",
    "class Root { constructor(private svc: Svc) {} run() { return this.svc.load() } }",
  ].join("\n"));
  const found = await reader.of([file], "repo");
  const site = found.find((item) => item.symbol === "Svc.load");
  assert.equal(site?.target.status, "unknown");
  assert.equal(site?.diagnostic?.cause, "source-not-read");
  assert.equal(site?.stated, undefined);
  assert.ok(site?.target.evidence.some((item) => item.path === "gap.ts" && item.line === 4));
  assert.equal(found.some((item) => item.symbol === "Root.run"), false);
});

test("a conditional wrapper keeps alternatives unless the caller decides the condition", async () => {
  const file = source("conditional.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Crud { constructor(private http: HttpClient) {}",
    "  get(all: boolean, id: string) { return this.http.get(all ? `/all/${id}` : `/one/${id}`) } }",
    "class Svc { constructor(private crud: Crud) {}",
    "  undecided(all: boolean, id: string) { return this.crud.get(all, id) }",
    "  literal(id: string) { return this.crud.get(true, id) } }",
  ].join("\n"));
  const found = await reader.of([file], "repo");
  const undecided = found.find((site) => site.symbol === "Svc.undecided");
  assert.equal(undecided?.target.status, "unknown");
  assert.equal(undecided?.diagnostic?.cause, "destination-undecidable");
  assert.deepEqual(undecided?.diagnostic?.alternatives, ["/all/{}", "/one/{}"]);
  assert.deepEqual(sites(found.filter((site) => site.symbol === "Svc.literal")), ["GET /all/{}@conditional.ts:6"]);
});

test("conditional wrapper alternatives include the branch without a hole", async () => {
  const file = source("conditional-empty.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Crud { constructor(private http: HttpClient) {}",
    "  get(all: boolean, id: string) { return this.http.get('/items' + (all ? '' : '/' + id)) } }",
    "class Svc { constructor(private crud: Crud) {}",
    "  load(all: boolean, id: string) { return this.crud.get(all, id) }",
    "  all(id: string) { return this.crud.get(true, id) } }",
  ].join("\n"));
  const found = await reader.of([file], "repo");
  const site = found.find((item) => item.symbol === "Svc.load");
  assert.equal(site?.target.status, "unknown");
  assert.deepEqual(site?.diagnostic?.alternatives, ["/items", "/items/{}"]);
  assert.deepEqual(sites(found.filter((item) => item.symbol === "Svc.all")), ["GET /items@conditional-empty.ts:6"]);
});

test("a wrapper preserves the base URL stated in request options", async () => {
  const file = source("base-option.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Crud { constructor(private http: HttpClient) {}",
    "  get(path: string) { return this.http.get(path, { baseUrl: 'http://h/api' }) } }",
    "class Svc { constructor(private crud: Crud) {}",
    "  load() { return this.crud.get('/items') } }",
  ].join("\n"));
  assert.deepEqual(sites(await reader.of([file], "repo")), ["GET http://h/api/items@base-option.ts:5"]);
});

test("agreeing virtual wrapper implementations retain both leaves at the first eligible caller", async () => {
  const file = source("dispatch.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Base { constructor(protected http: HttpClient) {} get(id: string) { return this.http.get(`/items/${id}`) } }",
    "class Child extends Base { override get(id: string) { return this.http.get(`/items/${id}`) } }",
    "class Page { constructor(private service: Base) {} load(id: string) { return this.service.get(id) } }",
    "class Root { constructor(private page: Page) {} run() { return this.page.load('7') } }",
  ].join("\n"));
  const found = await reader.placed([file], "repo");
  assert.deepEqual(sites(found.map(({ site }) => site)), ["GET /items/{}@dispatch.ts:4"]);
  assert.deepEqual([...new Set(found[0]?.origins?.filter((item) => item.kind === "leaf").map((item) => item.line))].sort(), [2, 3]);
  const lookup = await createRequestCallLookup([file]);
  const call = lookup.at({ file: "dispatch.ts", line: 4, symbol: "Page.load" });
  assert.ok(call !== undefined);
  const summary = lookup.of(call);
  assert.ok(summary !== undefined && !("kind" in summary) && summary.shapes.length === 2);
});

test("virtual candidates that differ or issue no request never agree by union", async () => {
  for (const implementation of ["return this.http.get(`/other/${id}`)", "return undefined"]) {
    const file = source("dispatch-different.ts", [
      "import { HttpClient } from '@angular/common/http'",
      "class Base { constructor(protected http: HttpClient) {} get(id: string) { return this.http.get(`/items/${id}`) } }",
      `class Child extends Base { override get(id: string) { ${implementation} } }`,
      "class Page { constructor(private service: Base) {} load(id: string) { return this.service.get(id) } }",
    ].join("\n"));
    const site = (await reader.of([file], "repo")).find((item) => item.symbol === "Page.load");
    assert.equal(site?.target.status, "unknown");
    assert.equal(site?.diagnostic?.cause, "dispatch-disagreement");
  }
});

test("virtual candidates may agree on a path pattern while retaining different caller parameters", async () => {
  const file = source("dispatch-parameters.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Base { constructor(protected http: HttpClient) {} get(a: string, b: string) { return this.http.get(`/items/${a}`) } }",
    "class Child extends Base { override get(a: string, b: string) { return this.http.get(`/items/${b}`) } }",
    "class Page { constructor(private service: Base) {} load(a: string, b: string) { return this.service.get(a, b) } }",
    "class Root { constructor(private page: Page) {} run() { return this.page.load('same', 'same') } }",
  ].join("\n"));
  assert.deepEqual(sites(await reader.of([file], "repo")), ["GET /items/{}@dispatch-parameters.ts:4"]);
});

test("super calls resolve the inherited body without virtual candidates", async () => {
  const file = source("dispatch-super.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Base { constructor(protected http: HttpClient) {} get(id: string) { return this.http.get(`/items/${id}`) } }",
    "class Child extends Base { override get(id: string) { return super.get(id) } }",
    "class Page { constructor(private service: Child) {} load(id: string) { return this.service.get(id) } }",
  ].join("\n"));
  assert.deepEqual(sites(await reader.of([file], "repo")), ["GET /items/{}@dispatch-super.ts:3"]);
});

test("virtual candidates compare the final URL after applying each request base", async () => {
  const file = source("dispatch-base.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Base { constructor(protected http: HttpClient) {} get(id: string) { return this.http.get(`/api/items/${id}`) } }",
    "class Child extends Base { override get(id: string) { return this.http.get(`/items/${id}`, { baseUrl: '/api' }) } }",
    "class Page { constructor(private service: Base) {} load(id: string) { return this.service.get(id) } }",
  ].join("\n"));
  assert.deepEqual(sites(await reader.of([file], "repo")), ["GET /api/items/{}@dispatch-base.ts:4"]);
});

test("an unread virtual candidate retains a source-not-read gap at the caller", async () => {
  const file = source("dispatch-unread.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Base { constructor(protected http: HttpClient) {} get(id: string) { return this.http.get(`/items/${id}`) } }",
    "abstract class Child extends Base { abstract override get(id: string): any }",
    "class Page { constructor(private service: Base) {} load(id: string) { return this.service.get(id) } }",
    "class Root { constructor(private page: Page) {} run() { return this.page.load('7') } }",
  ].join("\n"));
  const found = await reader.of([file], "repo");
  const site = found.find((item) => item.symbol === "Page.load");
  assert.equal(site?.target.status, "unknown");
  assert.equal(site?.diagnostic?.cause, "source-not-read");
  assert.equal((await reader.placed([file], "repo")).find(({ site: placed }) => placed.symbol === "Page.load")?.issuingBoundary, undefined);
  assert.equal(found.some((item) => item.symbol === "Root.run"), false);
});

test("an independent unread call on the same line is not hidden by a handled virtual gap", async () => {
  const file = source("dispatch-separate.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Base { constructor(protected http: HttpClient) {} get(id: string) { return this.http.get(`/items/${id}`) } }",
    "abstract class Child extends Base { abstract override get(id: string): any }",
    "abstract class Other { abstract run(): any }",
    "class Page { constructor(private service: Base, private other: Other) {} load(id: string) { this.service.get(id); return this.other.run() } }",
    "class Root { constructor(private page: Page) {} run() { return this.page.load('7') } }",
  ].join("\n"));
  const found = await reader.of([file], "repo");
  const outer = found.find((item) => item.symbol === "Root.run");
  assert.equal(outer?.target.status, "unknown");
  assert.equal(outer?.diagnostic?.cause, "source-not-read");
});

test("a request-relevant cycle in one virtual candidate keeps the caller unresolved", async () => {
  const file = source("dispatch-cycle.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Base { constructor(protected http: HttpClient) {} get(id: string) { return this.http.get(`/items/${id}`) } }",
    "class Child extends Base { override get(id: string) { this.loop(); return this.http.get(`/items/${id}`) }",
    "  loop() { this.loop(); return this.http.get('/other') } }",
    "class Page { constructor(private service: Base) {} load(id: string) { return this.service.get(id) } }",
  ].join("\n"));
  const site = (await reader.of([file], "repo")).find((item) => item.symbol === "Page.load");
  assert.equal(site?.target.status, "unknown");
  assert.equal(site?.diagnostic?.cause, "recursive");
  assert.ok(site?.target.evidence.some((at) => at.path === "dispatch-cycle.ts" && at.line === 3));
});

test("virtual candidates agreeing on conditional alternatives retain the runtime choice", async () => {
  const file = source("dispatch-choice.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Base { constructor(protected http: HttpClient) {} get(all: boolean, id: string) { return this.http.get(all ? `/all/${id}` : `/one/${id}`) } }",
    "class Child extends Base { override get(all: boolean, id: string) { return this.http.get(all ? `/all/${id}` : `/one/${id}`) } }",
    "class Page { constructor(private service: Base) {} load(all: boolean, id: string) { return this.service.get(all, id) } }",
  ].join("\n"));
  const site = (await reader.of([file], "repo")).find((item) => item.symbol === "Page.load");
  assert.equal(site?.target.status, "unknown");
  assert.equal(site?.diagnostic?.cause, "destination-undecidable");
  assert.deepEqual(site?.diagnostic?.alternatives, ["/all/{}", "/one/{}"]);
});

test("equal paths with unprovable different body sources do not establish virtual agreement", async () => {
  const file = source("dispatch-body.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Base { constructor(protected http: HttpClient) {} post(id: string) { return this.http.post(`/items/${id}`, { x: 1 }) } }",
    "class Child extends Base { override post(id: string) { return this.http.post(`/items/${id}`, { x: 2 }) } }",
    "class Page { constructor(private service: Base) {} load(id: string) { return this.service.post(id) } }",
  ].join("\n"));
  const site = (await reader.of([file], "repo")).find((item) => item.symbol === "Page.load");
  assert.equal(site?.target.status, "unknown");
  assert.equal(site?.diagnostic?.cause, "dispatch-disagreement");
});

test("callback request boundaries stay local to their own function bodies", async () => {
  const file = source("callbacks.ts", [
    "import { HttpClient } from '@angular/common/http'",
    "class Crud { constructor(private http: HttpClient) {} delete(path: string) { return this.http.delete('https://host/api' + path) } }",
    "class Page { constructor(private crud: Crud) {}",
    " run(event: any) { dialog.subscribe(ok => { if (ok) this.crud.delete('/arrow/' + event.id + '?id=' + event.id) }) }",
    " other() { dialog.subscribe(function (crud: Crud) { crud.delete('/function/1') }) }",
    "}",
    "function invoke(page: Page, event: any) { page.run(event) }",
  ].join("\n"));
  const sites = await reader.of([file], "repo");
  assert.deepEqual(sites.filter((site) => site.target.status === "complete").map((site) => [site.line, site.target.status === "complete" && "path" in site.target.value && site.target.value.path]).sort(), [
    [4, "https://host/api/arrow/{}"],
    [5, "https://host/api/function/1"],
  ]);
  assert.ok(!sites.some((site) => site.symbol === "invoke"));
});


const providerReader = createHttpCallSites([angularProviderContribution]);


const completeProviderPaths = (sites: readonly CallSite[]) => sites.flatMap((site) => site.target.status === "complete" && "path" in site.target.value ? [site.target.value.path] : []);

test("a registered injection token supplies a wrapper URL only with complete source and follows new captures", async () => {
  const files = providerValueFiles();
  assert.ok(completeProviderPaths(await providerReader.of(files, "repo", [], { completeSource: true })).includes("https://example.test/api/items"));
  assert.deepEqual(completeProviderPaths(await providerReader.of(files, "repo")), []);
  const changed = files.map((file) => file.path === "src/environment.ts" ? source(file.path, file.content.replace("example.test/api", "other.test/v2")) : file);
  assert.ok(completeProviderPaths(await providerReader.of(changed, "repo", [], { completeSource: true })).includes("https://other.test/v2/items"));
});

test("provider value proofs retain uncertainty for overrides, mutations, unsupported roots and build replacements", async () => {
  const cases = [
    ["src/main.ts", (text: string) => text + ` @Component({providers: [{provide: BASE, useValue:'other'}]}) class Other {}`],
    ["src/environment.ts", (text: string) => text + ` environment.url = 'other';`],
    ["src/config.ts", (text: string) => text + ` unknown(appConfig);`],
    ["src/config.ts", (text: string) => text.replace("providers: [", "...other, providers: [")],
    ["src/main.ts", (text: string) => text.replace("bootstrapApplication(App, appConfig)", "bootstrapApplication(App, appConfig); bootstrapApplication(App, appConfig)")],
    ["angular.json", (text: string) => text.replace("src/main.ts", "src/not-main.ts")],
    ["angular.json", (text: string) => text.replace('"browser":"src/main.ts"', '"browser":"src/main.ts","fileReplacements":[{"replace":"src/environment.ts","with":"src/environment.prod.ts"}]')],
  ] as const;
  for (const [path, change] of cases) {
    const files = providerValueFiles().map((file) => file.path === path ? source(file.path, change(file.content)) : file);
    assert.deepEqual(completeProviderPaths(await providerReader.of(files, "repo", [], { completeSource: true })), [], path);
  }
});

test("constructor token values require the injector rather than an explicit construction", async () => {
  const files = providerValueFiles().map((file) => file.path === "src/api.ts" ? source(file.path, file.content.replace("private base = inject(BASE); constructor(private http: HttpClient)", "constructor(@Inject(BASE) private base: string, private http: HttpClient)")) : file);
  assert.ok(completeProviderPaths(await providerReader.of(files, "repo", [], { completeSource: true })).includes("https://example.test/api/items"));
  const manual = files.map((file) => file.path === "src/api.ts" ? source(file.path, file.content + ` const api = new Api('different', null as any);`) : file);
  assert.deepEqual(completeProviderPaths(await providerReader.of(manual, "repo", [], { completeSource: true })), []);
});

test("aliases of provider-owned objects cannot mutate or escape without invalidating the value proof", async () => {
  for (const usage of [
    "const alias = appConfig.providers; alias.pop();",
    "function change() { const alias = appConfig.providers; alias.pop(); } change();",
    "const wrapper = { list: appConfig.providers }; unknown(wrapper);",
  ]) {
    const files = providerValueFiles().map((file) => file.path === "src/config.ts" ? source(file.path, file.content + usage) : file);
    assert.deepEqual(completeProviderPaths(await providerReader.of(files, "repo", [], { completeSource: true })), [], usage);
  }
});
