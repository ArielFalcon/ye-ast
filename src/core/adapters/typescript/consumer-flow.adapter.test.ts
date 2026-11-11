import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAccessPath, parseAccessPath } from "../../domain/contracts/access-path.ts";
import { siteLine, type Carrier, type CarrierSite, type FlowResult } from "../../domain/contracts/consumer-flow.ts";
import type { Predicate } from "../../domain/contracts/use-operation.ts";
import type { Guard } from "../../domain/contracts/verdict.ts";
import { consumerFlowReader } from "./consumer-flow.adapter.ts";
import { buildProgram } from "./consumer-flow.index.ts";
import { createRequestCallLookup } from "./http-call-sites.adapter.ts";

const COMMON = "import { HttpClient } from '@angular/common/http'\nimport { map, tap, switchMap, catchError } from 'rxjs'\nimport { firstValueFrom, of } from 'rxjs'\nimport { toSignal } from '@angular/core/rxjs-interop'\nimport { httpResource } from '@angular/common/http'\nimport { resource, signal, computed, input } from '@angular/core'\n";
const HEADER_LINES = COMMON.split("\n").length - 1;

/** A source whose body starts at line `HEADER_LINES + 1`. */
function source(path: string, lines: readonly string[]) {
  return { path, content: COMMON + lines.join("\n") };
}

const at = (line: number) => line + HEADER_LINES;

async function follow(files: readonly { path: string; content: string }[], site: CarrierSite, path: string): Promise<FlowResult> {
  const [program, lookup] = await Promise.all([buildProgram(files), createRequestCallLookup(files)]);
  const reader = consumerFlowReader(program, "repo", lookup);
  const carrier: Carrier = { site, path: parseAccessPath(path)! };
  return reader.follow(carrier);
}

const callSite = (file: string, line: number, symbol: string): Extract<CarrierSite, { kind: "call-site" }> => ({ kind: "call-site", repo: "repo", file, line: at(line), symbol });

const dotted = (path: readonly string[]) => formatAccessPath(path) || "[]";
const uses = (result: FlowResult) => result.uses.map((use) => `${use.site.line - HEADER_LINES} ${dotted(use.path)}|${dotted(use.changed)} [${use.guards.map((guard) => guard.kind).join(",")}]`);
const predicateText = (test: Predicate) =>
  test.kind === "truthy" ? "truthy" : test.kind === "absence" ? `${test.operator} ${test.absence}` : test.kind === "literal" ? `${test.operator} ${JSON.stringify(test.literal)}` : test.kind === "typeof" ? `typeof ${test.operator} ${test.type}` : test.kind === "one-of" ? `one-of ${[...test.literals.map((literal) => JSON.stringify(literal)), ...test.absences].join("|")}` : "array";
const guardText = (guard: Guard) =>
  "test" in guard ? `${guard.kind} ${predicateText(guard.test)} ${guard.holds}${guard.kind === "fallback" ? ` -> ${guard.replacement.kind === "opaque" ? "opaque" : JSON.stringify(guard.replacement.value)}` : ""}` : guard.kind;
const guardsOf = (result: FlowResult) => result.uses.filter((use) => use.path.length > 0).map((use) => use.guards.map(guardText));
const frontiers = (result: FlowResult) => result.frontiers.map((frontier) => `${frontier.at.line - HEADER_LINES} ${frontier.cause}${frontier.detail === undefined ? "" : `:${frontier.detail}`}`);
const next = (result: FlowResult) =>
  result.next.map(({ carrier }) => {
    const { site } = carrier;
    const where = site.kind === "member" ? `${site.owner}.${site.member}` : site.kind === "parameter" ? `${site.symbol}#${site.index}` : "symbol" in site ? site.symbol : site.kind === "input" ? site.name : site.kind === "call-result" ? site.callee : site.kind;
    const line = siteLine(site);
    return `${site.kind} ${where}@${line === undefined ? "-" : line - HEADER_LINES} ${dotted(carrier.path)}`;
  });
const steps = (result: FlowResult) => result.next.map(({ hops }) => hops.map((hop) => hop.step).join(">"));

const SERVICE = (body: string) => [
  "class OrderService {",
  "  constructor(private http: HttpClient) {}",
  `  find() { return ${body} }`,
  "}",
];

test("a wrapper response keeps the changed property under body", async () => {
  const file = source("a.ts", [
    "class Api {",
    "  constructor(private http: HttpClient) {}",
    "  identity(id: string) { return this.http.get('/users/' + id, { observe: 'response' }) }",
    "}",
    "class Page {",
    "  constructor(private api: Api) {}",
    "  load() { this.api.identity('1').subscribe((response) => { show(response.body.owner.name); show(response.owner.name) }) }",
    "}",
  ]);
  const result = await follow([file], callSite("a.ts", 7, "Page.load"), "owner");
  assert.deepEqual(uses(result), ["7 body.owner.name|body.owner []"]);
  assert.deepEqual(frontiers(result), []);
});

test("a wrapper that does not return the request body cuts the flow", async () => {
  const file = source("a.ts", [
    "class Api {",
    "  constructor(private http: HttpClient) {}",
    "  send(id: string) { this.http.get('/users/' + id); }",
    "}",
    "class Page {",
    "  constructor(private api: Api) {}",
    "  load() { const response = this.api.send('1'); show(response.owner.name) }",
    "}",
  ]);
  const result = await follow([file], callSite("a.ts", 7, "Page.load"), "owner");
  assert.deepEqual(result.uses, []);
  assert.deepEqual(frontiers(result), ["7 unmodelled-flow:request-summary:no-body"]);
});

test("the supplied column selects one custom wrapper call among siblings", async () => {
  const calls = "  load() { this.api.identity('a').subscribe((a) => show(a.owner.left)); this.api.identity('b').subscribe((b) => show(b.owner.right)) }";
  const file = source("a.ts", [
    "class Api {",
    "  constructor(private http: HttpClient) {}",
    "  identity(id: string) { return this.http.get('/users/' + id) }",
    "}",
    "class Page {",
    "  constructor(private api: Api) {}",
    calls,
    "}",
  ]);
  const second = calls.indexOf("this.api.identity", calls.indexOf("this.api.identity") + 1) + 1;
  const result = await follow([file], { ...callSite("a.ts", 7, "Page.load"), column: second }, "owner");
  assert.deepEqual(uses(result), ["7 owner.right|owner []"]);
  assert.deepEqual(frontiers(result), []);
});

test("a cross-file custom wrapper returns the body to its subscriber", async () => {
  const api = source("api.ts", [
    "export class Api {",
    "  constructor(private http: HttpClient) {}",
    "  identity(id: string) { return this.http.get('/users/' + id) }",
    "}",
  ]);
  const page = source("page.ts", [
    "import { Api } from './api'",
    "class Page {",
    "  constructor(private api: Api) {}",
    "  load() { this.api.identity('1').subscribe((value) => show(value.owner.name)) }",
    "}",
  ]);
  const result = await follow([api, page], callSite("page.ts", 4, "Page.load"), "owner");
  assert.deepEqual(uses(result), ["4 owner.name|owner []"]);
  assert.deepEqual(frontiers(result), []);
});

test("an undecided wrapper result cuts the flow instead of guessing a body", async () => {
  const file = source("a.ts", [
    "class Api {",
    "  constructor(private http: HttpClient) {}",
    "  identity(id: string, observe: string) { return this.http.get('/users/' + id, { observe }) }",
    "}",
    "class Page {",
    "  constructor(private api: Api) {}",
    "  load() { this.api.identity('1', 'body').subscribe((response) => show(response.owner.name)) }",
    "}",
  ]);
  const result = await follow([file], callSite("a.ts", 7, "Page.load"), "owner");
  assert.deepEqual(result.uses, []);
  assert.equal(result.frontiers.length, 1);
  assert.equal(result.frontiers[0]?.cause, "unmodelled-flow");
  assert.equal(result.frontiers[0]?.detail, "request-summary:destination-undecidable");
});

test("a wrapper's projected result follows only the projected part of the body", async () => {
  const file = source("a.ts", [
    "class Api {",
    "  constructor(private http: HttpClient) {}",
    "  identity(id: string) { return this.http.get('/users/' + id).pipe(map((response) => response.data)) }",
    "}",
    "class Page {",
    "  constructor(private api: Api) {}",
    "  load() { this.api.identity('1').subscribe((data) => show(data.owner.name)) }",
    "}",
  ]);
  const site = callSite("a.ts", 7, "Page.load");
  assert.deepEqual(uses(await follow([file], site, "data.owner")), ["7 owner.name|owner []"]);
  const dropped = await follow([file], site, "other");
  assert.deepEqual(dropped.uses, []);
  assert.deepEqual(dropped.frontiers, []);
});

test("a resource returned by a wrapper keeps the body under value", async () => {
  const file = source("a.ts", [
    "class Api {",
    "  identity(id: string) { return httpResource(() => '/users/' + id) }",
    "}",
    "class Page {",
    "  constructor(private api: Api) {}",
    "  load() { const result = this.api.identity('1'); show(result.value().owner.name) }",
    "}",
  ]);
  const result = await follow([file], callSite("a.ts", 6, "Page.load"), "owner");
  assert.deepEqual(uses(result), ["6 value.owner.name|value.owner []"]);
  assert.deepEqual(frontiers(result), []);
});

test("a fetch returned by a wrapper follows its parsed response body", async () => {
  const file = source("a.ts", [
    "class Api {",
    "  identity(id: string) { return fetch('/users/' + id) }",
    "}",
    "class Page {",
    "  constructor(private api: Api) {}",
    "  load() { this.api.identity('1').then((r) => { show(r.owner.name); return r.json() }).then((value) => show(value.owner.name)) }",
    "}",
  ]);
  const result = await follow([file], callSite("a.ts", 6, "Page.load"), "owner");
  assert.deepEqual(uses(result), ["6 owner.name|owner []"]);
  assert.deepEqual(frontiers(result), []);
});

