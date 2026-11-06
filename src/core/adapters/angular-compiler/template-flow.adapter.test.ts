import { test } from "node:test";
import assert from "node:assert/strict";
import { ELEMENT, formatAccessPath, type AccessPath } from "../../domain/contracts/access-path.ts";
import type { Predicate } from "../../domain/contracts/use-operation.ts";
import type { Guard } from "../../domain/contracts/verdict.ts";
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

/** `<read path> | <changed> [<guard kind covers>...]@<line>` for each use. */
function uses(result: FlowResult): string[] {
  return result.uses.map((use) => {
    const guards = use.guards.map((guard) => `${guard.kind} ${formatAccessPath(guard.covers) || "."}`).join(", ");
    return `${formatAccessPath(use.path) || "."} | ${formatAccessPath(use.changed) || "."} [${guards}]@${use.site.line}`;
  });
}

function predicateText(test: Predicate): string {
  switch (test.kind) {
    case "truthy":
      return "truthy";
    case "absence":
      return `${test.operator} ${test.absence}`;
    case "literal":
      return `${test.operator} ${JSON.stringify(test.literal)}`;
    case "typeof":
      return `typeof ${test.operator} ${test.type}`;
    case "array":
      return "array";
    case "one-of":
      return `one-of ${JSON.stringify([...test.literals, ...test.absences])}`;
  }
}

/** `kind(<test> <holds> [-> <replacement>])`: a guard as the domain reads it, without its position. */
function guardText(guard: Guard): string {
  if (!("test" in guard)) return guard.kind;
  const replacement = guard.kind === "fallback" ? ` -> ${JSON.stringify(guard.replacement)}` : "";
  return `${guard.kind}(${predicateText(guard.test)} ${guard.holds}${replacement})`;
}

/** `<read path>: <guard>, ...` for each use. */
const guardsByUse = (result: FlowResult): string[] => result.uses.map((use) => `${use.path.join(".")}: ${use.guards.map(guardText).join(", ")}`);

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

  assert.deepEqual(uses(result), ["owner.name | owner []@1", "owner.name | owner []@2"]);
  assert.deepEqual(uses(resource), ["value.owner.name | value.owner []@1"]);
});

test("a test of the changed value is no use, and a test of a longer path is the dereference it performs", () => {
  const result = follow("@if (order().owner) { <p></p> }\n@if (order().owner.name) { <p></p> }", ["owner"]);

  assert.deepEqual(uses(result), ["owner.name | owner []@2"]);
});

test("a read that never touches the changed value is no use", () => {
  assert.deepEqual(uses(follow("{{ order().total }}\n{{ order().owner.name }}", ["address", "city"])), []);
});

test("?. guards the prefix before it: a chain that skips the changed segment is not covered", () => {
  const result = follow("{{ order().owner?.name }}\n{{ order()?.owner.name }}", ["owner"]);

  assert.deepEqual(uses(result), ["owner.name | owner [optional-chain owner]@1", "owner.name | owner [optional-chain .]@2"]);
});

test("! is recorded as a non-null assertion that covers the asserted value", () => {
  assert.deepEqual(uses(follow("{{ order().owner!.name }}", ["owner"])), ["owner.name | owner [non-null-assertion owner]@1"]);
});

test("an @if test guards the reads inside its block, its @else branch carries the test rejected, and the code after it carries no guard", () => {
  const result = follow("@if (order().owner) {\n{{ order().owner.name }}\n} @else {\n{{ order().owner.name }}\n}\n{{ order().owner.name }}", ["owner"]);

  assert.deepEqual(uses(result), ["owner.name | owner [condition owner]@2", "owner.name | owner [condition owner]@4", "owner.name | owner []@6"]);
});

test("*ngIf guards the element it sits on, and a test of a longer path guards the changed value too", () => {
  const result = follow('<p *ngIf="order().owner.name">{{ order().owner.name }}</p>\n<p *ngIf="order().owner">{{ order().owner.name }}</p>', ["owner"]);

  assert.deepEqual(uses(result), [
    "owner.name | owner []@1",
    "owner.name | owner [condition owner.name]@1",
    "owner.name | owner [condition owner]@2",
  ]);
});

