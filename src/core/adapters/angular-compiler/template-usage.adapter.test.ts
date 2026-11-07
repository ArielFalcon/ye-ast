import { test } from "node:test";
import assert from "node:assert/strict";
import type { Relation, SymbolRef } from "../../domain/relations/relation.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { ScopeMember, TemplateUnit } from "../../ports/template-usage.port.ts";
import { createTemplateUsageReader } from "./template-usage.adapter.ts";

const HOST: SymbolRef = { path: "src/app/host.ts", symbol: "Host", line: 3 };

function ref(symbol: string): SymbolRef {
  return { path: `src/app/${symbol.toLowerCase()}.ts`, symbol, line: 7 };
}

const component = (symbol: string, selector: string): ScopeMember => ({ kind: "component", ref: ref(symbol), selector });
const directive = (symbol: string, selector: string): ScopeMember => ({ kind: "directive", ref: ref(symbol), selector });
const pipe = (symbol: string, name: string): ScopeMember => ({ kind: "pipe", ref: ref(symbol), name });

function read(text: string, scope: ScopeMember[], firstLine = 1): readonly Finding<Relation>[] {
  const unit: TemplateUnit = { component: HOST, path: "src/app/host.html", text, firstLine, scope };
  return createTemplateUsageReader().read([unit]).relations;
}

/** `<kind> <to>@<line>` for each relation and `<reason>@<line>` for each unknown item. */
function summary(findings: readonly Finding<Relation>[]): string[] {
  return findings.map((finding) => (finding.status === "complete" ? `${finding.value.kind} ${finding.value.to.symbol}@${finding.evidence[0]?.line}` : `${finding.reason}@${finding.evidence[0]?.line}`));
}

test("a component or a directive is used by an element its selector matches: by tag, attribute, class, and not by a :not it satisfies", () => {
  const findings = read(
    '<app-card></app-card>\n<p appHi></p>\n<span class="badge"></span>\n<i class="plain"></i>\n<b class="badge z"></b>',
    [component("Card", "app-card"), directive("Hi", "[appHi]"), directive("Badge", "span.badge, b.badge:not(.z)"), directive("Plain", "i:not(.plain)")],
  );

  assert.deepEqual(summary(findings), ["uses-component Card@1", "uses-directive Hi@2", "uses-directive Badge@3"]);
});

test("a structural directive is matched through the desugared template of *ngIf, and an element inside @if, @for, @switch and @defer is matched too", () => {
  const findings = read(
    '<div *appIf="x"></div>\n@if (a) { <app-a></app-a> }\n@for (i of l; track i) { <app-b></app-b> }\n@switch (s) { @case (1) { <app-c></app-c> } }\n@defer { <app-d></app-d> }',
    [directive("If", "[appIf]"), component("A", "app-a"), component("B", "app-b"), component("C", "app-c"), component("D", "app-d")],
  );

  assert.deepEqual(summary(findings), ["uses-directive If@1", "uses-component A@2", "uses-component B@3", "uses-component C@4", "uses-component D@5"]);
});

test("a pipe is used by the name a binding, an interpolation or an @let calls, at the line of the node that holds the call; one in scope and not called is not used", () => {
  const findings = read(
    '<p>{{ a | money }}</p>\n<p [title]="b | upper"></p>\n@let c = d | lower;\n',
    [pipe("Money", "money"), pipe("Upper", "upper"), pipe("Lower", "lower"), pipe("Unused", "unused")],
  );

  assert.deepEqual(summary(findings), ["uses-pipe Money@1", "uses-pipe Upper@2", "uses-pipe Lower@3"]);
});

test("a component of the scope the template does not use is no relation", () => {
  assert.deepEqual(read("<app-a></app-a>", [component("A", "app-a"), component("B", "app-b"), directive("C", "[c]"), pipe("P", "p")]).length, 1);
});

test("a relation is kept once, at its first use, and the line is relative to the line the text starts on", () => {
  const findings = read("<p></p>\n<app-a></app-a>\n<app-a></app-a>", [component("A", "app-a")], 40);

  assert.deepEqual(summary(findings), ["uses-component A@41"]);
  assert.equal(findings[0]?.evidence[0]?.path, "src/app/host.html");
});

test("an element two components match is unknown with unresolved, names neither component and keeps the directives that matched; a pipe name two pipes in scope share is unknown too", () => {
  const findings = read("<app-a x></app-a>\n<p>{{ v | dup }}</p>\n<p>{{ v | one }}</p>", [component("A", "app-a"), component("B", "[x]"), directive("D", "app-a"), pipe("P1", "dup"), pipe("P2", "dup"), pipe("One", "one")]);

  assert.deepEqual(summary(findings), ["uses-directive D@1", "unresolved@1", "unresolved@2", "uses-pipe One@3"]);
});