test("a resource wrapping fetch parses the body inside the resource value", async () => {
  const file = source("a.ts", [
    "class Api {",
    "  identity(id: string) { return resource({ loader: () => fetch('/users/' + id) }) }",
    "}",
    "class Page {",
    "  constructor(private api: Api) {}",
    "  load() { const r = this.api.identity('1'); r.value().json().then((value) => show(value.owner.name)) }",
    "}",
  ]);
  const result = await follow([file], callSite("a.ts", 6, "Page.load"), "owner");
  assert.deepEqual(uses(result), ["6 owner.name|owner []"]);
  assert.deepEqual(frontiers(result), []);
});

test("a resource body's json method is not inferred to be a fetch accessor", async () => {
  const file = source("a.ts", [
    "class Api { identity(id: string) { return httpResource(() => '/users/' + id) } }",
    "class Page {",
    "  constructor(private api: Api) {}",
    "  load() { const r = this.api.identity('1'); show(r.value().json().owner.name) }",
    "}",
  ]);
  const result = await follow([file], callSite("a.ts", 4, "Page.load"), "json.owner");
  assert.equal(result.uses.some((use) => use.path.includes("owner")), false);
  assert.ok(result.frontiers.length > 0);
});

test("a subscribe callback reading below the changed property is a dereference with the longest path read", async () => {
  const file = source("a.ts", [
    "class Page {",
    "  constructor(private http: HttpClient) {}",
    "  load() {",
    "    this.http.get<Order>('/orders/1').subscribe((order) => {",
    "      show(order.owner.name)",
    "    })",
    "  }",
    "}",
  ]);
  const result = await follow([file], callSite("a.ts", 4, "Page.load"), "owner");
  assert.deepEqual(uses(result), ["5 owner.name|owner []"]);
  assert.deepEqual(frontiers(result), []);
});

test("observe response puts the body under body, with a response-body hop", async () => {
  const file = source("a.ts", [
    "class Page {",
    "  constructor(private http: HttpClient) {}",
    "  load() {",
    "    this.http.get<Order>('/orders/1', { observe: 'response' }).subscribe((res) => {",
    "      show(res.body.owner.name)",
    "    })",
    "  }",
    "}",
  ]);
  const result = await follow([file], callSite("a.ts", 4, "Page.load"), "owner");
  assert.deepEqual(uses(result), ["5 body.owner.name|body.owner []"]);
  assert.deepEqual(result.uses[0]!.hops.map((hop) => hop.step), ["response-body", "subscribe"]);
  assert.deepEqual(result.uses[0]!.hops[0]!.rewrite, [{ from: [], to: ["body"] }]);
});

test("pass-through operators keep the path and map renames it property-wise", async () => {
  const file = source("a.ts", [
    "class Page {",
    "  constructor(private http: HttpClient) {}",
    "  load() {",
    "    this.http.get<Order>('/orders/1').pipe(",
    "      tap((o) => log(o)),",
    "      catchError(() => of(null)),",
    "      map((o) => ({ who: o.owner, id: o.id })),",
    "    ).subscribe((view) => {",
    "      show(view.who.name)",
    "      show(view.id.length)",
    "    })",
    "  }",
    "}",
  ]);
  const result = await follow([file], callSite("a.ts", 4, "Page.load"), "owner");
  assert.deepEqual(uses(result), ["9 who.name|who []"]);
});

test("a block-bodied map follows each return", async () => {
  const file = source("a.ts", [
    "class Page {",
    "  constructor(private http: HttpClient) {}",
    "  load() {",
    "    this.http.get<Order>('/orders/1').pipe(",
    "      map((o) => {",
    "        const copy = o.owner",
    "        return copy",
    "      }),",
    "    ).subscribe((owner) => show(owner.name))",
    "  }",
    "}",
  ]);
  const result = await follow([file], callSite("a.ts", 4, "Page.load"), "owner");
  assert.deepEqual(uses(result), ["9 name|[] []"]);
});

test("await firstValueFrom and destructuring bind the changed property to a local", async () => {
  const file = source("a.ts", [
    "class Page {",
    "  constructor(private http: HttpClient) {}",
    "  async load() {",
    "    const { owner } = await firstValueFrom(this.http.get<Order>('/orders/1'))",
    "    show(owner.name)",
    "  }",
    "}",
  ]);
  const result = await follow([file], callSite("a.ts", 4, "Page.load"), "owner");
  assert.deepEqual(uses(result), ["5 name|[] []"]);
  assert.deepEqual(result.uses[0]!.hops.map((hop) => hop.step), ["await", "assign"]);
});

test("toSignal assigned to a field hands back the member carrier", async () => {
  const file = source("a.ts", [
    "class Page {",
    "  constructor(private http: HttpClient) {}",
    "  order = toSignal(this.http.get<Order>('/orders/1'))",
    "}",
  ]);
  const result = await follow([file], callSite("a.ts", 3, "Page.order"), "owner");
  assert.deepEqual(next(result), ["member Page.order@3 owner"]);
  assert.deepEqual(steps(result), ["to-signal>assign"]);
});

test("httpResource and a resource loader put the change under value", async () => {
  const file = source("a.ts", [
    "class Page {",
    "  constructor(private http: HttpClient) {}",
    "  order = httpResource<Order>(() => '/orders/1')",
    "  other = resource({ loader: () => firstValueFrom(this.http.get<Order>('/orders/2')) })",
    "}",
  ]);
  const direct = await follow([file], callSite("a.ts", 3, "Page.order"), "owner");
  assert.deepEqual(next(direct), ["member Page.order@3 value.owner"]);
  assert.deepEqual(steps(direct), ["resource>assign"]);
  const loaded = await follow([file], callSite("a.ts", 4, "Page.other"), "owner");
  assert.deepEqual(next(loaded), ["member Page.other@4 value.owner"]);
});

test("a returned value hands back the return carrier of the function as written", async () => {
  const file = source("a.ts", SERVICE("this.http.get<Order>('/orders/1').pipe(map((o) => o.owner))"));
  const result = await follow([file], callSite("a.ts", 3, "OrderService.find"), "owner");
  assert.deepEqual(next(result), ["return find@3 []"]);
  assert.deepEqual(steps(result), ["pipe>map>return"]);
});

test("an argument to a repository function reaches its parameter, same file or imported", async () => {
  const helper = source("helper.ts", ["export function show(order: Order, extra: number) { return order.owner.name }"]);
  const file = source("a.ts", [
    "import { show } from './helper'",
    "class Page {",
    "  constructor(private http: HttpClient) {}",
    "  load() {",
    "    this.http.get<Order>('/orders/1').subscribe((o) => { this.render(o); show(o, 1) })",
    "  }",
    "  render(order: Order) {}",
    "}",
  ]);
  const result = await follow([file, helper], callSite("a.ts", 5, "Page.load"), "owner");
  assert.deepEqual(next(result), ["parameter render#0@7 owner", "parameter show#0@1 owner"].map((line) => line));
});

test("a parameter carrier follows the parameter inside its function", async () => {
  const file = source("a.ts", [
    "class Page {",
    "  render(order: Order) {",
    "    return order.owner.name",
    "  }",
    "}",
  ]);
  const result = await follow([file], { kind: "parameter", repo: "repo", file: "a.ts", symbol: "render", line: at(2), index: 0 }, "owner");
  assert.deepEqual(uses(result), ["3 owner.name|owner []"]);
});

test("a call-result carrier follows the value of the call at its line and column", async () => {
  const file = source("a.ts", [
    "class Page {",
    "  load() {",
    "    const a = this.service.find(1), b = this.service.find(2)",
    "    show(b.owner.name)",
    "  }",
    "}",
  ]);
  const second = await follow([file], { kind: "call-result", repo: "repo", file: "a.ts", line: at(3), column: 40, callee: "find" }, "owner");
  assert.deepEqual(uses(second), ["4 owner.name|owner []"]);
  const first = await follow([file], { kind: "call-result", repo: "repo", file: "a.ts", line: at(3), column: 14, callee: "find" }, "owner");
  assert.deepEqual(uses(first), []);
});

test("a member carrier reads the signal, the resource value and the plain field", async () => {
  const file = source("a.ts", [
    "class Page {",
    "  order = signal<Order>(null)",
    "  loaded = httpResource<Order>(() => '/x')",
    "  plain: Order",
    "  show() {",
    "    show(this.order().owner.name)",
    "    show(this.loaded.value().owner.name)",
    "    show(this.plain.owner.name)",
    "  }",
    "}",
  ]);
  const signalRead = await follow([file], { kind: "member", repo: "repo", file: "a.ts", owner: "Page", member: "order", line: at(2) }, "owner");
  assert.deepEqual(uses(signalRead), ["6 owner.name|owner []"]);
  const resourceRead = await follow([file], { kind: "member", repo: "repo", file: "a.ts", owner: "Page", member: "loaded" }, "value.owner");
  assert.deepEqual(uses(resourceRead), ["7 value.owner.name|value.owner []"]);
  const plainRead = await follow([file], { kind: "member", repo: "repo", file: "a.ts", owner: "Page", member: "plain" }, "owner");
  assert.deepEqual(uses(plainRead), ["8 owner.name|owner []"]);
});

test("a write to a member is not a read of it", async () => {
  const file = source("a.ts", ["class Page {", "  order: Order", "  reset() { this.order = null; this.order.owner.name }", "}"]);
  const result = await follow([file], { kind: "member", repo: "repo", file: "a.ts", owner: "Page", member: "order" }, "owner");
  assert.deepEqual(uses(result), ["3 owner.name|owner []"]);
});

const SERVICE_FILE = source("svc.ts", ["export class Svc {", "  order = signal<Order>(null)", "  plain: Order", "}"]);
const memberRead = (file: string, line: number, member = "order"): CarrierSite => ({ kind: "member-read", repo: "repo", file, line: at(line), column: 1, owner: "Svc", member });
const reader = (lines: readonly string[], imports = "import { Svc } from './svc'\nimport { inject } from '@angular/core'\n") => ({ path: "page.ts", content: COMMON + imports + lines.join("\n") });
const IMPORT_LINES = 2;

