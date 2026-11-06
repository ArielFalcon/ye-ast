import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAccessPath, parseAccessPath } from "../../domain/contracts/access-path.ts";
import type { Carrier, CarrierSite, FlowResult } from "../../domain/contracts/consumer-flow.ts";
import { createConsumerFlowReader } from "./consumer-flow.adapter.ts";

const COMMON = "import { HttpClient } from '@angular/common/http'\nimport { map, tap, switchMap, catchError } from 'rxjs'\nimport { firstValueFrom, of } from 'rxjs'\nimport { toSignal } from '@angular/core/rxjs-interop'\nimport { httpResource } from '@angular/common/http'\nimport { resource, signal, computed, input } from '@angular/core'\n";
const HEADER_LINES = COMMON.split("\n").length - 1;

/** A source whose body starts at line `HEADER_LINES + 1`. */
function source(path: string, lines: readonly string[]) {
  return { path, content: COMMON + lines.join("\n") };
}

const at = (line: number) => line + HEADER_LINES;

async function follow(files: readonly { path: string; content: string }[], site: CarrierSite, path: string): Promise<FlowResult> {
  const reader = await createConsumerFlowReader(files, "repo");
  const carrier: Carrier = { site, path: parseAccessPath(path)! };
  return reader.follow(carrier);
}

const callSite = (file: string, line: number, symbol: string): CarrierSite => ({ kind: "call-site", repo: "repo", file, line: at(line), symbol });

const dotted = (path: readonly string[]) => formatAccessPath(path) || "[]";
const uses = (result: FlowResult) => result.uses.map((use) => `${use.site.line - HEADER_LINES} ${dotted(use.path)}|${dotted(use.changed)} ${use.operation} [${use.guards.map((guard) => guard.kind).join(",")}]`);
const frontiers = (result: FlowResult) => result.frontiers.map((frontier) => `${frontier.at.line - HEADER_LINES} ${frontier.cause}${frontier.detail === undefined ? "" : `:${frontier.detail}`}`);
const next = (result: FlowResult) =>
  result.next.map(({ carrier }) => {
    const { site } = carrier;
    const where = site.kind === "member" ? `${site.owner}.${site.member}` : site.kind === "parameter" ? `${site.symbol}#${site.index}` : "symbol" in site ? site.symbol : site.kind === "input" ? site.name : site.callee;
    return `${site.kind} ${where}@${site.kind === "member" ? (site.line === undefined ? "-" : site.line - HEADER_LINES) : site.kind === "input" ? "-" : site.line - HEADER_LINES} ${dotted(carrier.path)}`;
  });
const steps = (result: FlowResult) => result.next.map(({ hops }) => hops.map((hop) => hop.step).join(">"));

const SERVICE = (body: string) => [
  "class OrderService {",
  "  constructor(private http: HttpClient) {}",
  `  find() { return ${body} }`,
  "}",
];

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
  assert.deepEqual(uses(result), ["5 owner.name|owner dereference []"]);
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
  assert.deepEqual(uses(result), ["5 body.owner.name|body.owner dereference []"]);
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
  assert.deepEqual(uses(result), ["9 who.name|who dereference []"]);
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
  assert.deepEqual(uses(result), ["9 name|[] dereference []"]);
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
  assert.deepEqual(uses(result), ["5 name|[] dereference []"]);
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
  assert.deepEqual(uses(result), ["3 owner.name|owner dereference []"]);
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
  assert.deepEqual(uses(second), ["4 owner.name|owner dereference []"]);
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
  assert.deepEqual(uses(signalRead), ["6 owner.name|owner dereference []"]);
  const resourceRead = await follow([file], { kind: "member", repo: "repo", file: "a.ts", owner: "Page", member: "loaded" }, "value.owner");
  assert.deepEqual(uses(resourceRead), ["7 value.owner.name|value.owner dereference []"]);
  const plainRead = await follow([file], { kind: "member", repo: "repo", file: "a.ts", owner: "Page", member: "plain" }, "owner");
  assert.deepEqual(uses(plainRead), ["8 owner.name|owner dereference []"]);
});