test("a condition states the truthiness of a tracked path, with the polarity of the branch: ! and the @else and ?: false sides flip it", () => {
  const result = follow(
    "@if (order().owner) { {{ order().owner.a }} } @else { {{ order().owner.b }} }\n@if (!order().owner) { {{ order().owner.c }} }\n@if (!!order().owner) { {{ order().owner.d }} }\n{{ order().owner ? order().owner.e : order().owner.f }}\n{{ order().owner && order().owner.g }}\n@if (flag && order().owner) { {{ order().owner.h }} }",
    ["owner"],
  );

  assert.deepEqual(guardsByUse(result), [
    "owner.a: condition(truthy true)",
    "owner.b: condition(truthy false)",
    "owner.c: condition(truthy false)",
    "owner.d: condition(truthy true)",
    "owner.e: condition(truthy true)",
    "owner.f: condition(truthy false)",
    "owner.g: condition(truthy true)",
    "owner.h: condition(truthy true)",
  ]);
});

test("an equality with null or undefined states the exact operator and absence, in either order and either polarity", () => {
  const result = follow(
    "@if (order().owner !== null) { {{ order().owner.a }} }\n@if (order().owner !== undefined) { {{ order().owner.b }} }\n@if (null != order().owner) { {{ order().owner.c }} }\n@if (order().owner === null) { } @else { {{ order().owner.d }} }\n@if (order().owner == undefined) { {{ order().owner.e }} }\n@if (!(order().owner === null)) { {{ order().owner.f }} }",
    ["owner"],
  );

  assert.deepEqual(guardsByUse(result), [
    "owner.a: condition(!== null true)",
    "owner.b: condition(!== undefined true)",
    "owner.c: condition(!= null true)",
    "owner.d: condition(=== null false)",
    "owner.e: condition(== undefined true)",
    "owner.f: condition(=== null false)",
  ]);
});

test("an equality with a literal the template writes states the operator and the literal, in either order and either polarity", () => {
  const result = follow(
    "@if (order().owner === 'a') { {{ order().owner.a }} }\n@if (3 != order().owner) { {{ order().owner.b }} }\n@if (order().owner === -1) { } @else { {{ order().owner.c }} }\n@if (order().owner == true) { {{ order().owner.d }} }\n@if (order().owner === other) { {{ order().owner.e }} }",
    ["owner"],
  );

  assert.deepEqual(guardsByUse({ ...result, uses: result.uses.filter((use) => use.path.length > 1) }), [
    'owner.a: condition(=== "a" true)',
    "owner.b: condition(!= 3 true)",
    "owner.c: condition(=== -1 false)",
    "owner.d: condition(== true true)",
    "owner.e: ",
  ]);
});

test("typeof of a tracked path compared with a name states the operator and the name, in either order", () => {
  const result = follow(
    "@if (typeof order().owner === 'string') { {{ order().owner.a }} }\n@if ('object' !== typeof order().owner) { {{ order().owner.b }} }\n@if (typeof order().owner === other) { {{ order().owner.c }} }",
    ["owner"],
  );

  assert.deepEqual(guardsByUse(result), ["owner.a: condition(typeof === string true)", "owner.b: condition(typeof !== object true)", "owner.c: "]);
});

test("@else if carries every test rejected before it, and a test that only one side of && or || decides rejects nothing", () => {
  const result = follow(
    "@if (order().owner === null) { } @else if (flag) { {{ order().owner.a }} } @else { {{ order().owner.b }} }\n@if (order().owner && flag) { } @else { {{ order().owner.c }} }\n@if (!order().owner || flag) { {{ order().owner.d }} } @else { {{ order().owner.e }} }",
    ["owner"],
  );

  assert.deepEqual(guardsByUse(result), [
    "owner.a: condition(=== null false)",
    "owner.b: condition(=== null false)",
    "owner.c: ",
    "owner.d: ",
    "owner.e: condition(truthy true)",
  ]);
});