test("a member read through an injected instance of its owner is followed from the place the graph reported", async () => {
  const injected = reader(["class Page {", "  svc = inject(Svc)", "  show() { show(this.svc.order().owner.name) }", "}"]);
  const parameter = reader(["@Component({})", "class Card {", "  constructor(private svc: Svc) {}", "  show() { show(this.svc.order().owner.name) }", "}"]);
  const local = reader(["function view() {", "  const svc = inject(Svc)", "  show(svc.order().owner.name)", "}"]);

  assert.deepEqual(uses(await follow([SERVICE_FILE, injected], memberRead("page.ts", IMPORT_LINES + 3), "owner")), [`${IMPORT_LINES + 3} owner.name|owner []`]);
  assert.deepEqual(uses(await follow([SERVICE_FILE, parameter], memberRead("page.ts", IMPORT_LINES + 4), "owner")), [`${IMPORT_LINES + 4} owner.name|owner []`]);
  assert.deepEqual(uses(await follow([SERVICE_FILE, local], memberRead("page.ts", IMPORT_LINES + 3), "owner")), [`${IMPORT_LINES + 3} owner.name|owner []`]);
});

test("only Angular's inject, under any import name, makes an injected instance; an inject from elsewhere is a frontier", async () => {
  const lines = ["class Page {", "  svc = di(Svc)", "  show() { show(this.svc.order().owner.name) }", "}"];
  const aliased = reader(lines, "import { Svc } from './svc'\nimport { inject as di } from '@angular/core'\n");
  const namespaced = reader(lines.map((line) => line.replace("di(", "ng.inject(")), "import { Svc } from './svc'\nimport * as ng from '@angular/core'\n");
  const foreign = reader(lines.map((line) => line.replace("di(", "inject(")), "import { Svc } from './svc'\nimport { inject } from './container'\n");

  for (const file of [aliased, namespaced]) assert.deepEqual(uses(await follow([SERVICE_FILE, file], memberRead("page.ts", IMPORT_LINES + 3), "owner")), [`${IMPORT_LINES + 3} owner.name|owner []`]);
  const lost = await follow([SERVICE_FILE, foreign], memberRead("page.ts", IMPORT_LINES + 3), "owner");
  assert.deepEqual([uses(lost), frontiers(lost)], [[], [`${IMPORT_LINES + 3} unmodelled-flow:member receiver`]]);
});

test("the subclass of the owner reads the member through this; a subclass that redeclares it is a frontier at the declaration", async () => {
  const sub = reader(["class Sub extends Svc {", "  show() { show(this.order().owner.name) }", "}"]);
  const redeclared = reader(["class Sub extends Svc {", "  order = signal<Order>(null)", "  show() { show(this.order().owner.name) }", "}"]);

  assert.deepEqual(uses(await follow([SERVICE_FILE, sub], memberRead("page.ts", IMPORT_LINES + 2), "owner")), [`${IMPORT_LINES + 2} owner.name|owner []`]);
  const result = await follow([SERVICE_FILE, redeclared], memberRead("page.ts", IMPORT_LINES + 3), "owner");
  assert.deepEqual([uses(result), frontiers(result)], [[], [`${IMPORT_LINES + 2} unmodelled-flow:member redeclared`]]);
});

test("a read through a receiver that does not denote the written instance is a frontier at the read", async () => {
  const fresh = reader(["class Page {", "  other = new Svc()", "  untyped: Svc", "  show(svc: Svc) {", "    show(new Svc().order().owner.name)", "    show(this.other.order().owner.name)", "    show(this.untyped.order().owner.name)", "    show(svc.order().owner.name)", "  }", "}"]);

  for (const line of [5, 6, 7, 8]) {
    const result = await follow([SERVICE_FILE, fresh], memberRead("page.ts", IMPORT_LINES + line), "owner");
    assert.deepEqual([uses(result), frontiers(result)], [[], [`${IMPORT_LINES + line} unmodelled-flow:member receiver`]], `line ${line}`);
  }
});

test("a member of a class provably unrelated to the owner is skipped, and one whose bases are unknown is a frontier", async () => {
  const other = { path: "other.ts", content: COMMON + ["export class Other {", "  order: Order", "}"].join("\n") };
  const unrelated = reader(["class Page {", "  other = inject(Other)", "  show() { show(this.other.order.owner.name) }", "}"], "import { Other } from './other'\nimport { inject } from '@angular/core'\n");
  const unknownBase = reader(["class Page {", "  other = inject(Other)", "  show() { show(this.other.order.owner.name) }", "}"], "import { Other } from './gone'\nimport { inject } from '@angular/core'\n");
  const opaque = { path: "other.ts", content: COMMON + ["export class Other extends Mixin(Base) {", "}"].join("\n") };

  const skipped = await follow([SERVICE_FILE, other, unrelated], memberRead("page.ts", IMPORT_LINES + 3, "order"), "owner");
  assert.deepEqual([uses(skipped), frontiers(skipped)], [[], []]);
  const lost = await follow([SERVICE_FILE, opaque, unrelated], memberRead("page.ts", IMPORT_LINES + 3, "order"), "owner");
  assert.deepEqual(frontiers(lost), [`${IMPORT_LINES + 3} unmodelled-flow:member receiver`]);
  const unresolved = await follow([SERVICE_FILE, unknownBase], memberRead("page.ts", IMPORT_LINES + 3, "order"), "owner");
  assert.deepEqual(frontiers(unresolved), [`${IMPORT_LINES + 3} unmodelled-flow:member receiver`]);
});

test("a place with no read of the member is a frontier, and a write or the owner's own this read is not a read to follow", async () => {
  const page = reader(["class Page {", "  svc = inject(Svc)", "  reset() { this.svc.order = null }", "  none() { return 1 }", "  drop() { delete this.svc.order }", "}"]);
  const own = { path: "svc.ts", content: COMMON + ["export class Svc {", "  order = signal<Order>(null)", "  show() { show(this.order().owner.name) }", "}"].join("\n") };

  const written = await follow([SERVICE_FILE, page], memberRead("page.ts", IMPORT_LINES + 3), "owner");
  assert.deepEqual([uses(written), frontiers(written)], [[], []]);
  const deleted = await follow([SERVICE_FILE, page], memberRead("page.ts", IMPORT_LINES + 5), "owner");
  assert.deepEqual([uses(deleted), frontiers(deleted)], [[], []]);
  const absent = await follow([SERVICE_FILE, page], memberRead("page.ts", IMPORT_LINES + 4), "owner");
  assert.deepEqual(frontiers(absent), [`${IMPORT_LINES + 4} unmodelled-flow:no read of the member at the reported place`]);
  const inside = await follow([own], memberRead("svc.ts", 3), "owner");
  assert.deepEqual([uses(inside), frontiers(inside)], [[], []]);
});

const labelOf = (lines: readonly string[]) => source("page.ts", lines);

test("a template call enters the component method at its parameter, found on the class or on a base in another file", async () => {
  const base = source("base.ts", ["export class Base {", "  label(order: Order) { return order.owner.name }", "}"]);
  const page = reader(["class Page extends Base {", "  other(order: Order) { show(order.owner.name) }", "}"], "import { Base } from './base'\n");
  const site = (method: string): CarrierSite => ({ kind: "method-parameter", repo: "repo", file: "page.ts", owner: "Page", method, index: 0 });

  assert.deepEqual(uses(await follow([base, page], site("other"), "owner")), ["3 owner.name|owner []"]);
  assert.deepEqual(uses(await follow([base, page], site("label"), "owner")), ["2 owner.name|owner []"]);
  const missing = await follow([base, page], site("gone"), "owner");
  assert.deepEqual(frontiers(missing), ["2 unmodelled-flow:component method not found"]);
});

test("the return of a component method called from a template is handed back as a return carrier", async () => {
  const page = labelOf(["class Page {", "  label(order: Order) { return order.owner }", "}"]);
  const result = await follow([page], { kind: "method-parameter", repo: "repo", file: "page.ts", owner: "Page", method: "label", index: 0 }, "owner");

  assert.deepEqual(next(result), ["return label@2 []"]);
});

function guarded(lines: readonly string[]) {
  return source("g.ts", ["class Page {", "  use(order: Order) {", ...lines.map((line) => `    ${line}`), "  }", "}"]);
}

const parameterOrder = { kind: "parameter" as const, repo: "repo", file: "g.ts", symbol: "use", line: at(2), index: 0 };

test("each guard form protects the reads it dominates and no others", async () => {
  const file = guarded([
    "show(order.owner?.name)",
    "if (order.owner) { show(order.owner.name) }",
    "if (order.owner != null) { show(order.owner.name) }",
    "if (order.owner !== undefined) { show(order.owner.name) }",
    "const ok = order.owner && order.owner.name",
    "show(order.owner ? order.owner.name : '')",
    "show(order.owner!.name)",
    "show(order.owner.name)",
  ]);
  const result = await follow([file], parameterOrder, "owner");
  assert.deepEqual(uses(result), [
    "3 owner.name|owner [optional-chain]",
    "4 owner.name|owner [condition]",
    "5 owner.name|owner [condition]",
    "6 owner.name|owner [condition]",
    "7 owner.name|owner [condition]",
    "8 owner.name|owner [condition]",
    "9 owner.name|owner [non-null-assertion]",
    "10 owner.name|owner []",
  ]);
  assert.deepEqual(guardsOf(result).slice(0, 3), [["optional-chain != null true"], ["condition truthy true"], ["condition != null true"]]);
});

test("an early return or throw on the negation guards the rest of the block", async () => {
  const file = guarded(["if (!order.owner) return", "show(order.owner.name)"]);
  const result = await follow([file], parameterOrder, "owner");
  assert.deepEqual(uses(result), ["4 owner.name|owner [early-exit]"]);
  assert.deepEqual(guardsOf(result), [["early-exit truthy true"]]);
});

