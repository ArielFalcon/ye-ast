import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAccessPath, parseAccessPath } from "../../domain/contracts/access-path.ts";
import type { Carrier, CarrierSite, FlowResult } from "../../domain/contracts/consumer-flow.ts";
import { operationClass, type Predicate } from "../../domain/contracts/use-operation.ts";
import type { Guard } from "../../domain/contracts/verdict.ts";
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
const uses = (result: FlowResult) => result.uses.map((use) => `${use.site.line - HEADER_LINES} ${dotted(use.path)}|${dotted(use.changed)} ${operationClass(use.operation)} [${use.guards.map((guard) => guard.kind).join(",")}]`);
const predicateText = (test: Predicate) =>
  test.kind === "truthy" ? "truthy" : test.kind === "absence" ? `${test.operator} ${test.absence}` : test.kind === "literal" ? `${test.operator} ${JSON.stringify(test.literal)}` : test.kind === "typeof" ? `typeof ${test.operator} ${test.type}` : test.kind === "one-of" ? `one-of ${[...test.literals.map((literal) => JSON.stringify(literal)), ...test.absences].join("|")}` : "array";
const guardText = (guard: Guard) =>
  "test" in guard ? `${guard.kind} ${predicateText(guard.test)} ${guard.holds}${guard.kind === "fallback" ? ` -> ${guard.replacement.kind === "opaque" ? "opaque" : JSON.stringify(guard.replacement.value)}` : ""}` : guard.kind;
const guardsOf = (result: FlowResult) => result.uses.filter((use) => use.path.length > 0).map((use) => use.guards.map(guardText));
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
    "3 owner.name|owner dereference [optional-chain]",
    "4 owner.name|owner dereference [condition]",
    "5 owner.name|owner dereference [condition]",
    "6 owner.name|owner dereference [condition]",
    "7 owner.name|owner dereference [condition]",
    "8 owner.name|owner dereference [condition]",
    "9 owner.name|owner dereference [non-null-assertion]",
    "10 owner.name|owner dereference []",
  ]);
  assert.deepEqual(guardsOf(result).slice(0, 3), [["optional-chain != null true"], ["condition truthy true"], ["condition != null true"]]);
});

test("an early return or throw on the negation guards the rest of the block", async () => {
  const file = guarded(["if (!order.owner) return", "show(order.owner.name)"]);
  const result = await follow([file], parameterOrder, "owner");
  assert.deepEqual(uses(result), ["4 owner.name|owner dereference [early-exit]"]);
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
  assert.deepEqual(uses(result), ["3 owner.name|owner dereference []", "4 owner.name|owner dereference [condition]"]);
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
  assert.deepEqual(uses(result), ["4 owner.name|owner dereference [type-guard]", "5 owner.name|owner dereference [instanceof]"]);
});

test("a fallback on the changed value guards what it flows to; a destructuring default covers undefined only", async () => {
  const file = guarded(["const owner = order.owner ?? {}", "show(owner.name)", "const { owner: second = {} } = order", "show(second.name)"]);
  const result = await follow([file], parameterOrder, "owner");
  assert.deepEqual(guardsOf(result), [["fallback != null true -> {}"], ["fallback !== undefined true -> {}"]]);
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

test("a call that only reports a resource's state is no loss of its value; a call that may read the value still is", async () => {
  const file = plain(["o.isLoading()", "o.error()", "o.hasValue()", "o.reload()", "o.update((v) => v)"]);
  const result = await follow([file], paramO, "value.owner");
  assert.deepEqual(frontiers(result), ["6 unmodelled-flow:method:update"]);
});

test("a guard inside a closure decides its reads even when another guard sits outside it", async () => {
  const file = plain(["if (o.owner) {", "  const f = () => { if (o.owner) show(o.owner.name) }", "  f()", "}"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(uses(result), ["3 owner.name|owner dereference [condition]"]);
  assert.deepEqual(frontiers(result), []);
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

test("a var declared in a block is the whole function's binding, so its reads there are not the followed value", async () => {
  const file = plain(["const run = () => {", "  if (o) { var o = other }", "  show(o.owner.name)", "}", "show(o.owner.id)"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(uses(result), ["6 owner.id|owner dereference []"]);
});

test("an assignment binds the declaration its case block shares, never an outer one of the same name", async () => {
  const file = plain(["let x = o", "switch (k) {", "  case 1: let x = 0; break", "  case 2: x = o.owner", "}", "show(x.owner.id)"]);
  const result = await follow([file], paramO, "owner");
  assert.deepEqual(uses(result), ["7 owner.id|owner dereference []"]);
});

test("a var declared in a block holds the followed value past the block", async () => {
  const result = await follow([plain(["if (c) { var x = o }", "show(x.owner.id)"])], paramO, "owner");
  assert.deepEqual(uses(result), ["3 owner.id|owner dereference []"]);
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

test("input binding is router-wide: proven when every root router turns it on, through a feature argument, a spread of features or forRoot's option", async () => {
  const unused = ROUTES("import { provideRouter, withComponentInputBinding } from '@angular/router'\nconst unused = withComponentInputBinding()\nexport const config = [provideRouter(routes)]");
  const refused = await follow(unused, resolverReturn, "owner");
  assert.deepEqual(next(refused), []);
  assert.equal(refused.frontiers[0]!.cause, "unsupported-binding");
  const spread = ROUTES("import { provideRouter, withComponentInputBinding } from '@angular/router'\nconst features = [withComponentInputBinding()]\nexport const config = [provideRouter(lazyRoot, ...features)]");
  assert.deepEqual(next(await follow(spread, resolverReturn, "owner")), ["input order@- owner"]);
  const module = ROUTES("import { RouterModule } from '@angular/router'\nexport const config = [RouterModule.forRoot(lazyRoot, { bindToComponentInputs: true })]");
  assert.deepEqual(next(await follow(module, resolverReturn, "owner")), ["input order@- owner"]);
  const mixed = ROUTES("import { provideRouter, withComponentInputBinding } from '@angular/router'\nexport const config = [provideRouter(routes, withComponentInputBinding())]\nexport const other = [provideRouter(lazyRoot)]");
  assert.deepEqual(next(await follow(mixed, resolverReturn, "owner")), []);
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
