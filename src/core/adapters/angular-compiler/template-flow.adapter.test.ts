import { test } from "node:test";
import assert from "node:assert/strict";
import { ELEMENT, formatAccessPath, type AccessPath } from "../../domain/contracts/access-path.ts";
import type { FlowResult } from "../../domain/contracts/consumer-flow.ts";
import type { MemberCarrier } from "../../ports/consumer-template.port.ts";
import type { ScopeMember, TemplateUnit } from "../../ports/template-usage.port.ts";
import { createTemplateFlowReader } from "./template-flow.adapter.ts";

const OWNER = { path: "src/app/order-view.ts", symbol: "OrderView", line: 4 };

const card = (symbol: string, selector: string): ScopeMember => ({ kind: "component", ref: { path: `src/app/${symbol.toLowerCase()}.ts`, symbol, line: 9 }, selector });
const directive = (symbol: string, selector: string): ScopeMember => ({ kind: "directive", ref: { path: `src/app/${symbol.toLowerCase()}.ts`, symbol, line: 9 }, selector });

function follow(text: string, path: AccessPath, options: { member?: string; scope?: ScopeMember[]; firstLine?: number } = {}): FlowResult {
  const unit: TemplateUnit = { component: OWNER, path: "src/app/order-view.html", text, firstLine: options.firstLine ?? 1, scope: options.scope ?? [] };
  const carrier: MemberCarrier = { site: { kind: "member", repo: "shop", file: OWNER.path, owner: OWNER.symbol, member: options.member ?? "order" }, path };
  return createTemplateFlowReader().follow(unit, carrier);
}

/** `<read path> | <changed> <operation> [<guard kind covers>...]@<line>` for each use. */
function uses(result: FlowResult): string[] {
  return result.uses.map((use) => {
    const guards = use.guards.map((guard) => `${guard.kind} ${formatAccessPath(guard.covers) || "."}`).join(", ");
    return `${formatAccessPath(use.path) || "."} | ${formatAccessPath(use.changed) || "."} ${use.operation} [${guards}]@${use.site.line}`;
  });
}

const frontiers = (result: FlowResult): string[] => result.frontiers.map((frontier) => `${frontier.cause}:${frontier.detail ?? ""}@${frontier.at.line}`);

test("a template that does not parse is a frontier at its first error, never an empty answer", () => {
  const result = follow("<p>ok</p>\n@if (order() {", ["owner"], { firstLine: 10 });

  assert.deepEqual(result.uses, []);
  assert.deepEqual(frontiers(result).map((item) => item.split(":")[0]), ["template-unreadable"]);
  assert.equal(result.frontiers[0]?.at.path, "src/app/order-view.html");
});

test("a read of the member through a signal call, a property or a resource value adds one segment per property and none for the call", () => {
  const result = follow("{{ order().owner.name }}\n{{ order.owner.name }}\n{{ order.value().owner.name }}", ["owner"]);
  const resource = follow("{{ order.value().owner.name }}", ["value", "owner"], { member: "order" });

  assert.deepEqual(uses(result), ["owner.name | owner dereference []@1", "owner.name | owner dereference []@2"]);
  assert.deepEqual(uses(resource), ["value.owner.name | value.owner dereference []@1"]);
});

test("the operation is a dereference beyond the changed value, a consume when the exact value is shown, piped, compared or bound to a native property, unmodelled when it is handed on", () => {
  const result = follow(
    '{{ order().owner.name }}\n{{ order().owner }}\n{{ order().owner | json }}\n@if (order().owner === other) { <p></p> }\n<img [title]="order().owner">\n<p (click)="select(order().owner)"></p>',
    ["owner"],
  );

  assert.deepEqual(uses(result), [
    "owner.name | owner dereference []@1",
    "owner | owner consume []@2",
    "owner | owner consume []@3",
    "owner | owner consume []@4",
    "owner | owner consume []@5",
    "owner | owner unmodelled []@6",
  ]);
});

test("a test of the changed value is no use, and a test of a longer path is the dereference it performs", () => {
  const result = follow("@if (order().owner) { <p></p> }\n@if (order().owner.name) { <p></p> }", ["owner"]);

  assert.deepEqual(uses(result), ["owner.name | owner dereference []@2"]);
});