test("?. on a member, a keyed read or a call tests that the value is not null, and the value passes the guards in the order the code writes them", () => {
  const result = follow("{{ order()?.owner?.name }}\n{{ order().owner?.['name'] }}\n{{ order().owner?.() }}\n@if (order().owner) { {{ order().owner.a }} }", ["owner"]);
  const nested = follow("@if (order().owner) { {{ order()?.owner?.name }} }", ["owner"]);

  assert.deepEqual(guardsByUse(result), [
    "owner.name: optional-chain(!= null true), optional-chain(!= null true)",
    "owner.name: optional-chain(!= null true)",
    "owner: optional-chain(!= null true)",
    "owner.a: condition(truthy true)",
  ]);
  assert.deepEqual(guardsByUse(nested), ["owner.name: condition(truthy true), optional-chain(!= null true), optional-chain(!= null true)"]);
});

test("?? and || on the changed value are fallback guards on a consumed value, and the result is no longer followed", () => {
  const result = follow("{{ order().owner ?? fallback }}\n{{ (order().owner || fallback).name }}", ["owner"]);

  assert.deepEqual(uses(result), ["owner | owner [fallback owner]@1", "owner | owner [fallback owner]@2"]);
  assert.deepEqual(result.frontiers, []);
});

test("a fallback states what it tests (?? absence, || truthiness) and the JSON value its right side writes, anything else opaque", () => {
  const result = follow(
    [
      '<p [title]="order().owner ?? null"></p>',
      "<p [title]=\"order().owner || 'none'\"></p>",
      '<p [title]="order().owner ?? -1.5"></p>',
      '<p [title]="order().owner ?? false"></p>',
      "<p [title]=\"order().owner ?? [1, 'a', [null]]\"></p>",
      "<p [title]=\"order().owner ?? {a: 1, 'b': {c: [true]}}\"></p>",
      '<p [title]="order().owner ?? fallback"></p>',
      '<p [title]="order().owner ?? [fallback]"></p>',
      '<p [title]="order().owner ?? {a: fallback}"></p>',
      '<p [title]="order().owner ?? {...fallback}"></p>',
      '<p [title]="order().owner ?? {...{a: 1}}"></p>',
      '<p [title]="order().owner ?? undefined"></p>',
      '<p [title]="order().owner ?? helper()"></p>',
    ].join("\n"),
    ["owner"],
  );
  const opaque = 'fallback(!= null true -> {"kind":"opaque"})';

  assert.deepEqual(
    result.uses.map((use) => use.guards.map(guardText)),
    [
      ['fallback(!= null true -> {"kind":"literal","value":null})'],
      ['fallback(truthy true -> {"kind":"literal","value":"none"})'],
      ['fallback(!= null true -> {"kind":"literal","value":-1.5})'],
      ['fallback(!= null true -> {"kind":"literal","value":false})'],
      ['fallback(!= null true -> {"kind":"literal","value":[1,"a",[null]]})'],
      ['fallback(!= null true -> {"kind":"literal","value":{"a":1,"b":{"c":[true]}}})'],
      [opaque],
      [opaque],
      [opaque],
      [opaque],
      [opaque],
      [opaque],
      [opaque],
    ],
  );
});

test("a fallback comes after the conditions around it and the chain guards before it", () => {
  const result = follow("@if (order().owner) { {{ order()?.owner ?? 0 }} }", ["owner"]);

  assert.deepEqual(guardsByUse(result), ['owner: condition(truthy true), optional-chain(!= null true), fallback(!= null true -> {"kind":"literal","value":0})']);
});

