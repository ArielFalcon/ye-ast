import { test } from "node:test";
import assert from "node:assert/strict";
import type { AngularClass, Operand, TemplateSource } from "../../domain/relations/angular-class.ts";
import type { Relation, SymbolRef } from "../../domain/relations/relation.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { AngularMetadata } from "../../ports/angular-metadata.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { TemplateUnit } from "../../ports/template-usage.port.ts";
import { createAngularRelationExtractor } from "./angular-relations.ts";

const ref = (symbol: string, path = `src/app/${symbol.toLowerCase()}.ts`, line = 5): SymbolRef => ({ path, symbol, line });
const op = (symbol: string): Operand => ({ ref: ref(symbol), at: { path: "src/app/list.ts", line: 9 } });
const lost: Operand = { unresolved: { path: "src/app/list.ts", line: 11 } };
const inline = (text: string, line = 20): TemplateSource => ({ inline: { text, line } });

const component = (symbol: string, over: { selector?: string; imports?: Operand[]; template?: TemplateSource; hostDirectives?: Operand[] } = {}): AngularClass => ({
  kind: "component",
  ref: ref(symbol),
  selector: over.selector ?? `app-${symbol.toLowerCase()}`,
  template: over.template ?? inline("<x></x>"),
  imports: over.imports ?? [],
  hostDirectives: over.hostDirectives ?? [],
});
const directive = (symbol: string, selector = `[${symbol.toLowerCase()}]`, hostDirectives: Operand[] = []): AngularClass => ({ kind: "directive", ref: ref(symbol), selector, hostDirectives });
const pipe = (symbol: string, name = symbol.toLowerCase()): AngularClass => ({ kind: "pipe", ref: ref(symbol), name });
const module = (symbol: string, over: { declarations?: Operand[]; imports?: Operand[]; exports?: Operand[] } = {}): AngularClass => ({
  kind: "module",
  ref: ref(symbol),
  declarations: over.declarations ?? [],
  imports: over.imports ?? [],
  exports: over.exports ?? [],
});

interface Run {
  findings: readonly Finding<Relation>[];
  units: TemplateUnit[];
}

async function run(classes: AngularClass[], files: SourceFile[] = [], metadataFindings: Finding<Relation>[] = []): Promise<Run> {
  const units: TemplateUnit[] = [];
  const metadata: AngularMetadata = { classes, findings: metadataFindings, fields: [], locals: [] };
  const extractor = createAngularRelationExtractor({
    metadata: { read: async () => metadata },
    templates: {
      read: (given) => {
        units.push(...given);
        return [];
      },
      memberCalls: () => [],
    },
  });
  return { findings: (await extractor.extract(files)).relations, units };
}

function scopeOf(result: Run, component: string): string[] {
  const unit = result.units.find((candidate) => candidate.component.symbol === component);
  assert.ok(unit, `${component} has a template unit`);
  return unit.scope.map((member) => member.ref.symbol).sort();
}

function summary(findings: readonly Finding<Relation>[]): string[] {
  return findings.map((finding) => (finding.status === "complete" ? `${finding.value.kind} ${finding.value.from.symbol}>${finding.value.to.symbol}@${finding.evidence[0]?.line}` : `${finding.reason}@${finding.evidence[0]?.path}:${finding.evidence[0]?.line}`));
}

test("a standalone component's scope is its imports: an NgModule it imports gives what the module exports, and a class it does not import is out of scope", async () => {
  const result = await run([
    component("Host", { imports: [op("Card"), op("Shared")] }),
    component("Card"),
    component("Hidden"),
    directive("Hi"),
    module("Shared", { declarations: [op("Hi"), op("Hidden")], exports: [op("Hi")] }),
  ]);

  assert.deepEqual(scopeOf(result, "Host"), ["Card", "Hi"]);
});

test("the scope of a component an NgModule declares is that module's declarations and what its imported modules export, re-exports through modules included", async () => {
  const result = await run([
    component("Host"),
    component("Sibling"),
    component("Imported"),
    component("Deep"),
    component("Private"),
    module("App", { declarations: [op("Host"), op("Sibling")], imports: [op("Outer")] }),
    module("Outer", { declarations: [op("Imported"), op("Private")], imports: [op("Inner")], exports: [op("Imported"), op("Inner")] }),
    module("Inner", { declarations: [op("Deep")], exports: [op("Deep")] }),
  ]);

  assert.deepEqual(scopeOf(result, "Host"), ["Deep", "Imported", "Sibling"]);
});

test("a component is never in its own scope, and a class that is not an Angular class, one without a selector or a pipe without a name is no member", async () => {
  const noSelector: AngularClass = { kind: "directive", ref: ref("Bare"), hostDirectives: [] };
  const noName: AngularClass = { kind: "pipe", ref: ref("Nameless") };
  const result = await run([component("Host", { imports: [op("Host"), op("Bare"), op("Nameless"), op("Money"), op("NotAngular")] }), noSelector, noName, pipe("Money")]);

  assert.deepEqual(scopeOf(result, "Host"), ["Money"]);
});