test("a read that never touches the changed value is no use", () => {
  assert.deepEqual(uses(follow("{{ order().total }}\n{{ order().owner.name }}", ["address", "city"])), []);
});

test("?. guards the prefix before it: a chain that skips the changed segment is not covered", () => {
  const result = follow("{{ order().owner?.name }}\n{{ order()?.owner.name }}", ["owner"]);

  assert.deepEqual(uses(result), ["owner.name | owner dereference [optional-chain owner]@1", "owner.name | owner dereference [optional-chain .]@2"]);
});

test("! is recorded as a non-null assertion that covers the asserted value", () => {
  assert.deepEqual(uses(follow("{{ order().owner!.name }}", ["owner"])), ["owner.name | owner dereference [non-null-assertion owner]@1"]);
});

test("an @if test guards only the reads inside its block: the @else branch and the code after it carry no guard", () => {
  const result = follow("@if (order().owner) {\n{{ order().owner.name }}\n} @else {\n{{ order().owner.name }}\n}\n{{ order().owner.name }}", ["owner"]);

  assert.deepEqual(uses(result), ["owner.name | owner dereference [truthiness owner]@2", "owner.name | owner dereference []@4", "owner.name | owner dereference []@6"]);
});

test("*ngIf guards the element it sits on, and a test of a longer path guards the changed value too", () => {
  const result = follow('<p *ngIf="order().owner.name">{{ order().owner.name }}</p>\n<p *ngIf="order().owner">{{ order().owner.name }}</p>', ["owner"]);

  assert.deepEqual(uses(result), [
    "owner.name | owner dereference []@1",
    "owner.name | owner dereference [truthiness owner.name]@1",
    "owner.name | owner dereference [truthiness owner]@2",
  ]);
});

test("a comparison with null or undefined guards by the absences it rules out; && and ?: scope the guard to their right side and true branch", () => {
  const result = follow(
    "@if (order().owner !== null) { {{ order().owner.a }} }\n@if (order().owner !== undefined) { {{ order().owner.b }} }\n@if (null != order().owner) { {{ order().owner.c }} }\n{{ order().owner && order().owner.d }}\n{{ order().owner ? order().owner.e : order().owner.f }}\n@if (flag && order().owner) { {{ order().owner.g }} }",
    ["owner"],
  );

  assert.deepEqual(
    result.uses.map((use) => `${use.path.join(".")}:${use.guards.map((guard) => `${guard.kind}=${guard.excludes.join("+")}`).join(",")}`),
    ["owner.a:comparison=null", "owner.b:comparison=undefined", "owner.c:comparison=null+undefined", "owner.d:truthiness=null+undefined", "owner.e:truthiness=null+undefined", "owner.f:", "owner.g:truthiness=null+undefined"],
  );
});

test("a === test is not a guard", () => {
  assert.deepEqual(uses(follow("@if (order().owner === null) { {{ order().owner.name }} }", ["owner"])), ["owner.name | owner dereference []@1"]);
});

test("?? and || on the changed value are fallback guards on a consumed value, and the result is no longer followed", () => {
  const result = follow("{{ order().owner ?? fallback }}\n{{ (order().owner || fallback).name }}", ["owner"]);

  assert.deepEqual(uses(result), ["owner | owner consume [fallback owner]@1", "owner | owner consume [fallback owner]@2"]);
  assert.deepEqual(result.frontiers, []);
});

test("an alias of the member carries the value and its guard: @if (x; as y), *ngIf=\"x as y\" and @let", () => {
  const result = follow(
    "@if (order(); as o) { {{ o.owner.name }} }\n<p *ngIf=\"order() as p\">{{ p.owner.name }}</p>\n@let v = order().owner;\n{{ v.name }}",
    ["owner"],
  );

  assert.deepEqual(uses(result), ["owner.name | owner dereference [truthiness .]@1", "owner.name | owner dereference [truthiness .]@2", "name | . dereference []@4"]);
});

test("a read through an alias is reported in the alias coordinates with the rewrite on its hop", () => {
  const result = follow("@let v = order().owner;\n{{ v.name }}", ["owner"]);
  const [use] = result.uses;

  assert.deepEqual(use?.hops.map((hop) => ({ step: hop.step, line: hop.evidence.line, rewrite: hop.rewrite })), [
    { step: "template-read", line: 1, rewrite: [{ from: ["owner"], to: [] }] },
    { step: "template-read", line: 2, rewrite: undefined },
  ]);
});