test("an alias of the member carries the value and its guard: @if (x; as y), *ngIf=\"x as y\" and @let", () => {
  const result = follow(
    "@if (order(); as o) { {{ o.owner.name }} }\n<p *ngIf=\"order() as p\">{{ p.owner.name }}</p>\n@let v = order().owner;\n{{ v.name }}",
    ["owner"],
  );

  assert.deepEqual(uses(result), ["owner.name | owner [condition .]@1", "owner.name | owner [condition .]@2", "name | . []@4"]);
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

  assert.deepEqual(uses(result), ["owner.name | owner []@2", "owner.name | owner []@4"]);
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

  assert.deepEqual(uses(indexed), ["[].owner.name | [].owner []@1"]);
  assert.deepEqual(frontiers(computed), ["dynamic-access:computed-key@1"]);
});

test("a name the template redeclares is not the member", () => {
  const result = follow("@for (order of orders(); track order) {\n{{ order.owner.name }}\n}", ["owner"], { member: "order" });

  assert.deepEqual(uses(result), []);
  assert.deepEqual(frontiers(result), []);
});

test("an async pipe hands the value on, any other pipe consumes it, and a tracked pipe argument is a frontier", () => {
  const result = follow("{{ (order | async)?.owner.name }}\n{{ order().owner | json }}\n{{ amount | money: order() }}", ["owner"]);

  assert.deepEqual(uses(result), ["owner.name | owner [optional-chain .]@1", "owner | owner []@2"]);
  assert.deepEqual(frontiers(result), ["unmodelled-flow:pipe-argument:money@3"]);
});

test("the value bound to the input of a child component continues as a member carrier of the child with the path rewritten", () => {
  const result = follow('<app-owner-card [owner]="order().owner"></app-owner-card>', ["owner", "name"], { scope: [card("OwnerCard", "app-owner-card")] });
  const [next] = result.next;

  assert.equal(result.next.length, 1);
  assert.deepEqual(next?.carrier, { site: { kind: "input", repo: "shop", file: "src/app/ownercard.ts", owner: "OwnerCard", name: "owner" }, path: ["name"] });
  assert.deepEqual(next?.hops.map((hop) => ({ step: hop.step, line: hop.evidence.line, rewrite: hop.rewrite })), [{ step: "template-binding", line: 1, rewrite: [{ from: ["owner"], to: [] }] }]);
  assert.deepEqual(result.uses, []);
});

test("the whole member bound to a child input keeps the changed path, and a property inside the changed value bound to it is a read", () => {
  const whole = follow('<app-owner-card [data]="order()"></app-owner-card>', ["owner"], { scope: [card("OwnerCard", "app-owner-card")] });
  const inside = follow('<app-owner-card [name]="order().owner.name"></app-owner-card>', ["owner"], { scope: [card("OwnerCard", "app-owner-card")] });

  assert.deepEqual(whole.next[0]?.carrier.path, ["owner"]);
  assert.deepEqual(whole.next[0]?.hops[0]?.rewrite, undefined);
  assert.deepEqual(inside.next, []);
  assert.deepEqual(uses(inside), ["owner.name | owner []@1"]);
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
  assert.deepEqual(uses(exact), ["owner | owner []@1"]);
});

test("a method called on the changed value dereferences it, and one called on its container is a frontier", () => {
  const result = follow("{{ order().owner.label(1) }}\n{{ order().tags.join(',') }}", ["owner"]);
  const container = follow("{{ order().tags.join(',') }}", ["tags", ELEMENT, "text"]);

  assert.deepEqual(uses(result), ["owner | owner []@1"]);
  assert.deepEqual(frontiers(container), ["unmodelled-flow:call:join@1"]);
});

test("uses, next carriers and frontiers come in source order with lines relative to the line the text starts on", () => {
  const text = '<p (click)="select(order())">{{ order().owner.name }}</p>\n<app-owner-card [owner]="order().owner" [other]="order().owner"></app-owner-card>\n<p (click)="show(order().owner)"\n[title]="order().owner"></p>\n{{ order().owner.id }}';
  const scope = [card("OwnerCard", "app-owner-card")];
  const first = follow(text, ["owner"], { scope, firstLine: 20 });

  assert.deepEqual(uses(first), ["owner.name | owner []@20", "owner | owner []@22", "owner | owner []@23", "owner.id | owner []@24"]);
  assert.deepEqual(frontiers(first), ["unmodelled-flow:template-call:select@20"]);
  assert.deepEqual(first.next.map((next) => next.carrier.site.kind === "input" && next.carrier.site.name), ["owner", "other"]);
  assert.deepEqual(follow(text, ["owner"], { scope, firstLine: 20 }), first);
});