test("a write to a member is not a read of it", async () => {
  const file = source("a.ts", ["class Page {", "  order: Order", "  reset() { this.order = null; this.order.owner.name }", "}"]);
  const result = await follow([file], { kind: "member", repo: "repo", file: "a.ts", owner: "Page", member: "order" }, "owner");
  assert.deepEqual(uses(result), ["3 owner.name|owner dereference []"]);
});

function guarded(lines: readonly string[]) {
  return source("g.ts", ["class Page {", "  use(order: Order) {", ...lines.map((line) => `    ${line}`), "  }", "}"]);
}

const parameterOrder = { kind: "parameter" as const, repo: "repo", file: "g.ts", symbol: "use", line: at(2), index: 0 };

test("each guard form protects the reads it dominates and no others", async () => {
  const file = guarded([
    "show(order.owner?.name)", // 3 optional chain
    "if (order.owner) { show(order.owner.name) }", // 4 truthiness
    "if (order.owner != null) { show(order.owner.name) }", // 5 comparison
    "if (order.owner !== undefined) { show(order.owner.name) }", // 6 comparison (undefined only)
    "const ok = order.owner && order.owner.name", // 7 truthiness via &&
    "show(order.owner ? order.owner.name : '')", // 8 ternary
    "show(order.owner!.name)", // 9 non-null assertion
    "show(order.owner.name)", // 10 unguarded
  ]);
  const result = await follow([file], parameterOrder, "owner");
  assert.deepEqual(uses(result), [
    "3 owner.name|owner dereference [optional-chain]",
    "4 owner.name|owner dereference [truthiness]",
    "5 owner.name|owner dereference [comparison]",
    "6 owner.name|owner dereference [comparison]",
    "7 owner.name|owner dereference [truthiness]",
    "8 owner.name|owner dereference [truthiness]",
    "9 owner.name|owner dereference [non-null-assertion]",
    "10 owner.name|owner dereference []",
  ]);
  assert.deepEqual(result.uses[3]!.guards[0]!.excludes, ["undefined"]);
  assert.deepEqual(result.uses[2]!.guards[0]!.excludes, ["null", "undefined"]);
});

test("an early return or throw on the negation guards the rest of the block", async () => {
  const file = guarded(["if (!order.owner) return", "show(order.owner.name)"]);
  const result = await follow([file], parameterOrder, "owner");
  assert.deepEqual(uses(result), ["4 owner.name|owner dereference [early-exit]"]);
});

test("a guard that tests a different path or sits in the other branch does not protect", async () => {
  const file = guarded(["if (order.id) { show(order.owner.name) }", "if (order.owner) {} else { show(order.owner.name) }"]);
  const result = await follow([file], parameterOrder, "owner");
  assert.deepEqual(uses(result), ["3 owner.name|owner dereference []", "4 owner.name|owner dereference []"]);
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
  assert.deepEqual(uses(result), ["4 owner.name|owner dereference [type-guard]", "5 owner.name|owner dereference [instanceof]"]);
});

test("a fallback on the changed value guards what it flows to; a destructuring default covers undefined only", async () => {
  const file = guarded(["const owner = order.owner ?? {}", "show(owner.name)", "const { owner: second = {} } = order", "show(second.name)"]);
  const result = await follow([file], parameterOrder, "owner");
  assert.deepEqual(uses(result), ["4 name|[] dereference [fallback]", "6 name|[] dereference [fallback]"]);
  assert.deepEqual(result.uses[1]!.guards[0]!.excludes, ["undefined"]);
});

test("operations on the exact changed value: dereference, consume and unmodelled", async () => {
  const file = guarded(["for (const x of order.tags) {}", "show(`${order.tags}`)", "const same = order.tags === other", "audit(order.tags)", "if (order.tags === null) {}", "[...order.tags]"]);
  const result = await follow([file], parameterOrder, "tags");
  assert.deepEqual(uses(result), [
    "3 []|[] dereference []",
    "4 []|[] consume []",
    "5 []|[] consume []",
    "6 []|[] consume []",
    "8 []|[] dereference []",
  ]);
});

test("elements of an array are followed through for-of with the element path", async () => {
  const file = guarded(["for (const item of order.items) { show(item.owner.name) }"]);
  const result = await follow([file], parameterOrder, "items[].owner");
  assert.deepEqual(uses(result), ["3 owner.name|owner dereference []"]);
});