test("@for and *ngFor items drop the leading [] of the changed path, and the iterate hop records it", () => {
  const result = follow('@for (item of orders(); track item) {\n{{ item.owner.name }}\n}\n<p *ngFor="let row of orders()">{{ row.owner.name }}</p>', [ELEMENT, "owner"], { member: "orders" });

  assert.deepEqual(uses(result), ["owner.name | owner dereference []@2", "owner.name | owner dereference []@4"]);
  assert.deepEqual(result.uses[0]?.hops.map((hop) => ({ step: hop.step, rewrite: hop.rewrite })), [
    { step: "iterate", rewrite: [{ from: [ELEMENT], to: [] }] },
    { step: "template-read", rewrite: undefined },
  ]);
});

test("an item is followed only when the changed path goes through the element, and a container the loop cannot unpack is a frontier", () => {
  const unrelated = follow("@for (item of orders(); track item.id) {\n{{ item.total }}\n}", [ELEMENT, "owner"], { member: "orders" });
  const mismatch = follow("@for (item of orders(); track item.id) {\n{{ item.owner.name }}\n}", ["owner"], { member: "orders" });

  assert.deepEqual(uses(unrelated), []);
  assert.deepEqual(frontiers(mismatch), ["unmodelled-flow:iterate@1"]);
});

test("an index key reads the element and a computed key loses the container", () => {
  const indexed = follow("{{ orders()[0].owner.name }}", [ELEMENT, "owner"], { member: "orders" });
  const computed = follow("{{ orders()[i].owner.name }}", [ELEMENT, "owner"], { member: "orders" });

  assert.deepEqual(uses(indexed), ["[].owner.name | [].owner dereference []@1"]);
  assert.deepEqual(frontiers(computed), ["dynamic-access:computed-key@1"]);
});

test("a name the template redeclares is not the member", () => {
  const result = follow("@for (order of orders(); track order) {\n{{ order.owner.name }}\n}", ["owner"], { member: "order" });

  assert.deepEqual(uses(result), []);
  assert.deepEqual(frontiers(result), []);
});

test("an async pipe hands the value on, any other pipe consumes it, and a tracked pipe argument is a frontier", () => {
  const result = follow("{{ (order | async)?.owner.name }}\n{{ order().owner | json }}\n{{ amount | money: order() }}", ["owner"]);

  assert.deepEqual(uses(result), ["owner.name | owner dereference [optional-chain .]@1", "owner | owner consume []@2"]);
  assert.deepEqual(frontiers(result), ["unmodelled-flow:pipe-argument:money@3"]);
});

test("the value bound to the input of a child component continues as a member carrier of the child with the path rewritten", () => {
  const result = follow('<app-owner-card [owner]="order().owner"></app-owner-card>', ["owner", "name"], { scope: [card("OwnerCard", "app-owner-card")] });
  const [next] = result.next;

  assert.equal(result.next.length, 1);
  assert.deepEqual(next?.carrier, { site: { kind: "member", repo: "shop", file: "src/app/ownercard.ts", owner: "OwnerCard", member: "owner" }, path: ["name"] });
  assert.deepEqual(next?.hops.map((hop) => ({ step: hop.step, line: hop.evidence.line, rewrite: hop.rewrite })), [{ step: "template-binding", line: 1, rewrite: [{ from: ["owner"], to: [] }] }]);
  assert.deepEqual(result.uses, []);
});

test("the whole member bound to a child input keeps the changed path, and a property inside the changed value bound to it is a read", () => {
  const whole = follow('<app-owner-card [data]="order()"></app-owner-card>', ["owner"], { scope: [card("OwnerCard", "app-owner-card")] });
  const inside = follow('<app-owner-card [name]="order().owner.name"></app-owner-card>', ["owner"], { scope: [card("OwnerCard", "app-owner-card")] });

  assert.deepEqual(whole.next[0]?.carrier.path, ["owner"]);
  assert.deepEqual(whole.next[0]?.hops[0]?.rewrite, undefined);
  assert.deepEqual(inside.next, []);
  assert.deepEqual(uses(inside), ["owner.name | owner dereference []@1"]);
});