test("a guard established outside an alias is converted to the alias coordinates and one that stops short of it is dropped", () => {
  const result = follow("@if (order().owner) {\n@let v = order().owner;\n{{ v.name }}\n}\n@if (order()) {\n@let w = order().owner;\n{{ w.name }}\n}", ["owner"]);

  assert.deepEqual(uses(result), ["name | . [condition .]@3", "name | . []@7"]);
});

test("a condition is read once: testing a call that loses the container reports one frontier", () => {
  const result = follow("@if (order().tags.join(',')) { <p></p> }", ["tags", ELEMENT, "text"]);

  assert.deepEqual(frontiers(result), ["unmodelled-flow:call:join@1"]);
  assert.deepEqual(uses(follow("@if (order().owner.label(1)) { <p></p> }", ["owner"])), ["owner | owner []@1"]);
});

test("a guard on one array element protects only reads of the same literal index, never another element or the items of a loop", () => {
  const result = follow(
    "@if (order.items[0].owner) {\n{{ order.items[1].owner.name }}\n{{ order.items[0].owner.name }}\n@for (item of order.items; track item) {\n{{ item.owner.name }}\n}\n}",
    ["items", ELEMENT, "owner"],
  );

  assert.deepEqual(uses(result), [
    "items[].owner.name | items[].owner []@2",
    "items[].owner.name | items[].owner [condition items[].owner]@3",
    "owner.name | owner []@5",
  ]);
});

test("a guard on a loop item protects reads of that item and not those of another loop", () => {
  const result = follow(
    "@for (a of order.items; track a) {\n@if (a.owner) {\n{{ a.owner.name }}\n@for (b of order.items; track b) {\n{{ b.owner.name }}\n}\n}\n}",
    ["items", ELEMENT, "owner"],
  );

  assert.deepEqual(uses(result), ["owner.name | owner [condition owner]@3", "owner.name | owner []@5"]);
});

test("the value bound to a child input is carried by its public name for the reader to resolve, and a binding to a directive stays a frontier", () => {
  const result = follow('<app-owner-card [publicOrder]="order"></app-owner-card>', ["owner"], { scope: [card("OwnerCard", "app-owner-card")] });

  assert.deepEqual(result.next[0]?.carrier, { site: { kind: "input", repo: "shop", file: "src/app/ownercard.ts", owner: "OwnerCard", name: "publicOrder" }, path: ["owner"] });
  assert.equal(result.next[0]?.hops[0]?.step, "template-binding");
});

test("a fallback or a let that carries a container of the changed value goes on to its destination", () => {
  const aliased = follow("@let x = order ?? other;\n{{ x.owner.name }}", ["owner"]);
  const nested = follow("{{ (order || other).owner.name }}", ["owner"]);
  const bound = follow('<app-owner-card [data]="order ?? other"></app-owner-card>', ["owner"], { scope: [card("OwnerCard", "app-owner-card")] });

  assert.deepEqual(uses(aliased), ["owner.name | owner []@2"]);
  assert.deepEqual(uses(nested), ["owner.name | owner []@1"]);
  assert.deepEqual(bound.next.map((next) => next.carrier.path), [["owner"]]);
});

test("a pipe other than async that transforms a container of the changed value is a frontier, and a container shown as it is has no use", () => {
  const result = follow("{{ (order | custom).owner.name }}\n{{ order | custom }}\n{{ order }}", ["owner"]);

  assert.deepEqual(uses(result), []);
  assert.deepEqual(frontiers(result), ["unmodelled-flow:pipe:custom@1", "unmodelled-flow:pipe:custom@2"]);
});