test("modules that export each other end the walk, and a class both imported and declared is one member", async () => {
  const result = await run([
    component("Host"),
    module("A", { declarations: [op("Host"), op("Dir")], imports: [op("B")], exports: [op("B")] }),
    module("B", { exports: [op("A"), op("Dir")] }),
    directive("Dir"),
  ]);

  assert.deepEqual(scopeOf(result, "Host"), ["Dir"]);
});

test("a component two NgModules declare has no scope to tell, and is unknown with unresolved at its class", async () => {
  const result = await run([component("Host"), module("One", { declarations: [op("Host")] }), module("Two", { declarations: [op("Host")] })]);

  assert.deepEqual(scopeOf(result, "Host"), []);
  assert.deepEqual(summary(result.findings), ["unresolved@src/app/host.ts:5"]);
});

test("a list that cannot be read makes an unknown item at it, once however many components it reaches, and the readable part stays in scope", async () => {
  const result = await run([
    component("One", { imports: [lost, op("Shared")] }),
    component("Two", { imports: [op("Shared")] }),
    module("Shared", { exports: [lost, op("Dir")] }),
    directive("Dir"),
  ]);

  assert.deepEqual(summary(result.findings), ["unresolved@src/app/list.ts:11"]);
  assert.deepEqual(scopeOf(result, "One"), ["Dir"]);
});

test("a template written in the decorator is read at the component's file and line; one in a templateUrl file is read from the sources, with the lines of that file", async () => {
  const files: SourceFile[] = [{ path: "src/app/b.html", content: "<p></p>\r\n<q></q>" }];
  const result = await run([
    component("A", { template: inline("<a></a>", 33) }),
    component("B", { template: { file: { path: "src/app/b.html", at: { path: "src/app/b.ts", line: 6 } } } }),
  ], files);

  const [a, b] = ["A", "B"].map((name) => result.units.find((unit) => unit.component.symbol === name));
  assert.deepEqual([a?.path, a?.text, a?.firstLine], ["src/app/a.ts", "<a></a>", 33]);
  assert.deepEqual([b?.path, b?.text, b?.firstLine], ["src/app/b.html", "<p></p>\n<q></q>", 1]);
});

test("a templateUrl file the sources lack is unknown with source-unreadable at the property, and a template given as an expression with no-extractor; neither is parsed", async () => {
  const result = await run([
    component("A", { template: { file: { path: "src/app/gone.html", at: { path: "src/app/a.ts", line: 6 } } } }),
    component("B", { template: { unreadable: { path: "src/app/b.ts", line: 8 } } }),
  ]);

  assert.deepEqual(summary(result.findings), ["source-unreadable@src/app/a.ts:6", "no-extractor@src/app/b.ts:8"]);
  assert.deepEqual(result.units, []);
});

test("a host directive is used by the class that lists it, at the entry; a class that is no directive is not a relation and an entry that cannot be read is unknown", async () => {
  const result = await run([
    component("Host", { hostDirectives: [op("Tooltip"), op("Plain"), lost] }),
    directive("Tooltip"),
    directive("Outer", "[outer]", [op("Tooltip")]),
    pipe("Plain"),
  ]);

  assert.deepEqual(summary(result.findings), ["uses-directive Host>Tooltip@9", "uses-directive Outer>Tooltip@9", "unresolved@src/app/list.ts:11"]);
});

test("the findings are the metadata reader's and the template reader's together, in the order of the port whatever the order the classes arrive in", async () => {
  const injection: Finding<Relation> = { status: "complete", value: { kind: "injects", name: "Host>Svc", from: ref("Host"), to: ref("Svc") }, evidence: [{ path: "src/app/host.ts", line: 2 }] };
  const classes = [component("Host", { hostDirectives: [op("Tooltip")] }), directive("Tooltip"), directive("Outer", "[outer]", [op("Tooltip")])];
  const forward = await run(classes, [], [injection]);
  const backward = await run([...classes].reverse(), [], [injection]);

  assert.deepEqual(forward.findings, backward.findings);
  assert.deepEqual(summary(forward.findings), ["injects Host>Svc@2", "uses-directive Host>Tooltip@9", "uses-directive Outer>Tooltip@9"]);
});


test("member proof eligibility and exact uses pass through relation extraction", async () => {
  const proof = { owner: ref("Owner"), receiver: ref("Store"), member: ref("write"), reference: { file: "src/owner.ts", line: 9, column: 4, name: "this.store.write", kind: "calls" as const } };
  const options = { memberProofs: { completeSource: true } };
  let received: unknown;
  const extractor = createAngularRelationExtractor({
    metadata: { read: async (_files, context) => {
      received = context;
      return { classes: [], findings: [], fields: [], locals: [], memberUses: [proof] };
    } },
    templates: { read: () => [], memberCalls: () => [] },
  });
  const result = await extractor.extract([], options);
  assert.deepEqual((received as typeof options).memberProofs, options.memberProofs);
  assert.deepEqual(result.memberUses, [proof]);
});