test("a value bound to a child input under a guard that reaches the changed value is a frontier, because the child cannot be told it is present", () => {
  const result = follow('@if (order().owner) {\n<app-owner-card [owner]="order().owner"></app-owner-card>\n}', ["owner"], { scope: [card("OwnerCard", "app-owner-card")] });

  assert.deepEqual(result.next, []);
  assert.deepEqual(frontiers(result), ["unmodelled-flow:guarded-binding:owner@2"]);
});

test("an element two components match and a binding to a directive are frontiers", () => {
  const ambiguous = follow('<app-owner-card [owner]="order().owner"></app-owner-card>', ["owner"], { scope: [card("A", "app-owner-card"), card("B", "app-owner-card")] });
  const bound = follow('<p appHint [hint]="order().owner"></p>', ["owner"], { scope: [directive("Hint", "[appHint]")] });

  assert.deepEqual(frontiers(ambiguous), ["unsupported-binding:ambiguous-component:owner@1"]);
  assert.deepEqual(frontiers(bound), ["unsupported-binding:directive:Hint:hint@1"]);
  assert.deepEqual([...ambiguous.next, ...bound.next], []);
});

test("the value that contains the changed property handed to a method, $any or another call is a frontier; the changed value itself is an unmodelled use", () => {
  const result = follow('<p (click)="select(order())"></p>\n<p [title]="$any(order())"></p>\n{{ format(order()) }}\n{{ helper.show(order()) }}', ["owner"]);
  const exact = follow('<p (click)="select(order().owner)"></p>', ["owner"]);

  assert.deepEqual(frontiers(result), ["unmodelled-flow:template-call:select@1", "unmodelled-flow:$any@2", "unmodelled-flow:template-call:format@3", "unmodelled-flow:call:show@4"]);
  assert.deepEqual(uses(exact), ["owner | owner unmodelled []@1"]);
});

test("a method called on the changed value dereferences it, and one called on its container is a frontier", () => {
  const result = follow("{{ order().owner.label(1) }}\n{{ order().tags.join(',') }}", ["owner"]);
  const container = follow("{{ order().tags.join(',') }}", ["tags", ELEMENT, "text"]);

  assert.deepEqual(uses(result), ["owner | owner dereference []@1"]);
  assert.deepEqual(frontiers(container), ["unmodelled-flow:call:join@1"]);
});

test("uses, next carriers and frontiers come in source order with lines relative to the line the text starts on", () => {
  const text = '<p (click)="select(order())">{{ order().owner.name }}</p>\n<app-owner-card [owner]="order().owner" [other]="order().owner"></app-owner-card>\n<p (click)="show(order().owner)"\n[title]="order().owner"></p>\n{{ order().owner.id }}';
  const scope = [card("OwnerCard", "app-owner-card")];
  const first = follow(text, ["owner"], { scope, firstLine: 20 });

  assert.deepEqual(uses(first), ["owner.name | owner dereference []@20", "owner | owner unmodelled []@22", "owner | owner consume []@23", "owner.id | owner dereference []@24"]);
  assert.deepEqual(frontiers(first), ["unmodelled-flow:template-call:select@20"]);
  assert.deepEqual(first.next.map((next) => next.carrier.site.kind === "member" && next.carrier.site.member), ["owner", "other"]);
  assert.deepEqual(follow(text, ["owner"], { scope, firstLine: 20 }), first);
});

test("a guard established outside an alias is converted to the alias coordinates and one that stops short of it is dropped", () => {
  const result = follow("@if (order().owner) {\n@let v = order().owner;\n{{ v.name }}\n}\n@if (order()) {\n@let w = order().owner;\n{{ w.name }}\n}", ["owner"]);

  assert.deepEqual(uses(result), ["name | . dereference [truthiness .]@3", "name | . dereference []@7"]);
});

test("a condition is read once: testing a call that loses the container reports one frontier", () => {
  const result = follow("@if (order().tags.join(',')) { <p></p> }", ["tags", ELEMENT, "text"]);

  assert.deepEqual(frontiers(result), ["unmodelled-flow:call:join@1"]);
  assert.deepEqual(uses(follow("@if (order().owner.label(1)) { <p></p> }", ["owner"])), ["owner | owner dereference []@1"]);
});