test("an early exit on an equality states the test and the branch the rest of the block runs in", async () => {
  const file = guarded(["if (order.owner === null) return", "show(order.owner.name)"]);
  const result = await follow([file], parameterOrder, "owner");
  assert.deepEqual(guardsOf(result), [["early-exit === null false"]]);
});

test("a truthiness or absence test states its operator, operand and the branch the use sits in", async () => {
  const file = guarded([
    "if (!order.owner) { show(order.owner.name) }",
    "if (order.owner == null) {} else { show(order.owner.name) }",
    "if (null !== order.owner) { show(order.owner.name) }",
    "if (undefined === order.owner) { show(order.owner.name) }",
  ]);
  const result = await follow([file], parameterOrder, "owner");
  assert.deepEqual(guardsOf(result), [["condition truthy false"], ["condition == null false"], ["condition !== null true"], ["condition === undefined true"]]);
});

test("an equality with a literal the code writes keeps the literal and its sign", async () => {
  const file = guarded(["if (order.owner === 'a') { show(order.owner.name) }", "if (-1 !== order.owner) { show(order.owner.name) }", "if (order.owner == true) { show(order.owner.name) }"]);
  const result = await follow([file], parameterOrder, "owner");
  assert.deepEqual(guardsOf(result), [['condition === "a" true'], ["condition !== -1 true"], ["condition == true true"]]);
});

test("typeof of the covered path is a test in either operand order", async () => {
  const file = guarded(["if (typeof order.owner === 'object') { show(order.owner.name) }", "if ('string' !== typeof order.owner) { show(order.owner.name) }"]);
  const result = await follow([file], parameterOrder, "owner");
  assert.deepEqual(guardsOf(result), [["condition typeof === object true"], ["condition typeof !== string true"]]);
});

test("Array.isArray is an array test only when Array is the global", async () => {
  const file = source("g.ts", [
    "class Page {",
    "  use(order: Order) { if (Array.isArray(order.owner)) { show(order.owner.name) } }",
    "  shadowed(order: Order, Array: Arrays) { if (Array.isArray(order.owner)) { show(order.owner.name) } }",
    "}",
  ]);
  const global = await follow([file], { kind: "parameter", repo: "repo", file: "g.ts", symbol: "use", line: at(2), index: 0 }, "owner");
  const shadowed = await follow([file], { kind: "parameter", repo: "repo", file: "g.ts", symbol: "shadowed", line: at(3), index: 0 }, "owner");
  assert.deepEqual(guardsOf(global), [["condition array true"]]);
  assert.deepEqual(guardsOf(shadowed), [[]]);
  const declared = source("h.ts", ["const Array = helpers", "class Page {", "  use(order: Order) { if (Array.isArray(order.owner)) { show(order.owner.name) } }", "}"]);
  assert.deepEqual(guardsOf(await follow([declared], { kind: "parameter", repo: "repo", file: "h.ts", symbol: "use", line: at(3), index: 0 }, "owner")), [[]]);
});

test("a guard that tests a different path or sits in the other branch does not protect", async () => {
  const file = guarded(["if (order.id) { show(order.owner.name) }", "if (order.owner) {} else { show(order.owner.name) }"]);
  const result = await follow([file], parameterOrder, "owner");
  assert.deepEqual(uses(result), ["3 owner.name|owner []", "4 owner.name|owner [condition]"]);
  assert.deepEqual(guardsOf(result)[1], ["condition truthy false"]);
});

test("user type guards and instanceof leave the read opaque", async () => {
  const file = source("g.ts", [
    "function isOwned(o: Order): o is Order { return true }",
    "class Page {",
    "  use(order: Order) {",
    "    if (isOwned(order.owner)) { show(order.owner.name) }",
    "    if (order.owner instanceof Owner) { show(order.owner.name) }",
    "  }",
    "}",
  ]);
  const result = await follow([file], { kind: "parameter", repo: "repo", file: "g.ts", symbol: "use", line: at(3), index: 0 }, "owner");
  assert.deepEqual(uses(result), ["4 owner.name|owner [type-guard]", "5 owner.name|owner [instanceof]"]);
});

test("a fallback on the changed value guards what it flows to; a destructuring default covers undefined only", async () => {
  const file = guarded(["const owner = order.owner ?? {}", "show(owner.name)", "const { owner: second = {} } = order", "show(second.name)"]);
  const result = await follow([file], parameterOrder, "owner");
  assert.deepEqual(guardsOf(result), [["fallback != null true -> {}"], ["fallback !== undefined true -> {}"]]);
});

const operations = async (lines: readonly string[], path: string) => (await follow([guarded(lines)], parameterOrder, path)).uses.map((use) => use.operation);
const NONE = { kind: "none" } as const;

test("each construct states what it does with the changed value", async () => {
  assert.deepEqual(
    await operations(["order.owner?.name.first", "order.owner['key']", "order.owner[0]", "order.owner[other]", "order.owner.fmt?.(1)", "order.owner?.[0]"], "owner"),
    [
      { steps: [{ kind: "member", name: "name", optional: true }, { kind: "member", name: "first", optional: false }], end: NONE },
      { steps: [{ kind: "keyed", key: "key", optional: false }], end: NONE },
      { steps: [{ kind: "keyed", key: 0, optional: false }], end: NONE },
      { steps: [{ kind: "keyed", optional: false }], end: NONE },
      { steps: [{ kind: "member", name: "fmt", optional: false }, { kind: "call", optional: true }], end: NONE },
      { steps: [{ kind: "keyed", key: 0, optional: true }], end: NONE },
    ],
  );
  assert.deepEqual(await operations(["const { owner: { name } } = order", "const { owner: [first] } = order", "const { owner: {} } = order"], "owner"), [
    { steps: [], end: { kind: "destructure", shape: "object" } },
    { steps: [], end: { kind: "destructure", shape: "array" } },
    { steps: [], end: { kind: "destructure", shape: "object" } },
  ]);
  assert.deepEqual(
    await operations(
      ["for (const x of order.tags) {}", "[...order.tags]", "order.tags === 'A'", "order.tags === -1", "order.tags < 3", "order.tags === other", "order.tags + 1", "show(`${order.tags}`)", "audit(order.tags)", "new Box(order.tags)"],
      "tags",
    ),
    [
      { steps: [], end: { kind: "iterate", tolerates: [] } },
      { steps: [], end: { kind: "iterate", tolerates: [] } },
      { steps: [], end: { kind: "compare", operator: "===", literal: "A" } },
      { steps: [], end: { kind: "compare", operator: "===", literal: -1 } },
      { steps: [], end: { kind: "compare", operator: "<", literal: 3 } },
      { steps: [], end: { kind: "compare", operator: "===" } },
      { steps: [], end: { kind: "coerce", operator: "+" } },
      { steps: [], end: { kind: "coerce", operator: "${}" } },
      { steps: [], end: { kind: "consume", as: "handed-on", detail: "audit" } },
      { steps: [], end: { kind: "unmodelled", detail: "NewExpression" } },
    ],
  );
});

test("a numeric unary operator on the changed value coerces it; a test of it uses nothing", async () => {
  const lines = ["-order.tags", "+order.tags", "~order.tags", "++order.tags", "--order.tags", "order.tags++", "order.tags--", "!order.tags", "typeof order.tags", "void order.tags"];
  const operators = ["-", "+", "~", "++", "--", "++", "--"];
  assert.deepEqual(
    await operations(lines.map((line) => `${line};`), "tags"),
    operators.map((operator) => ({ steps: [], end: { kind: "coerce", operator } })),
  );
});

test("a switch compares the value it switches on strictly, as its labels do", async () => {
  assert.deepEqual(await operations(["switch (order.tags) { case 'A': break }"], "tags"), [{ steps: [], end: { kind: "compare", operator: "===" } }]);
});

test("`in` and `instanceof` with the changed value as the right operand are unmodelled ends, and on the left it stays as it was", async () => {
  assert.deepEqual(await operations(["'k' in order.tags", "other instanceof order.tags", "order.tags in other", "order.tags instanceof Other"], "tags"), [
    { steps: [], end: { kind: "unmodelled", detail: "in" } },
    { steps: [], end: { kind: "unmodelled", detail: "instanceof" } },
    { steps: [], end: { kind: "coerce", operator: "in" } },
  ]);
});

const lines = (...texts: readonly string[]) => texts.map((text) => `${text};`);

test("a read below the changed value ends in what the code does with the value it reaches, as the changed value itself would", async () => {
  const read = (name: string) => ({ kind: "member", name, optional: false });
  const ends = await operations(
    lines("'k' in order.owner.tags", "other instanceof order.owner.tags", "+order.owner.age", "order.owner.age == 1", "order.owner.age < 3", "order.owner.age + 1", "show(`${order.owner.age}`)", "for (const x of order.owner.tags) {}", "[...order.owner.tags]", "switch (order.owner.age) { case 1: break }", "order.owner.age === null", "order.owner.age ?? 0"),
    "owner",
  );
  assert.deepEqual(
    ends.map((operation) => operation.end),
    [
      { kind: "unmodelled", detail: "in" },
      { kind: "unmodelled", detail: "instanceof" },
      { kind: "coerce", operator: "+" },
      { kind: "compare", operator: "==", literal: 1 },
      { kind: "compare", operator: "<", literal: 3 },
      { kind: "coerce", operator: "+" },
      { kind: "coerce", operator: "${}" },
      { kind: "iterate", tolerates: [] },
      { kind: "iterate", tolerates: [] },
      { kind: "compare", operator: "===" },
      NONE,
      NONE,
    ],
  );
  assert.deepEqual(ends[0]!.steps, [read("tags")]);
  const nested = await operations(lines("+order.owner.address.zip", "1 instanceof order.owner.address.zip"), "owner");
  assert.deepEqual(nested, [
    { steps: [read("address"), read("zip")], end: { kind: "coerce", operator: "+" } },
    { steps: [read("address"), read("zip")], end: { kind: "unmodelled", detail: "instanceof" } },
  ]);
});