test("a template that does not parse is one unknown item with source-unreadable at the line of the error and no relation", () => {
  const findings = read("<app-a></app-a>\n<div><span></div>", [component("A", "app-a")]);

  assert.deepEqual(summary(findings), ["source-unreadable@2"]);
});

test("a selector the compiler rejects is unknown with no-extractor at its class, and the other members still match", () => {
  const findings = read("<app-a></app-a>", [directive("Bad", "a:not(b:not(c))"), component("A", "app-a")]);

  assert.deepEqual(summary(findings), ["no-extractor@7", "uses-component A@1"]);
  assert.equal(findings[0]?.evidence[0]?.path, "src/app/bad.ts");
});

test("the same units give the same findings in the same order", () => {
  const scope = [component("A", "app-a"), directive("D", "[d]"), pipe("P", "p")];
  const text = '<app-a d></app-a>\n{{ x | p }}';

  assert.deepEqual(read(text, scope), read(text, scope));
  assert.deepEqual(read(text, scope), read(text, [...scope].reverse()));
});

test("the handlers a template binds to events are the component's own methods its event bindings call, in text order, never a template local's or a field's member", () => {
  const text = [
    '<button (click)="save(); this.reset()">x</button>',
    "<p>{{ total() }}</p>",
    '<ng-template let-item let-act><a (click)="item.open(); act(); pick(item)">y</a></ng-template>',
    '<input #box (keyup)="box.focus(); store.load()">',
    '@defer { <i></i> } @loading { <b (click)="wait()"></b> } @placeholder { <s (click)="hold()"></s> }',
  ].join("\n");
  const effects = createTemplateUsageReader().effects({ path: "src/app/host.html", text, firstLine: 4 });
  assert.deepEqual(effects.handlers.map(({ file, line, column, member }) => `${file}:${line}:${column} ${member}`), [
    "src/app/host.html:4:18 save",
    "src/app/host.html:4:26 reset",
    "src/app/host.html:6:63 pick",
    "src/app/host.html:8:43 wait",
    "src/app/host.html:8:85 hold",
  ]);
});

test("every other call an event binding makes is listed with its spelling, so none is dropped: a field's method, a template local's, the event's", () => {
  const text = ['<ng-template let-act><b (click)="store.save(); act(); save()"></b></ng-template>', '<i (keyup)="$event.stopPropagation()"></i>', "<p>{{ store.total() }}</p>", '@defer { } @loading { <a (click)="x.wait()"></a> } @placeholder { <b (click)="x.hold()"></b> }'].join("\n");
  const effects = createTemplateUsageReader().effects({ path: "src/app/host.html", text, firstLine: 1 });
  assert.deepEqual(effects.eventCalls.map(({ line, column, name }) => `${line}:${column} ${name}`), ["1:34 store.save", "1:48 act", "2:13 $event.stopPropagation", "4:35 x.wait", "4:79 x.hold"]);
  assert.deepEqual(effects.handlers.map(({ member }) => member), ["save"]);
});

test("the declarations a template uses are listed in the order they first appear in its text, whatever their kind", () => {
  const scope = [directive("Mark", "[mark]"), pipe("Fmt", "fmt"), component("Child", "child-x")];
  const deferred = { ...HOST, symbol: "Deferred" };
  const twice = { ...HOST, symbol: "Twice" };
  const usage = createTemplateUsageReader().read([
    { component: HOST, path: "src/app/host.html", text: "<div *mark>{{ value | fmt }}</div><child-x />", firstLine: 1, scope },
    { component: deferred, path: "src/app/deferred.html", text: "@defer { <child-x /> } @loading { {{ value | fmt }}<i mark></i> } @placeholder { <b mark></b> }", firstLine: 1, scope },
    { component: twice, path: "src/app/twice.html", text: "@defer { } @loading { <i mark></i><child-x /> } @placeholder { <b mark></b> }", firstLine: 1, scope },
  ]);
  assert.deepEqual(usage.uses, [
    { component: HOST, uses: [ref("Mark"), ref("Fmt"), ref("Child")] },
    { component: deferred, uses: [ref("Child"), ref("Fmt"), ref("Mark")] },
    { component: twice, uses: [ref("Mark"), ref("Child")] },
  ]);
});