test("iterating a value whose changed path does not continue through its elements is a frontier", async () => {
  const file = guarded(["for (const x of order.owner) { show(x.name) }"]);
  const result = await follow([file], parameterOrder, "owner.name");
  assert.deepEqual(frontiers(result), ["3 unmodelled-flow:iteration"]);
});

test("a value that contains the changed property reaching code outside the repository is a frontier", async () => {
  const file = guarded([
    "this.form.patchValue(order)",
    "order.items.map((i) => i.owner.name)",
    "const copy = { ...order }",
    "Library.use(order)",
    "this.dyn[order.key]",
  ]);
  const result = await follow([file], parameterOrder, "items[].owner");
  assert.deepEqual(frontiers(result), ["3 unmodelled-sink:this.form.patchValue", "4 unmodelled-flow:method:map", "5 unmodelled-flow:object spread", "6 unmodelled-sink:Library.use"]);
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

const ROUTES = (extra: string) => [
  source("order.resolver.ts", ["export const orderResolver = () => inject(OrderService).find(1)"]),
  source("order.component.ts", [
    "export class OrderComponent {",
    "  order = input<Order>()",
    "  route = inject(ActivatedRoute)",
    "  constructor() { this.route.data.subscribe(({ order }) => show(order.owner.name)) }",
    "}",
  ]),
  source("app.routes.ts", [
    "import { orderResolver } from './order.resolver'",
    "import { OrderComponent } from './order.component'",
    "export const routes = [{ path: 'orders/:id', component: OrderComponent, resolve: { order: orderResolver } }]",
    extra,
  ]),
];

const resolverReturn = { kind: "return" as const, repo: "repo", file: "order.resolver.ts", symbol: "orderResolver", line: at(1) };

test("a route resolver continues to the component input when input binding is enabled, and to its route data reads", async () => {
  const files = ROUTES("import { provideRouter, withComponentInputBinding } from '@angular/router'\nexport const config = [provideRouter(routes, withComponentInputBinding())]");
  const result = await follow(files, resolverReturn, "owner");
  assert.deepEqual(next(result), ["input order@- owner"]);
  assert.deepEqual(steps(result), ["resolver-input"]);
  assert.deepEqual(uses(result), ["4 owner.name|owner dereference []"]);
  assert.deepEqual(result.uses[0]!.hops.map((hop) => hop.step), ["resolver-input", "route-data", "subscribe", "assign"]);
});

test("without input binding the component input is a frontier with its reason, route data is still read", async () => {
  const result = await follow(ROUTES(""), resolverReturn, "owner");
  assert.deepEqual(next(result), []);
  assert.equal(result.frontiers[0]!.cause, "unsupported-binding");
  assert.deepEqual(uses(result), ["4 owner.name|owner dereference []"]);
});

test("a function that no route registers adds nothing at its return", async () => {
  const result = await follow(ROUTES(""), { kind: "return", repo: "repo", file: "order.resolver.ts", symbol: "other", line: at(1) }, "owner");
  assert.deepEqual(result, { uses: [], next: [], frontiers: [] });
});

test("results are in source order and identical across runs", async () => {
  const file = guarded(["show(order.owner.name)", "show(order.owner.id)", "show(order.owner.name)"]);
  const first = await follow([file], parameterOrder, "owner");
  const second = await follow([file], parameterOrder, "owner");
  assert.deepEqual(first, second);
  assert.deepEqual(uses(first), ["3 owner.name|owner dereference []", "4 owner.id|owner dereference []", "5 owner.name|owner dereference []"]);
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
  assert.deepEqual(uses(result), ["3 owner.name|owner dereference []"]);
  assert.deepEqual(frontiers(result), []);
});

test("a lambda parameter that shadows the followed name is not the followed value", async () => {
  const file = guarded(["items.map((order) => order.owner.name)", "show(order.owner.id)"]);
  const result = await follow([file], parameterOrder, "owner");
  assert.deepEqual(uses(result), ["4 owner.id|owner dereference []"]);
});

test("reassignment cycles terminate and report each use once", async () => {
  const file = guarded(["let a = order", "let b = a", "a = b", "show(a.owner.name)"]);
  const result = await follow([file], parameterOrder, "owner");
  assert.deepEqual(uses(result), ["6 owner.name|owner dereference []"]);
});

test("a computed key into the path to the changed property is a dynamic-access frontier", async () => {
  const file = guarded(["show(order[key].name)"]);
  const result = await follow([file], parameterOrder, "owner");
  assert.deepEqual(frontiers(result), ["3 dynamic-access"]);
});

test("fetch with then handlers reaches the parsed body", async () => {
  const file = source("a.ts", ["class Page {", "  load() {", "    fetch('/orders/1').then((r) => r.json()).then((o) => show(o.owner.name))", "  }", "}"]);
  const result = await follow([file], callSite("a.ts", 3, "Page.load"), "owner");
  assert.deepEqual(uses(result), ["3 owner.name|owner dereference []"]);
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
  assert.deepEqual(uses(result), ["4 name|[] dereference []"]);
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

function plain(lines: readonly string[]) {
  return source("p.ts", ["function use(o: Order) {", ...lines.map((line) => `  ${line}`), "}"]);
}

const paramO = { kind: "parameter" as const, repo: "repo", file: "p.ts", symbol: "use", line: at(1), index: 0 };

test("a method called on a container of the changed property is a frontier, whatever its argument count", async () => {
  const file = plain(["const copy = o.items.slice()", "show(copy[0].owner.name)", "o.items.map((i) => i.owner.name)"]);
  const result = await follow([file], paramO, "items[].owner");
  assert.deepEqual(frontiers(result), ["2 unmodelled-flow:method:slice", "4 unmodelled-flow:method:map"]);
  assert.deepEqual(uses(result), []);
});

test("calling the changed value is a dereference, optional call included", async () => {
  const file = plain(["o.owner()", "o.owner?.()"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(uses(result), ["2 owner|owner dereference []", "3 owner|owner dereference [optional-chain]"]);
});

test("an optional chain guards a method call with arguments on the changed value", async () => {
  const file = plain(["show(o.owner?.name(1))", "show(o.owner.name(1))"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(uses(result), ["2 []|[] dereference [optional-chain]", "3 []|[] dereference []"]);
});

test("a read after a write to the guarded path reads the written value: no use, and the write is reported", async () => {
  const file = plain(["if (o.owner) {", "  o.owner = make()", "  show(o.owner.name)", "}"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(uses(result), []);
  assert.deepEqual(frontiers(result), ["3 unmodelled-flow:write after guard"]);
});

test("a guard outside a closure is not proven where the closure runs: the read is reported, neither guarded nor unguarded", async () => {
  const file = plain(["if (o.owner) {", "  const f = () => o.owner.name", "  o.owner = null", "  f()", "}", "list.map(() => o.owner.id)"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(uses(result), ["7 owner.id|owner dereference []"]);
  assert.deepEqual(frontiers(result), ["3 unmodelled-flow:guard across closure"]);
});

test("reads of a name before it is assigned the followed value are not the followed value", async () => {
  const file = plain(["let x = other", "show(x.owner.name)", "x = o", "show(x.owner.id)", "x = another", "show(x.owner.size)"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(uses(result), ["5 owner.id|owner dereference []"]);
  assert.deepEqual(frontiers(result), []);
});

test("an assignment that may or may not run keeps the later reads and reports the conditional write", async () => {
  const file = plain(["let x = o", "if (flag) { x = other }", "show(x.owner.name)"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(uses(result), ["4 owner.name|owner dereference []"]);
  assert.deepEqual(frontiers(result), ["3 unmodelled-flow:conditional reassignment"]);
});

test("a parameter that shadows a top-level function is not that function", async () => {
  const file = source("p.ts", ["function render(x: Order) { return x.owner.name }", "function use(o: Order, render: Fn) { render(o) }"]);
  const result = await follow([file], { ...paramO, line: at(2) }, "owner");
  assert.deepEqual(next(result), []);
  assert.deepEqual(frontiers(result), ["2 unmodelled-sink:render"]);
});

test("a local function declaration is the callee over a top-level one of the same name", async () => {
  const file = source("p.ts", ["function render(x: Order) {}", "function use(o: Order) {", "  function render(y: Order) {}", "  render(o)", "}"]);
  const result = await follow([file], { ...paramO, line: at(2) }, "owner");
  assert.deepEqual(next(result), ["parameter render#0@3 owner"]);
});

test("a fallback guards only when its value is proven present", async () => {
  const file = plain(["const a = o.owner ?? null", "show(a.name)", "const b = o.owner ?? {}", "show(b.name)", "const { owner: c = null } = o", "show(c.name)"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(uses(result), ["3 name|[] dereference []", "5 name|[] dereference [fallback]", "7 name|[] dereference []"]);
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
  assert.deepEqual(uses(result), ["2 []|[] dereference []", "3 []|[] dereference []"]);
});

const INPUTS = [
  "import { Input, model } from '@angular/core'",
  "export class OrderComponent {",
  "  @Input() plain: Order",
  "  @Input('aliased') renamed: Order",
  "  @Input({ alias: 'objAlias' }) objRenamed: Order",
  "  sig = input<Order>()",
  "  req = input.required<Order>({ alias: 'reqAlias' })",
  "  both = model<Order>(undefined, { alias: 'modelAlias' })",
  "  field: any",
  "}",
];

const inputSite = (name: string): CarrierSite => ({ kind: "input", repo: "repo", file: "order.component.ts", owner: "OrderComponent", name });

test("an input carrier resolves its public name to the member that declares the input", async () => {
  const file = source("order.component.ts", INPUTS);
  const names: Record<string, string> = { plain: "plain", aliased: "renamed", objAlias: "objRenamed", sig: "sig", reqAlias: "req", modelAlias: "both" };
  for (const [publicName, member] of Object.entries(names)) {
    const result = await follow([file], inputSite(publicName), "owner");
    assert.deepEqual(next(result).map((line) => line.split("@")[0]), [`member OrderComponent.${member}`], publicName);
    assert.deepEqual(steps(result), ["input"], publicName);
    assert.deepEqual(frontiers(result), [], publicName);
  }
});

test("a name that no input declares is a frontier at the class, the original name of an aliased input included", async () => {
  const file = source("order.component.ts", INPUTS);
  for (const name of ["field", "renamed", "missing"]) {
    const result = await follow([file], inputSite(name), "owner");
    assert.deepEqual(next(result), [], name);
    assert.deepEqual(frontiers(result), [`2 unsupported-binding:not-an-input:${name}`], name);
  }
});

test("input binding is proven only by withComponentInputBinding() inside the provideRouter call that registers the routes", async () => {
  const unused = ROUTES("import { provideRouter, withComponentInputBinding } from '@angular/router'\nconst unused = withComponentInputBinding()\nexport const config = [provideRouter(routes)]");
  const refused = await follow(unused, resolverReturn, "owner");
  assert.deepEqual(next(refused), []);
  assert.equal(refused.frontiers[0]!.cause, "unsupported-binding");
  const other = ROUTES("import { provideRouter, withComponentInputBinding } from '@angular/router'\nexport const config = [provideRouter(elsewhere, withComponentInputBinding())]");
  assert.deepEqual(next(await follow(other, resolverReturn, "owner")), []);
  const module = ROUTES("import { RouterModule } from '@angular/router'\nexport const config = [RouterModule.forRoot(routes, { bindToComponentInputs: true })]");
  assert.deepEqual(next(await follow(module, resolverReturn, "owner")), ["input order@- owner"]);
});

test("a resolver key reaches the input carrier by its public name, not a member", async () => {
  const files = ROUTES("import { provideRouter, withComponentInputBinding } from '@angular/router'\nexport const config = [provideRouter(routes, withComponentInputBinding())]");
  const result = await follow(files, resolverReturn, "owner");
  assert.deepEqual(next(result), ["input order@- owner"]);
  assert.deepEqual(steps(result), ["resolver-input"]);
});

test("input binding registered in another file reaches the routes it imports", async () => {
  const [resolver, component, routes] = ROUTES("");
  const main = source("main.ts", ["import { provideRouter, withComponentInputBinding } from '@angular/router'", "import { routes } from './app.routes'", "export const config = [provideRouter(routes, withComponentInputBinding())]"]);
  const result = await follow([resolver!, component!, routes!, main], resolverReturn, "owner");
  assert.deepEqual(next(result), ["input order@- owner"]);
});

test("an assignment inside a loop reports that earlier reads of the name may follow it", async () => {
  const file = plain(["let x = other", "while (flag) {", "  show(x.owner.name)", "  x = o", "}"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(frontiers(result), ["5 unmodelled-flow:assignment in a loop"]);
});