test("a call without arguments reads a signal only on the member, an alias or the value of a resource; any other call is a method", () => {
  const container = follow("{{ order().items.slice() }}", ["items", ELEMENT, "name"]);
  const own = follow("{{ order().owner() }}\n{{ order.owner() }}", ["owner"]);
  const alias = follow("@let v = order();\n{{ v().owner.name }}", ["owner"]);

  assert.deepEqual(uses(container), []);
  assert.deepEqual(frontiers(container), ["unmodelled-flow:method:slice@1"]);
  assert.deepEqual(uses(own), ["owner | owner []@1", "owner | owner []@2"]);
  assert.deepEqual(uses(alias), ["owner.name | owner []@2"]);
});

test("a call that only reports a resource's state is no loss of its value; a call that may read the value still is", () => {
  const result = follow("@if (order.isLoading()) {}\n{{ order.error() }}\n@if (order.hasValue()) {}\n{{ order.update(fn) }}", ["value", "owner"]);

  assert.deepEqual(frontiers(result), ["unmodelled-flow:call:update@4"]);
});

test("a loop over the exact changed collection is a consume of it, and the items stay followed for a change below the element", () => {
  const exact = follow("@for (item of order().items; track item) {\n<p></p>\n}\n<p *ngFor=\"let row of order().items\"></p>", ["items"]);
  const below = follow("@for (item of order().items; track item) {\n{{ item.name.length }}\n}", ["items", ELEMENT, "name"]);

  assert.deepEqual(uses(exact), ["items | items []@1", "items | items []@4"]);
  assert.deepEqual(uses(below), ["name.length | name []@2"]);
});

test("each construct states what it does with the changed value: the accesses past it and how the template ends with it", () => {
  const member = (name: string, optional = false) => ({ kind: "member", name, optional });
  const none = { kind: "none" };
  const shown = { kind: "consume", as: "shown" };
  const iterate = { kind: "iterate", tolerates: ["null", "undefined"] };
  const table: [string, unknown][] = [
    ["{{ order().address?.city.toUpperCase() }}", { steps: [member("city", true), member("toUpperCase"), { kind: "call", optional: false }], end: none }],
    ["{{ order().address['city'] }}", { steps: [{ kind: "keyed", key: "city", optional: false }], end: none }],
    ["{{ order().address?.[0] }}", { steps: [{ kind: "keyed", key: 0, optional: true }], end: none }],
    ["{{ order().address[key] }}", { steps: [{ kind: "keyed", optional: false }], end: none }],
    ["@for (a of order().address; track a) {}", { steps: [], end: iterate }],
    ['<p *ngFor="let a of order().address"></p>', { steps: [], end: iterate }],
    ["{{ order().address }}", { steps: [], end: shown }],
    ['<p title="a {{ order().address }}"></p>', { steps: [], end: shown }],
    ["{{ order().address | json }}", { steps: [], end: { kind: "consume", as: "handed-on", detail: "pipe:json" } }],
    ["{{ helper.show(order().address) }}", { steps: [], end: { kind: "unmodelled", detail: "call:show" } }],
    ["@if (order().address === 'A') {}", { steps: [], end: { kind: "compare", operator: "===", literal: "A" } }],
    ["@if (order().address === -1) {}", { steps: [], end: { kind: "compare", operator: "===", literal: -1 } }],
    ["@if (3 > order().address) {}", { steps: [], end: { kind: "compare", operator: ">", literal: 3 } }],
    ["@if (order().address < other) {}", { steps: [], end: { kind: "compare", operator: "<" } }],
    ["{{ order().address + 1 }}", { steps: [], end: { kind: "coerce", operator: "+" } }],
    ["{{ -order().address }}", { steps: [], end: { kind: "coerce", operator: "-" } }],
    ["{{ 'k' in order().address }}", { steps: [], end: { kind: "unmodelled", detail: "in" } }],
    ["{{ other instanceof order().address }}", { steps: [], end: { kind: "unmodelled", detail: "instanceof" } }],
    ["{{ order().address in other }}", { steps: [], end: { kind: "coerce", operator: "in" } }],
    ["{{ order().address instanceof other }}", { steps: [], end: { kind: "coerce", operator: "instanceof" } }],
    ['<img [title]="order().address">', { steps: [], end: { kind: "consume", as: "handed-on" } }],
    ["@switch (order().address) { @case ('A') { } }", { steps: [], end: { kind: "compare", operator: "===" } }],
  ];

  for (const [template, expected] of table) assert.deepEqual(follow(template, ["address"]).uses.map((use) => use.operation), [expected], template);
});