test("elements of an array are followed through for-of with the element path", async () => {
  const file = guarded(["for (const item of order.items) { show(item.owner.name) }"]);
  const result = await follow([file], parameterOrder, "items[].owner");
  assert.deepEqual(uses(result), ["3 owner.name|owner []"]);
});

test("iterating a value whose changed path does not continue through its elements is a frontier", async () => {
  const file = guarded(["for (const x of order.owner) { show(x.name) }"]);
  const result = await follow([file], parameterOrder, "owner.name");
  assert.deepEqual(frontiers(result), ["3 unmodelled-flow:iteration"]);
});

test("a value that contains the changed property reaching code outside the repository is a frontier", async () => {
  const file = guarded([
    "order.items.reduce((total, i) => total + i.owner.id, 0)",
    "const copy = { ...order, ...extra }",
    "Library.use(order)",
    "this.dyn[order.key]",
  ]);
  const result = await follow([file], parameterOrder, "items[].owner");
  assert.deepEqual(frontiers(result), ["3 unmodelled-flow:method:reduce", "4 unmodelled-flow:later spread", "5 unmodelled-sink:holder:use"]);
});

test("an operator the slice does not model is a frontier at the operator", async () => {
  const file = source("a.ts", [
    "class Page {",
    "  constructor(private http: HttpClient) {}",
    "  load() {",
    "    this.http.get<Order>('/orders/1').pipe(switchMap((o) => other(o))).subscribe()",
    "  }",
    "}",
  ]);
  const result = await follow([file], callSite("a.ts", 4, "Page.load"), "owner");
  assert.deepEqual(frontiers(result), ["4 unmodelled-flow:operator switchMap"]);
});

test("a carrier the reader cannot place is a frontier, never an empty result", async () => {
  const file = source("a.ts", ["class Page {", "  load() { return 1 }", "}"]);
  const missing = await follow([file], callSite("a.ts", 2, "Page.load"), "owner");
  assert.deepEqual(frontiers(missing), ["2 unmodelled-flow:no call at the reported site"]);
  const absent = await follow([file], { kind: "member", repo: "repo", file: "a.ts", owner: "Gone", member: "x" }, "owner");
  assert.equal(absent.frontiers.length, 1);
  const unread = await follow([file], { kind: "return", repo: "repo", file: "none.ts", symbol: "f", line: 1 }, "owner");
  assert.equal(unread.frontiers[0]!.reason, "source-unreadable");
});

test("a site kind this reader does not follow yet is a frontier at its place, never an empty result nor a walk as another kind", async () => {
  const file = source("a.ts", ["class Page {", "  load() { return 1 }", "}"]);
  const sites: CarrierSite[] = [{ kind: "template-call-result", repo: "repo", resource: "a.html", start: 0, end: 4, callee: "load", argument: 0 }];
  for (const site of sites) {
    const result = await follow([file], site, "owner");
    assert.deepEqual([result.uses, result.next], [[], []], site.kind);
    assert.deepEqual(result.frontiers.map(({ cause, reason }) => `${cause} ${reason}`), ["unmodelled-flow source-unreadable"], site.kind);
  }
});

test("results are in source order and identical across runs", async () => {
  const file = guarded(["show(order.owner.name)", "show(order.owner.id)", "show(order.owner.name)"]);
  const first = await follow([file], parameterOrder, "owner");
  const second = await follow([file], parameterOrder, "owner");
  assert.deepEqual(first, second);
  assert.deepEqual(uses(first), ["3 owner.name|owner []", "4 owner.id|owner []", "5 owner.name|owner []"]);
});

test("a guard on the value does not cross a boundary: the flow is lost there, not reported unguarded", async () => {
  const file = source("g.ts", ["class Page {", "  owner: Owner", "  use(order: Order) {", "    if (order.owner) { this.owner = order.owner }", "  }", "}"]);
  const result = await follow([file], { kind: "parameter", repo: "repo", file: "g.ts", symbol: "use", line: at(3), index: 0 }, "owner");
  assert.deepEqual(next(result), []);
  assert.deepEqual(frontiers(result), ["4 unmodelled-flow:guard does not cross a boundary"]);
});

test("set and next on a member write it, they do not read it", async () => {
  const file = source("a.ts", ["class Page {", "  state = signal<Order>(null)", "  reset() { this.state.set(null); show(this.state().owner.name) }", "}"]);
  const result = await follow([file], { kind: "member", repo: "repo", file: "a.ts", owner: "Page", member: "state" }, "owner");
  assert.deepEqual(uses(result), ["3 owner.name|owner []"]);
  assert.deepEqual(frontiers(result), []);
});

test("a lambda parameter that shadows the followed name is not the followed value", async () => {
  const file = guarded(["items.map((order) => order.owner.name)", "show(order.owner.id)"]);
  const result = await follow([file], parameterOrder, "owner");
  assert.deepEqual(uses(result), ["4 owner.id|owner []"]);
});

test("reassignment cycles terminate and report each use once", async () => {
  const file = guarded(["let a = order", "let b = a", "a = b", "show(a.owner.name)"]);
  const result = await follow([file], parameterOrder, "owner");
  assert.deepEqual(uses(result), ["6 owner.name|owner []"]);
});

test("a computed key into the path to the changed property is a dynamic-access frontier", async () => {
  const file = guarded(["show(order[key].name)"]);
  const result = await follow([file], parameterOrder, "owner");
  assert.deepEqual(frontiers(result), ["3 dynamic-access"]);
});

test("fetch with then handlers reaches the parsed body", async () => {
  const file = source("a.ts", ["class Page {", "  load() {", "    fetch('/orders/1').then((r) => r.json()).then((o) => show(o.owner.name))", "  }", "}"]);
  const result = await follow([file], callSite("a.ts", 3, "Page.load"), "owner");
  assert.deepEqual(uses(result), ["3 owner.name|owner []"]);
});

test("a subscribe observer object and a destructured parameter bind the changed property", async () => {
  const file = source("a.ts", [
    "class Page {",
    "  constructor(private http: HttpClient) {}",
    "  load() {",
    "    this.http.get<Order>('/orders/1').subscribe({ next: ({ owner }) => show(owner.name), error: () => {} })",
    "  }",
    "}",
  ]);
  const result = await follow([file], callSite("a.ts", 4, "Page.load"), "owner");
  assert.deepEqual(uses(result), ["4 name|[] []"]);
});

test("assignment and set on a field hand back the member carrier", async () => {
  const file = source("a.ts", [
    "class Page {",
    "  order: Order",
    "  state = signal<Order>(null)",
    "  constructor(private http: HttpClient) {}",
    "  load() {",
    "    this.http.get<Order>('/orders/1').subscribe((o) => { this.order = o; this.state.set(o) })",
    "  }",
    "}",
  ]);
  const result = await follow([file], callSite("a.ts", 6, "Page.load"), "owner");
  assert.deepEqual(next(result), ["member Page.order@2 owner", "member Page.state@3 owner"]);
});

test("this inside a function expression or an object literal method is not the class instance: no member or method of the class is reached through it", async () => {
  const file = source("a.ts", [
    "class Page {",
    "  order: Order",
    "  constructor(private http: HttpClient) {}",
    "  load() {",
    "    this.http.get<Order>('/orders/1').subscribe(function (o) { this.order = o })",
    "    this.http.get<Order>('/orders/2').subscribe({ next(o) { this.render(o) } })",
    "  }",
    "  render(order: Order) {}",
    "}",
  ]);
  const written = await follow([file], callSite("a.ts", 5, "Page.load"), "owner");
  assert.deepEqual(next(written), []);
  assert.deepEqual(frontiers(written), ["5 unmodelled-flow:member of an anonymous class"]);
  const called = await follow([file], callSite("a.ts", 6, "Page.load"), "owner");
  assert.deepEqual(next(called), []);
});

function plain(lines: readonly string[]) {
  return source("p.ts", ["function use(o: Order) {", ...lines.map((line) => `  ${line}`), "}"]);
}

const paramO = { kind: "parameter" as const, repo: "repo", file: "p.ts", symbol: "use", line: at(1), index: 0 };

test("a method of the language's arrays called on the carried array is read from the callee table: the element reaches the callback, the result is the same array, an element, the callback's returns or nothing", async () => {
  const file = plain([
    "o.items.forEach((i) => show(i.owner.name))",
    "const kept = o.items.filter((i) => i.active)",
    "show(kept[0].owner.id)",
    "const first = o.items.find((i) => i.id === 1)",
    "show(first.owner.title)",
    "const owners = o.items.map((i) => i.owner)",
    "show(owners[0].street)",
    "const flat = o.items.flatMap((i) => [i.owner, i.owner])",
    "show(flat[0].city)",
    "const copy = o.items.slice().sort((a, b) => a.owner.rank - b.owner.rank)",
    "show(copy[0].owner.zip)",
    "o.items.includes(x)",
    "o.items.push(y)",
  ]);
  const result = await follow([file], paramO, "items[].owner");

  assert.deepEqual(uses(result), ["2 owner.name|owner []", "4 [].owner.id|[].owner []", "6 owner.title|owner []", "8 [].street|[] []", "10 [].city|[] []", "11 owner.rank|owner []", "11 owner.rank|owner []", "12 [].owner.zip|[].owner []"]);
  assert.deepEqual(frontiers(result), []);
});

test("the original-array parameter of an array callback carries the receiver's own change, in an inline callback of any row, and the index parameter carries none", async () => {
  const file = plain(["o.items.forEach((i, n, all) => show(all[0].owner.name))", "o.items.map((i, n, all) => all.length)", "o.items.some((i, n) => show(n))"]);
  const result = await follow([file], paramO, "items[].owner");

  assert.deepEqual(uses(result), ["2 [].owner.name|[].owner []"]);
  assert.deepEqual(frontiers(result), []);
});