test("a read below the changed value ends in what the template does with the value it reaches, as the changed value itself would", () => {
  const read = (...names: string[]) => names.map((name) => ({ kind: "member", name, optional: false }));
  const none = { kind: "none" };
  const table: [string, unknown][] = [
    ["{{ 'k' in order().address.tags }}", { steps: read("tags"), end: { kind: "unmodelled", detail: "in" } }],
    ["{{ other instanceof order().address.tags }}", { steps: read("tags"), end: { kind: "unmodelled", detail: "instanceof" } }],
    ["{{ -order().address.zip.n }}", { steps: read("zip", "n"), end: { kind: "coerce", operator: "-" } }],
    ["{{ order().address.n + 1 }}", { steps: read("n"), end: { kind: "coerce", operator: "+" } }],
    ["@if (order().address.n == 1) {}", { steps: read("n"), end: { kind: "compare", operator: "==", literal: 1 } }],
    ["@for (a of order().address.tags; track a) {}", { steps: read("tags"), end: { kind: "iterate", tolerates: ["null", "undefined"] } }],
    ["{{ order().address.n }}", { steps: read("n"), end: none }],
    ["{{ order().address.n | json }}", { steps: read("n"), end: none }],
    ["{{ (order().address.n ?? 0) + 1 }}", { steps: read("n"), end: none }],
    ["{{ helper.show(order().address.n) }}", { steps: read("n"), end: none }],
    ["@if (order().address.n === null) {}", { steps: read("n"), end: none }],
  ];

  for (const [template, expected] of table) assert.deepEqual(follow(template, ["address"]).uses.map((use) => use.operation), [expected], template);
});

test("an assignment target on the changed value replaces it without reading it, and one beyond it is still a dereference", () => {
  const exact = follow('<p (click)="order.address = value"></p>', ["address"]);
  const beyond = follow('<p (click)="order.address.city = value"></p>', ["address"]);

  assert.deepEqual(uses(exact), []);
  assert.deepEqual(beyond.uses.map((use) => use.operation), [{ steps: [{ kind: "member", name: "city", optional: false }], end: { kind: "none" } }]);
});

test("a use inside a @case is guarded by the equality of the switched value with the labels of its case, and inside @default by every label rejecting it", () => {
  const result = follow(
    "@switch (order().kind) {\n@case ('A') { {{ order().kind }} }\n@case (-1) @case (null) { {{ order().kind }} }\n@default { {{ order().kind }} }\n}",
    ["kind"],
  );

  assert.deepEqual(guardsByUse(result), [
    "kind: ",
    'kind: condition(one-of [\"A\"] true)',
    'kind: condition(one-of [-1,\"null\"] true)',
    'kind: condition(one-of [\"A\",-1,\"null\"] false)',
  ]);
});

test("a @case label that is not a literal states an untested case guard, in a case and in the default", () => {
  const result = follow("@switch (order().kind) {\n@case ('A') { {{ order().kind }} }\n@case (other) { {{ order().kind }} }\n@default { {{ order().kind }} }\n}", ["kind"]);

  assert.deepEqual(guardsByUse(result), ["kind: ", 'kind: condition(one-of [\"A\"] true)', "kind: case", "kind: case"]);
});

test("a use after the @switch block is not guarded by its cases", () => {
  const result = follow("@switch (order().kind) { @case ('A') { } }\n{{ order().kind }}", ["kind"]);

  assert.deepEqual(guardsByUse(result).at(-1), "kind: ");
});