test("an array callback written as a named function receives the element and the original array at their parameters, and one that declares fewer parameters loses nothing", async () => {
  const file = source("p.ts", [
    "function inspect(item, index, all) { show(all[0].owner.name) }",
    "function first(item) { show(item.owner.name) }",
    "function use(o: Order) {",
    "  o.items.forEach(inspect)",
    "  o.items.forEach(first)",
    "}",
  ]);
  const result = await follow([file], { ...paramO, line: at(3) }, "items[].owner");

  assert.deepEqual(next(result), ["parameter inspect#0@1 owner", "parameter inspect#2@1 [].owner", "parameter first#0@2 owner"]);
  assert.deepEqual(frontiers(result), []);
});

test("a callback that gathers its parameters in a rest parameter is a frontier for the element and for the original array, never a binding of the array of arguments", async () => {
  const file = plain(["o.items.forEach((...args) => show(args[0].owner.name))"]);
  const result = await follow([file], paramO, "items[].owner");

  assert.deepEqual([uses(result), frontiers(result)], [[], ["2 unmodelled-flow:parameter position", "2 unmodelled-flow:parameter position"]]);
});

test("a callback expression the reader cannot resolve is one frontier at the call however many parameters it receives", async () => {
  const file = plain(["o.items.sort(makeComparator())", "o.items.forEach(makeVisitor())"]);
  const result = await follow([file], paramO, "items[].owner");

  assert.deepEqual(frontiers(result).map((line) => line.slice(0, 1)), ["2", "3", "3"]);
});

test("a template call enters the nearest declaration of the method name along the class lineage: a subclass field or accessor that shadows a base method is a frontier, never the base method", async () => {
  const base = source("base.ts", ["export class Base {", "  label(order: Order) { return order.owner.name }", "}"]);
  const page = reader(
    ["class Page extends Base {", "  label = helper", "}", "class Getter extends Base {", "  get label() { return helper }", "}", "class Arrow extends Base {", "  label = (order: Order) => order.owner.title", "}"],
    "import { Base } from './base'\n",
  );
  const site = (owner: string): CarrierSite => ({ kind: "method-parameter", repo: "repo", file: "page.ts", owner, method: "label", index: 0 });

  for (const [owner, line] of [["Page", 3], ["Getter", 6]] as const) {
    const shadowed = await follow([base, page], site(owner), "owner");
    assert.deepEqual([uses(shadowed), frontiers(shadowed)], [[], [`${line} unmodelled-flow:component method is not a function`]]);
  }
  assert.deepEqual(uses(await follow([base, page], site("Arrow"), "owner")), ["9 owner.title|owner []"]);
});

test("a callback that reads its own arguments receives every value the call forwards: the positions no binding follows are frontiers at the callback, and an arrow function that reads none stays clean", async () => {
  const file = source("p.ts", [
    "function inspect() { show(arguments[2][0].owner.name) }",
    "function use(o: Order) {",
    "  o.items.forEach(inspect)",
    "  o.items.forEach(function () { show(arguments[2][0].owner.name) })",
    "  o.items.forEach(() => show(o.name))",
    "}",
  ]);
  const result = await follow([file], { ...paramO, line: at(2) }, "items[].owner");

  assert.deepEqual([uses(result), next(result), frontiers(result)], [[], [], ["3 unmodelled-flow:parameter position", "3 unmodelled-flow:parameter position", "4 unmodelled-flow:parameter position", "4 unmodelled-flow:parameter position"]]);
});

test("a function called directly that reads its own arguments is a frontier as well as a binding of the declared parameter", async () => {
  const file = source("p.ts", ["function inspect(order) { show(arguments[0].owner.name) }", "function use(o: Order) {", "  inspect(o)", "}"]);
  const result = await follow([file], { ...paramO, line: at(2) }, "owner");

  assert.deepEqual([next(result), frontiers(result)], [["parameter inspect#0@1 owner"], ["3 unmodelled-flow:parameter position"]]);
});

test("a callback whose rest parameter starts at or before a forwarded position receives that value in the rest array: a frontier there, a binding for the parameters before it", async () => {
  const file = source("p.ts", [
    "function gather(item, ...rest) { show(rest[1][0].owner.name) }",
    "function use(o: Order) {",
    "  o.items.forEach(gather)",
    "  o.items.forEach((item, ...rest) => show(rest[1][0].owner.name))",
    "  o.items.forEach((item, index, ...rest) => show(item.owner.name))",
    "}",
  ]);
  const result = await follow([file], { ...paramO, line: at(2) }, "items[].owner");

  assert.deepEqual([uses(result), next(result), frontiers(result)], [["5 owner.name|owner []"], ["parameter gather#0@1 owner"], ["3 unmodelled-flow:parameter position", "4 unmodelled-flow:parameter position", "5 unmodelled-flow:parameter position"]]);
});

test("a template call enters a subclass member declared with a quoted or a literal bracketed name as the member it names: it shadows the base method", async () => {
  const base = source("base.ts", ["export class Base {", "  label(order: Order) { return order.owner.name }", "}"]);
  const page = reader(["class Quoted extends Base {", "  'label' = helper", "}", "class Bracketed extends Base {", "  ['label'] = helper", "}", "class Method extends Base {", "  'label'(order: Order) { return order.owner.title }", "}", "class BracketedMethod extends Base {", "  ['label'](order: Order) { return order.owner.id }", "}"], "import { Base } from './base'\n");
  const site = (owner: string): CarrierSite => ({ kind: "method-parameter", repo: "repo", file: "page.ts", owner, method: "label", index: 0 });

  for (const [owner, line] of [["Quoted", 3], ["Bracketed", 6]] as const) {
    const shadowed = await follow([base, page], site(owner), "owner");
    assert.deepEqual([uses(shadowed), frontiers(shadowed)], [[], [`${line} unmodelled-flow:component method is not a function`]]);
  }
  assert.deepEqual(uses(await follow([base, page], site("Method"), "owner")), ["9 owner.title|owner []"]);
  assert.deepEqual(uses(await follow([base, page], site("BracketedMethod"), "owner")), ["12 owner.id|owner []"]);
});

test("a template call finds no method where a subclass member has a name computed from anything but a literal: any name may be it, so the base method is never read", async () => {
  const base = source("base.ts", ["export class Base {", "  label(order: Order) { return order.owner.name }", "}"]);
  const page = reader(["class Computed extends Base {", "  [key] = helper", "}"], "import { Base } from './base'\n");
  const result = await follow([base, page], { kind: "method-parameter", repo: "repo", file: "page.ts", owner: "Computed", method: "label", index: 0 }, "owner");

  assert.deepEqual([uses(result), frontiers(result)], [[], ["3 unmodelled-flow:component method is not a function"]]);
});

test("a member keyed by a well-known symbol never denotes a named member, so the inherited method is the one a template call enters", async () => {
  const base = source("base.ts", ["export class Base {", "  label(order: Order) { return order.owner.name }", "}"]);
  const page = reader(["class Listed extends Base {", "  [Symbol.iterator]() { return [][Symbol.iterator]() }", "}"], "import { Base } from './base'\n");
  const result = await follow([base, page], { kind: "method-parameter", repo: "repo", file: "page.ts", owner: "Listed", method: "label", index: 0 }, "owner");

  assert.deepEqual([uses(result), frontiers(result)], [["2 owner.name|owner []"], []]);
});

test("a static member lives on the constructor: it never shadows an instance method, and the instance method is the one a template call enters", async () => {
  const base = source("base.ts", ["export class Base {", "  label(order: Order) { return order.owner.name }", "}"]);
  const page = reader(
    ["class Field extends Base {", "  static label = helper", "}", "class Both {", "  static label(order: Order) { return order.owner.title }", "  label(order: Order) { return order.owner.id }", "}"],
    "import { Base } from './base'\n",
  );
  const site = (owner: string): CarrierSite => ({ kind: "method-parameter", repo: "repo", file: "page.ts", owner, method: "label", index: 0 });

  assert.deepEqual(uses(await follow([base, page], site("Field"), "owner")), ["2 owner.name|owner []"]);
  assert.deepEqual(uses(await follow([base, page], site("Both"), "owner")), ["7 owner.id|owner []"]);
});

test("a method of the callee table that holds no row for the carried value stays a frontier: an accumulator, an in-place replacement, a method the language's arrays do not hold", async () => {
  const file = plain(["o.items.reduce((a, i) => a, 0)", "o.items.fill(null)", "o.items.customMethod()", "o.name.map((i) => i.owner)"]);
  const result = await follow([file], paramO, "items[].owner");

  assert.deepEqual(frontiers(result), ["2 unmodelled-flow:method:reduce", "3 unmodelled-flow:method:fill", "4 unmodelled-flow:method:customMethod"]);
});

test("an object spread carries the properties of its source in order: a later member of that name replaces the property, a later spread the reader cannot read loses every following one", async () => {
  const file = plain([
    "const copy = { ...o, extra: 1 }",
    "show(copy.owner.name)",
    "const replaced = { ...o, owner: other }",
    "show(replaced.owner.name)",
    "const unknown = { ...o, ...rest }",
    "show(unknown.owner.name)",
    "const computed = { ...o, [key]: 1 }",
    "const same = { ...o, id: 4, ...{ title: 'x' } }",
    "show(same.owner.name)",
  ]);
  const result = await follow([file], paramO, "owner");

  assert.deepEqual(uses(result), ["3 owner.name|owner []", "10 owner.name|owner []"]);
  assert.deepEqual(frontiers(result), ["6 unmodelled-flow:later spread", "8 unmodelled-flow:computed member"]);
});

test("spreading the changed value itself is an iteration of an array and unmodelled for an object", async () => {
  const file = plain(["const list = [...o.items]", "const copy = { ...o.owner }", "show(f(...o.items))"]);
  const result = await follow([file], paramO, "items");
  const owned = await follow([file], paramO, "owner");

  assert.deepEqual(result.uses.map((use) => use.operation.end.kind), ["iterate", "iterate"]);
  assert.deepEqual(owned.uses.map((use) => [use.site.line - HEADER_LINES, use.operation.end]), [[3, { kind: "unmodelled", detail: "spread" }]]);
});

test("Object.assign follows its sources onto a fresh object literal only, in order", async () => {
  const file = plain([
    "const merged = Object.assign({}, o, { id: 1 })",
    "show(merged.owner.name)",
    "const over = Object.assign({}, o, { owner: other })",
    "show(over.owner.name)",
    "Object.assign(target, o)",
    "const later = Object.assign({}, o, rest)",
  ]);
  const result = await follow([file], paramO, "owner");

  assert.deepEqual(uses(result), ["3 owner.name|owner []"]);
  assert.deepEqual(frontiers(result), ["6 unmodelled-flow:Object.assign target", "7 unmodelled-flow:later source"]);
});

test("calling the changed value is a dereference, optional call included", async () => {
  const file = plain(["o.owner()", "o.owner?.()"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(uses(result), ["2 owner|owner []", "3 owner|owner [optional-chain]"]);
});

test("an optional chain guards a method call with arguments on the changed value", async () => {
  const file = plain(["show(o.owner?.name(1))", "show(o.owner.name(1))"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(uses(result), ["2 []|[] [optional-chain]", "3 []|[] []"]);
});

test("a read after a write to the guarded path reads the written value: no use, and the write is reported", async () => {
  const file = plain(["if (o.owner) {", "  o.owner = make()", "  show(o.owner.name)", "}"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(uses(result), []);
  assert.deepEqual(frontiers(result), ["3 unmodelled-flow:write to a member", "3 unmodelled-flow:write after guard"]);
});

test("a guard outside a closure is not proven where the closure runs: the read is reported, neither guarded nor unguarded", async () => {
  const file = plain(["if (o.owner) {", "  const f = () => o.owner.name", "  o.owner = null", "  f()", "}", "list.map(() => o.owner.id)"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(uses(result), ["7 owner.id|owner [reassigned]"]);
  assert.deepEqual(frontiers(result), ["3 unmodelled-flow:guard across closure", "4 unmodelled-flow:write to a member"]);
});

test("a call that only reports a resource's state is no loss of its value; a call that may read the value still is", async () => {
  const file = plain(["o.isLoading()", "o.error()", "o.hasValue()", "o.reload()", "o.update((v) => v)"]);
  const result = await follow([file], paramO, "value.owner");
  assert.deepEqual(frontiers(result), ["6 unmodelled-flow:method:update"]);
});

test("a guard inside a closure decides its reads even when another guard sits outside it", async () => {
  const file = plain(["if (o.owner) {", "  const f = () => { if (o.owner) show(o.owner.name) }", "  f()", "}"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(uses(result), ["3 owner.name|owner [condition]"]);
  assert.deepEqual(frontiers(result), []);
});

test("reads of a name before it is assigned the followed value are not the followed value", async () => {
  const file = plain(["let x = other", "show(x.owner.name)", "x = o", "show(x.owner.id)", "x = another", "show(x.owner.size)"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(uses(result), ["5 owner.id|owner []"]);
  assert.deepEqual(frontiers(result), []);
});

test("an assignment that may or may not run keeps the later reads under an untested reassigned guard and reports the conditional write", async () => {
  const file = plain(["let x = o", "show(x.owner.id)", "if (flag) { x = other }", "show(x.owner.name)"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(uses(result), ["3 owner.id|owner []", "5 owner.name|owner [reassigned]"]);
  assert.deepEqual(frontiers(result), ["4 unmodelled-flow:conditional reassignment"]);
  assert.deepEqual(result.uses[1]!.guards.map((guard) => [guard.kind, formatAccessPath(guard.covers)]), [["reassigned", "owner"]]);
});

test("a write a dynamic scope may make keeps the later reads under the reassigned guard too", async () => {
  const file = { path: "p.ts", content: "function use(o: Order) {\n  let x = o\n  with (scope) { x = other }\n  show(x.owner.id)\n}" };

  assert.deepEqual(uses(await follow([file], dynamicUse, "owner")).map((use) => use.slice(use.indexOf("["))), ["[reassigned]"]);
});

test("two trails that reach one read with different guards are both kept, so a guard on one never hides the other's failure", async () => {
  const file = plain(["const v = c ? (o.owner ? o : other) : o", "show(v.owner.name)"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(uses(result), ["3 owner.name|owner [condition]", "3 owner.name|owner []"]);
});

test("a write to a member of the carried value ends the chain with a frontier at the write; the reads after it are not proven", async () => {
  const written = plain(["o.owner = make()", "show(o.owner.name)"]);
  const result = await follow([written], paramO, "owner");
  assert.deepEqual(frontiers(result), ["2 unmodelled-flow:write to a member"]);
  assert.deepEqual(uses(result), ["3 owner.name|owner [reassigned]"]);

  const inside = await follow([plain(["o.owner.name = 'x'"])], paramO, "owner");
  assert.deepEqual(frontiers(inside), ["2 unmodelled-flow:write to a member"]);
  assert.deepEqual(uses(inside), []);
});

test("a write that cannot alter the changed path or a built-in method is no loss; one that can patch a built-in is", async () => {
  const other = await follow([plain(["o.id = 4", "show(o.owner.name)"])], paramO, "owner");
  assert.deepEqual(frontiers(other), []);
  assert.deepEqual(uses(other), ["3 owner.name|owner []"]);

  const patched = await follow([plain(["o.items.map = make()", "o.items.map((i) => i.owner.name)"])], paramO, "items[].owner");
  assert.ok(frontiers(patched).includes("2 unmodelled-flow:write to a member"), frontiers(patched).join(", "));
});

test("Object.assign or Object.defineProperty with the carried value as target ends the chain with a frontier", async () => {
  const assigned = await follow([plain(["Object.assign(o, patch)", "show(o.owner.name)"])], paramO, "owner");
  const defined = await follow([plain(["Object.defineProperty(o, 'owner', { value: null })"])], paramO, "owner");

  assert.deepEqual(frontiers(assigned), ["2 unmodelled-flow:write to a member"]);
  assert.deepEqual(frontiers(defined), ["2 unmodelled-flow:write to a member"]);
});

test("a function reference given to tap receives the value; it is not dropped", async () => {
  const file = source("a.ts", [
    "class Page {",
    "  constructor(private http: HttpClient) {}",
    "  log(o: Order) {}",
    "  load() {",
    "    this.http.get<Order>('/orders/1').pipe(tap(this.log), tap(isReady)).subscribe()",
    "  }",
    "}",
  ]);
  const result = await follow([file], callSite("a.ts", 5, "Page.load"), "owner");

  assert.deepEqual(next(result), ["parameter log#0@3 owner"]);
  assert.deepEqual(frontiers(result), ["5 unmodelled-sink:isReady"]);
});

test("a parameter that shadows a top-level function is not that function", async () => {
  const file = source("p.ts", ["function render(x: Order) { return x.owner.name }", "function use(o: Order, render: Fn) { render(o) }"]);
  const result = await follow([file], { ...paramO, line: at(2) }, "owner");
  assert.deepEqual(next(result), []);
  assert.deepEqual(frontiers(result), ["2 unmodelled-sink:render"]);
});

test("a var declared in a block is the whole function's binding, so its reads there are not the followed value", async () => {
  const file = plain(["const run = () => {", "  if (o) { var o = other }", "  show(o.owner.name)", "}", "show(o.owner.id)"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(uses(result), ["6 owner.id|owner []"]);
});

test("an assignment binds the declaration its case block shares, never an outer one of the same name", async () => {
  const file = plain(["let x = o", "switch (k) {", "  case 1: let x = 0; break", "  case 2: x = o.owner", "}", "show(x.owner.id)"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(uses(result), ["7 owner.id|owner []"]);
});

test("a var declared in a block holds the followed value past the block", async () => {
  const result = await follow([plain(["if (c) { var x = o }", "show(x.owner.id)"])], paramO, "owner");
  assert.deepEqual(uses(result), ["3 owner.id|owner []"]);
});

test("a function declared in one case clause is the callee of a call in another, over a top-level one of the same name", async () => {
  const file = source("p.ts", ["function render(x: Order) {}", "function use(o: Order) {", "  switch (k) {", "    case 1: function render(y: Order) {} break", "    case 2: render(o)", "  }", "}"]);
  const result = await follow([file], { ...paramO, line: at(2) }, "owner");
  assert.deepEqual(next(result), ["parameter render#0@4 owner"]);
});

const dynamicScopes = (body: string) => ({
  eval: { path: "p.ts", content: `function use(o: Order) {\n  eval(code)\n  ${body}\n}` },
  with: { path: "p.ts", content: `function use(o: Order) {\n  with (scope) {\n    ${body}\n  }\n}` },
});
const dynamicUse = { kind: "parameter" as const, repo: "repo", file: "p.ts", symbol: "use", line: 1, index: 0 };
const raw = (result: FlowResult) => ({ uses: result.uses.map((use) => use.site.line), next: result.next.length, frontiers: result.frontiers.map((frontier) => `${frontier.at.line} ${frontier.cause}:${frontier.detail}`) });

test("a read whose binding a dynamic scope leaves uncertain is a frontier at the read, never a use or a silent drop", async () => {
  const { eval: evaluated, with: within } = dynamicScopes("show(o.owner.id)");

  assert.deepEqual(raw(await follow([evaluated], dynamicUse, "owner")), { uses: [], next: 0, frontiers: ["3 unmodelled-flow:dynamic scope"] });
  assert.deepEqual(raw(await follow([within], dynamicUse, "owner")), { uses: [], next: 0, frontiers: ["3 unmodelled-flow:dynamic scope"] });
});

test("a call passing a read a dynamic scope leaves uncertain is a frontier, never a callee claimed by name", async () => {
  const render = "function render(y: Order) { return y.owner.id }\n";
  const { eval: evaluated, with: within } = dynamicScopes("render(o)");

  for (const file of [evaluated, within]) {
    const result = await follow([{ ...file, content: render + file.content }], { ...dynamicUse, line: 2 }, "owner");
    assert.equal(result.next.length, 0);
    assert.ok(result.frontiers.some((frontier) => frontier.detail === "dynamic scope"));
  }
});

test("a callee a dynamic scope names is no function of the repository, even when the value passed to it is certain", async () => {
  const file = { path: "p.ts", content: "function render(y: Order) { return y.owner.id }\nclass Page {\n  held: Order\n  show() { with (scope) { render(this.held) } }\n}" };
  const result = await follow([file], { kind: "member", repo: "repo", file: "p.ts", owner: "Page", member: "held" }, "owner");

  assert.deepEqual(result.next, []);
  assert.notDeepEqual(result.frontiers, []);
});

test("a write a dynamic scope may send elsewhere is a frontier, and the reads after it still hold the value", async () => {
  const file = { path: "p.ts", content: "function use(o: Order) {\n  let x = o\n  with (scope) { x = other }\n  show(x.owner.id)\n}" };

  assert.deepEqual(raw(await follow([file], dynamicUse, "owner")), { uses: [4], next: 0, frontiers: ["3 unmodelled-flow:dynamic scope"] });
});

test("a write a dynamic scope may make to the guarded path voids the guard: no use after it, and the write is reported", async () => {
  const file = { path: "p.ts", content: "function use(o: Order) {\n  if (o.owner) {\n    with (scope) { o.owner = other }\n    show(o.owner.id)\n  }\n}" };
  const result = raw(await follow([file], dynamicUse, "owner"));

  assert.deepEqual(result.uses, []);
  assert.ok(result.frontiers.includes("3 unmodelled-flow:write after guard"), result.frontiers.join(", "));
});

test("a followed value read as a destructuring default or by an export specifier stays a frontier there", async () => {
  const defaulted = await follow([plain(["const { a = o } = {} as any", "show(a.owner.id)"])], paramO, "owner");
  const exported = await follow([source("p.ts", ["let held: any", "function use(o: Order) { held = o }", "export { held }"])], { ...paramO, line: at(2) }, "owner");

  assert.deepEqual(frontiers(defaulted), ["2 unmodelled-flow:BindingElement"]);
  assert.deepEqual(frontiers(exported), ["3 unmodelled-flow:ExportSpecifier"]);
});

test("a local function declaration is the callee over a top-level one of the same name", async () => {
  const file = source("p.ts", ["function render(x: Order) {}", "function use(o: Order) {", "  function render(y: Order) {}", "  render(o)", "}"]);
  const result = await follow([file], { ...paramO, line: at(2) }, "owner");
  assert.deepEqual(next(result), ["parameter render#0@3 owner"]);
});

test("every fallback on the changed value is a guard whose replacement is the JSON the right side writes, or opaque", async () => {
  const file = plain([
    "show((o.owner ?? null).name)",
    "show((o.owner ?? [1, 'b']).length)",
    "show((o.owner || 'x').length)",
    "show((o.owner ?? -1).toFixed())",
    "show((o.owner ?? <Owner>{ a: [true], 'b': 2, 3: null }).name)",
    "show((o.owner ?? make()).name)",
    "show((o.owner ?? { ...rest }).name)",
    "show((o.owner ?? { name }).name)",
    "show((o.owner ?? [...rest]).length)",
    "show((o.owner ?? `t`).length)",
    "show((o.owner ?? `t${x}`).length)",
  ]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(guardsOf(result), [
    ["fallback != null true -> null"],
    ["fallback != null true -> [1,\"b\"]"],
    ["fallback truthy true -> \"x\""],
    ["fallback != null true -> -1"],
    ["fallback != null true -> {\"3\":null,\"a\":[true],\"b\":2}"],
    ["fallback != null true -> opaque"],
    ["fallback != null true -> opaque"],
    ["fallback != null true -> opaque"],
    ["fallback != null true -> opaque"],
    ["fallback != null true -> \"t\""],
    ["fallback != null true -> opaque"],
  ]);
});

test("guards are listed in the order the value passes them: a fallback before the condition that tests its result", async () => {
  const file = plain(["const owner = o.owner ?? null", "if (owner) { show(owner.name) }"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(guardsOf(result), [["fallback != null true -> null", "condition truthy true"]]);
});

test("an async or generator projection does not emit the response", async () => {
  const file = source("a.ts", [
    "class Page {",
    "  constructor(private http: HttpClient) {}",
    "  load() {",
    "    this.http.get<Order>('/orders/1').pipe(map(async (o) => o)).subscribe((v) => show(v.owner.name))",
    "    this.http.get<Order>('/orders/1').pipe(map(function* (o) { return o })).subscribe((v) => show(v.owner.name))",
    "  }",
    "}",
  ]);
  const first = await follow([file], callSite("a.ts", 4, "Page.load"), "owner");
  assert.deepEqual(uses(first), []);
  assert.deepEqual(frontiers(first), ["4 unmodelled-flow:async projection"]);
  const second = await follow([file], callSite("a.ts", 5, "Page.load"), "owner");
  assert.deepEqual(uses(second), []);
  assert.deepEqual(frontiers(second), ["5 unmodelled-flow:generator projection"]);
});

test("destructuring the changed value is a dereference even with an empty pattern", async () => {
  const file = plain(["const {} = o.owner", "const [] = o.owner"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(uses(result), ["2 []|[] []", "3 []|[] []"]);
});

test("an assignment inside a loop reports that earlier reads of the name may follow it", async () => {
  const file = plain(["let x = other", "while (flag) {", "  show(x.owner.name)", "  x = o", "}"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(frontiers(result), ["5 unmodelled-flow:assignment in a loop"]);
});

/** The guards of the uses below the switched value, one entry per `show(order.owner.<name>)`, keyed by that name. */
async function switchGuards(lines: readonly string[]) {
  const result = await follow([guarded(lines)], parameterOrder, "owner");
  return Object.fromEntries(result.uses.filter((use) => use.path.length > 1).map((use) => [use.path.at(-1), use.guards.map(guardText)]));
}

test("a use in a switch clause runs only where the switched value equals the clause's label, and a switch on another path guards nothing", async () => {
  assert.deepEqual(await switchGuards(["switch (order.owner) {", "  case 'A': show(order.owner.a); break", "  case -1: show(order.owner.neg); break", "}"]), { a: ['condition one-of "A" true'], neg: ["condition one-of -1 true"] });
  assert.deepEqual(await switchGuards(["switch (order.id) {", "  case 'A': show(order.owner.a); break", "}"]), { a: [] });
});

test("clauses with no statements fall through: the use runs where the value equals any of the labels that lead to it, null and undefined included", async () => {
  const guards = await switchGuards(["switch (order.owner) {", "  case 'A': case 'B': show(order.owner.ab); break", "  case null: case undefined: show(order.owner.nil)", "}"]);
  assert.deepEqual(guards, { ab: ['condition one-of "A"|"B" true'], nil: ["condition one-of null|undefined true"] });
});

test("a clause that does not exit falls through into the next, and one that breaks, returns, throws or continues starts a new group", async () => {
  const guards = await switchGuards([
    "for (const i of items) {",
    "  switch (order.owner) {",
    "    case 'A': show(order.owner.a)",
    "    case 'B': show(order.owner.ab); break",
    "    case 'C': show(order.owner.c); return",
    "    case 'D': show(order.owner.d); throw new Error()",
    "    case 'E': show(order.owner.e); continue",
    "    case 'F': if (flag) break; show(order.owner.f)",
    "    case 'G': show(order.owner.fg)",
    "  }",
    "}",
  ]);
  assert.deepEqual(guards, {
    a: ['condition one-of "A" true'],
    ab: ['condition one-of "A"|"B" true'],
    c: ['condition one-of "C" true'],
    d: ['condition one-of "D" true'],
    e: ['condition one-of "E" true'],
    f: ['condition one-of "F" true'],
    fg: ['condition one-of "F"|"G" true'],
  });
});

test("a default clause alone runs where the value equals none of the labels, and one in a fallthrough group where it equals none outside the group", async () => {
  assert.deepEqual(await switchGuards(["switch (order.owner) {", "  case 'A': show(order.owner.a); break", "  case 'B': show(order.owner.b); break", "  default: show(order.owner.d)", "}"]), {
    a: ['condition one-of "A" true'],
    b: ['condition one-of "B" true'],
    d: ['condition one-of "A"|"B" false'],
  });
  assert.deepEqual(await switchGuards(["switch (order.owner) {", "  default: show(order.owner.d)", "}"]), { d: [] });
  const grouped = await switchGuards(["switch (order.owner) {", "  case 'A': show(order.owner.a); break", "  default: show(order.owner.d)", "  case 'B': show(order.owner.b); break", "  case 'C': show(order.owner.c)", "}"]);
  assert.deepEqual(grouped, {
    a: ['condition one-of "A" true'],
    d: ['condition one-of "A"|"B"|"C" false'],
    b: ['condition one-of "A"|"C" false'],
    c: ['condition one-of "C" true'],
  });
});

test("a label that is not a literal makes the group's guard an untested case, whichever side of default it sits", async () => {
  const guards = await switchGuards(["switch (order.owner) {", "  case other: show(order.owner.x); break", "  case 'A': case this.kind: show(order.owner.y); break", "  case 'B': show(order.owner.z); break", "  default: show(order.owner.d)", "}"]);
  assert.deepEqual(guards, { x: ["case"], y: ["case"], z: ['condition one-of "B" true'], d: ["case"] });
});

test("statements after the switch get nothing from it", async () => {
  assert.deepEqual(await switchGuards(["switch (order.owner) {", "  case 'A': show(order.owner.a); break", "}", "show(order.owner.after)"]), { a: ['condition one-of "A" true'], after: [] });
});
