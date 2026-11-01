import { test } from "node:test";
import assert from "node:assert/strict";
import type { AngularClass, Operand } from "../../domain/relations/angular-class.ts";
import type { AngularMetadata } from "../../ports/angular-metadata.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { createAngularMetadataReader } from "./angular-metadata.adapter.ts";

const PACKAGE = JSON.stringify({ dependencies: { "@angular/core": "22.0.0" } });
const CORE = "import { Component, Directive, Injectable, Inject, InjectionToken, NgModule, Pipe, inject } from '@angular/core';\n";
const SERVICE = "src/app/orders.service.ts";
const SERVICE_SOURCE = `${CORE}\nexport class OrdersService {}\n`;

function read(files: Record<string, string>, manifest: string | null = PACKAGE): Promise<AngularMetadata> {
  const all = manifest === null ? files : { "package.json": manifest, ...files };
  const sources: SourceFile[] = Object.entries(all).map(([path, content]) => ({ path, content }));
  return createAngularMetadataReader().read(sources);
}

/** The injection relations as `<owner> > <target> @ <path>:<line>`, and the unknown items as `<reason> @ <path>:<line>`. */
function summary(meta: AngularMetadata): string[] {
  return meta.findings.map((finding) =>
    finding.status === "complete"
      ? `${finding.value.from.symbol} > ${finding.value.to.symbol} (${finding.value.to.path}:${finding.value.to.line}) @ ${finding.evidence[0]?.path}:${finding.evidence[0]?.line}`
      : `${finding.reason} @ ${finding.evidence[0]?.path}:${finding.evidence[0]?.line}`,
  );
}

function classNamed(meta: AngularMetadata, name: string): AngularClass {
  const found = meta.classes.find((candidate) => candidate.ref.symbol === name);
  assert.ok(found, `${name} is read`);
  return found;
}

function refs(operands: readonly Operand[]): string[] {
  return operands.map((operand) => ("ref" in operand ? operand.ref.symbol : `unresolved@${operand.unresolved.path}:${operand.unresolved.line}`));
}

test("a repository whose root manifest does not name @angular/core has no Angular class and no injection", async () => {
  const files = { [SERVICE]: SERVICE_SOURCE, "src/app/a.ts": `${CORE}import { OrdersService } from './orders.service';\n@Component({})\nexport class A { s = inject(OrdersService); }\n` };

  assert.deepEqual(await read(files, JSON.stringify({ dependencies: { react: "19.0.0" } })), { classes: [], findings: [] });
  assert.deepEqual(await read(files, null), { classes: [], findings: [] });
  assert.equal((await read(files)).findings.length, 1);
});

test("inject(X) in a field, with or without options, relates the class to the class X is imported from", async () => {
  const meta = await read({
    [SERVICE]: SERVICE_SOURCE,
    "src/app/a.ts": `${CORE}import { OrdersService } from './orders.service';\n\n@Component({})\nexport class A {\n  s = inject(OrdersService, { optional: true });\n}\n`,
  });

  assert.deepEqual(summary(meta), ["A > OrdersService (src/app/orders.service.ts:3) @ src/app/a.ts:6"]);
  const [finding] = meta.findings;
  assert.equal(finding?.status === "complete" && finding.value.from.line, 5);
});

test("an injection records the name it is stored in: a field, a constructor parameter or a constant; none when the call is not bound to a name", async () => {
  const meta = await read({
    [SERVICE]: SERVICE_SOURCE,
    "src/app/a.ts": `${CORE}import { OrdersService } from './orders.service';\n\n@Injectable()\nexport class A {\n  private readonly orders = inject(OrdersService);\n}\n\n@Injectable()\nexport class B {\n  constructor(private readonly svc: OrdersService) {}\n}\n\nexport const guard = () => {\n  const local = inject(OrdersService);\n  return local;\n};\n\nexport function bare() {\n  return inject(OrdersService).toString();\n}\n`,
  });

  const bindings = meta.findings.map((finding) => (finding.status === "complete" ? `${finding.value.from.symbol}:${finding.value.binding ?? "-"}` : finding.reason));
  assert.deepEqual(bindings.toSorted(), ["A:orders", "B:svc", "bare:-", "guard:local"]);
});

test("a name resolves through renames and barrels to the class that declares it, not to the barrel", async () => {
  const meta = await read({
    [SERVICE]: SERVICE_SOURCE,
    "src/app/index.ts": "export { OrdersService as Orders } from './orders.service';\n",
    "src/app/a.ts": `${CORE}import { Orders as Svc } from './index';\nimport * as ns from './index';\n\n@Injectable()\nexport class A {\n  one = inject(Svc);\n  two = inject(ns.Orders);\n}\n`,
  });

  assert.deepEqual(summary(meta), ["A > OrdersService (src/app/orders.service.ts:3) @ src/app/a.ts:7"]);
});

test("a constructor parameter type of a decorated class is injected, also as a parameter property or a type with null; a plain class is not constructed by Angular", async () => {
  const meta = await read({
    [SERVICE]: SERVICE_SOURCE,
    "src/app/a.ts": `${CORE}import { OrdersService } from './orders.service';\n\n@Injectable()\nexport class A {\n  constructor(private readonly orders: OrdersService | null, name: string) {}\n}\n\nexport class Plain {\n  constructor(orders: OrdersService) {}\n}\n\n@Injectable()\nexport class B {\n  constructor(o: OrdersService | undefined) {}\n}\n`,
  });

  assert.deepEqual(summary(meta), ["A > OrdersService (src/app/orders.service.ts:3) @ src/app/a.ts:6", "B > OrdersService (src/app/orders.service.ts:3) @ src/app/a.ts:15"]);
});

test("@Inject(X) relates to X when it is a class and is unknown with no-extractor when it names a token, a member of a value or an expression", async () => {
  const meta = await read({
    [SERVICE]: SERVICE_SOURCE,
    "src/app/tokens.ts": `${CORE}export const API_URL = new InjectionToken<string>('api');\nexport class Tokens {\n  static API = 'x';\n}\n`,
    "src/app/a.ts": `${CORE}import { OrdersService } from './orders.service';\nimport { API_URL, Tokens } from './tokens';\n\n@Injectable()\nexport class A {\n  constructor(\n    @Inject(OrdersService) a: object,\n    @Inject(API_URL) b: string,\n    @Inject('legacy') c: string,\n  ) {}\n  d = inject(API_URL);\n  e = inject(Tokens.API);\n}\n`,
  });

  assert.deepEqual(summary(meta), ["no-extractor @ src/app/a.ts:9", "no-extractor @ src/app/a.ts:10", "no-extractor @ src/app/a.ts:12", "no-extractor @ src/app/a.ts:13", "A > OrdersService (src/app/orders.service.ts:3) @ src/app/a.ts:8"]);
});

test("the top-level function or constant that calls inject() is the owner (a guard written as an arrow constant, an interceptor as a function declaration), unless a class holds the call", async () => {
  const meta = await read({
    [SERVICE]: SERVICE_SOURCE,
    "src/app/guards.ts": `${CORE}import { OrdersService } from './orders.service';\n\nexport const ordersGuard = () => {\n  const nested = () => inject(OrdersService);\n  return nested();\n};\n\nexport function ordersInterceptor() {\n  return inject(OrdersService);\n}\n\nexport class Holder {\n  m() {\n    function helper() {\n      return inject(OrdersService);\n    }\n    return helper;\n  }\n}\n`,
  });

  assert.deepEqual(
    meta.findings.flatMap((finding) => (finding.status === "complete" ? [`${finding.value.from.symbol}:${finding.value.from.line}`] : [])),
    ["ordersGuard:4", "ordersInterceptor:9", "Holder:13"],
  );
});

test("an inject that is not Angular's is not a relation, and a namespace import of @angular/core is", async () => {
  const meta = await read({
    [SERVICE]: SERVICE_SOURCE,
    "src/app/own.ts": "export function inject(x: unknown): unknown { return x; }\n",
    "src/app/a.ts": `import { OrdersService } from './orders.service';\nimport { inject } from './own';\nimport { inject as other } from 'other-lib';\nimport * as lib from 'other-lib';\n\nexport class A {\n  a = inject(OrdersService);\n  b = other(OrdersService);\n  c = lib.inject(OrdersService);\n}\nfunction inject2() { return 1; }\n`,
    "src/app/b.ts": "import * as core from '@angular/core';\nimport { OrdersService } from './orders.service';\n\nexport class B {\n  a = core.inject(OrdersService);\n}\n",
  });

  assert.deepEqual(summary(meta), ["B > OrdersService (src/app/orders.service.ts:3) @ src/app/b.ts:5"]);
});

test("a target from an installed package is no relation of the repository, and one the imports do not resolve is unknown with unresolved", async () => {
  const manifest = JSON.stringify({ dependencies: { "@angular/core": "22.0.0", "@angular/router": "22.0.0" } });
  const meta = await read(
    {
      "src/app/a.ts": `${CORE}import { Router } from '@angular/router';\nimport { Gone } from './gone';\nimport { Lost } from './orders.service';\n\n@Injectable()\nexport class A {\n  r = inject(Router);\n  g = inject(Gone);\n  l = inject(Lost);\n  u = inject(Undeclared);\n}\n`,
      [SERVICE]: SERVICE_SOURCE,
    },
    manifest,
  );

  assert.deepEqual(summary(meta), ["unresolved @ src/app/a.ts:9", "unresolved @ src/app/a.ts:10", "unresolved @ src/app/a.ts:11"]);
});

test("an inject() outside any class, function or constant has no owner and is unknown with no-extractor", async () => {
  const meta = await read({ [SERVICE]: SERVICE_SOURCE, "src/main.ts": `${CORE}import { OrdersService } from './app/orders.service';\n\nbootstrap(() => inject(OrdersService));\n` });

  assert.deepEqual(summary(meta), ["no-extractor @ src/main.ts:4"]);
});

test("the same injection written twice is one relation at its first site, and two targets are two relations", async () => {
  const meta = await read({
    [SERVICE]: SERVICE_SOURCE,
    "src/app/other.service.ts": "export class OtherService {}\n",
    "src/app/a.ts": `${CORE}import { OrdersService } from './orders.service';\nimport { OtherService } from './other.service';\n\n@Injectable()\nexport class A {\n  a = inject(OrdersService);\n  o = inject(OtherService);\n  constructor(c: OrdersService) {}\n}\n`,
  });

  assert.deepEqual(summary(meta).sort(), ["A > OrdersService (src/app/orders.service.ts:3) @ src/app/a.ts:7", "A > OtherService (src/app/other.service.ts:1) @ src/app/a.ts:8"]);
});

test("a source the compiler's parser rejects is unknown with source-unreadable at line 1", async () => {
  const meta = await read({ "src/app/broken.ts": "export class {{{ \n" });

  assert.deepEqual(summary(meta), ["source-unreadable @ src/app/broken.ts:1"]);
});

test("the decorators read as classes carry their selector, pipe name, module lists and the lines of their names", async () => {
  const meta = await read({
    "src/app/x.ts": `${CORE}\n@Component({ selector: 'app-x, [appX]', template: '<b></b>' })\nexport class X {}\n@Directive({ selector: '[appD]', hostDirectives: [{ directive: D2, inputs: ['a'] }, D3] })\nexport class D {}\n@Pipe({ name: 'money' })\nexport class MoneyPipe {}\n@NgModule({ declarations: [X], imports: [D], exports: [X] })\nexport class XModule {}\n@Component({})\nexport class NoSelector {}\nexport class D2 {}\nexport class D3 {}\n`,
  });

  assert.deepEqual(
    meta.classes.map((c) => [c.kind, c.ref.symbol, c.ref.line, "selector" in c ? c.selector : "name" in c ? c.name : undefined]),
    [["component", "X", 4, "app-x, [appX]"], ["directive", "D", 6, "[appD]"], ["pipe", "MoneyPipe", 8, "money"], ["module", "XModule", 10, undefined], ["component", "NoSelector", 12, undefined]],
  );
  const directive = classNamed(meta, "D");
  assert.deepEqual(refs(directive.kind === "directive" ? directive.hostDirectives : []), ["D2", "D3"]);
  const module = classNamed(meta, "XModule");
  assert.deepEqual(module.kind === "module" ? [refs(module.declarations), refs(module.imports), refs(module.exports)] : [], [["X"], ["D"], ["X"]]);
});

test("a decorator that is not Angular's is not read as a class", async () => {
  const meta = await read({ "src/app/x.ts": "import { Component } from 'other-lib';\n@Component({ selector: 'a' })\nexport class X {}\n" });

  assert.deepEqual(meta.classes, []);
});

test("a template is read inline with its line, or from the file templateUrl names beside the component; an expression is unreadable", async () => {
  const meta = await read({
    "src/app/a/a.ts": `${CORE}@Component({\n  template: \`<p></p>\`,\n})\nexport class A {}\n@Component({ templateUrl: '../shared/b.html' })\nexport class B {}\n@Component({ template: TEXT })\nexport class C {}\n@Component({ selector: SEL })\nexport class D {}\n`,
  });

  const [a, b, c] = ["A", "B", "C"].map((name) => classNamed(meta, name));
  assert.deepEqual(a?.kind === "component" && a.template, { inline: { text: "<p></p>", line: 3 } });
  assert.deepEqual(b?.kind === "component" && b.template, { file: { path: "src/app/shared/b.html", at: { path: "src/app/a/a.ts", line: 6 } } });
  assert.deepEqual(c?.kind === "component" && c.template, { unreadable: { path: "src/app/a/a.ts", line: 8 } });
  assert.deepEqual(summary(meta), ["unresolved @ src/app/a/a.ts:10"]);
});

test("an imports list is followed through arrays, spreads and a module's forRoot call, leaves an installed package out and marks what it cannot place", async () => {
  const meta = await read({
    "src/app/shared.ts": `${CORE}export class Btn {}\nexport class Card {}\nexport class Tbl {}\nexport const CARDS = [Card];\nexport const SHARED = [Btn, ...CARDS];\nexport class CoreModule {}\n`,
    "src/app/a.ts": `${CORE}import { CommonModule } from '@angular/common';\nimport { SHARED, Tbl, CoreModule } from './shared';\nimport { Missing } from './missing';\n\n@Component({\n  imports: [CommonModule, SHARED, Tbl, CoreModule.forRoot(), Missing, makeOne()],\n})\nexport class A {}\n`,
  }, JSON.stringify({ dependencies: { "@angular/core": "22.0.0", "@angular/common": "22.0.0" } }));

  const a = classNamed(meta, "A");
  assert.deepEqual(refs(a.kind === "component" ? a.imports : []), ["Btn", "Card", "Tbl", "CoreModule", "unresolved@src/app/a.ts:7", "unresolved@src/app/a.ts:7"]);
});

test("arrays that list each other are a cycle: the operand is unresolved once, not followed for ever", async () => {
  const meta = await read({
    "src/app/lists.ts": "export class Leaf {}\nexport const A = [Leaf, ...B];\nexport const B = [...A];\n",
    "src/app/a.ts": `${CORE}import { B } from './lists';\n@Component({ imports: [B] })\nexport class X {}\n`,
  });

  const x = classNamed(meta, "X");
  assert.deepEqual(refs(x.kind === "component" ? x.imports : []), ["Leaf", "unresolved@src/app/lists.ts:2"]);
});

test("an @Attribute parameter is a value of the host element, not an injected class", async () => {
  const meta = await read({ "src/app/a.ts": `${CORE}import { Attribute } from '@angular/core';\ntype Mode = 'a' | 'b';\n\n@Component({})\nexport class A {\n  constructor(@Attribute('mode') mode: Mode) {}\n}\n` });

  assert.deepEqual(summary(meta), []);
});

test("an app under a subfolder has its injections read, with repository-relative paths", async () => {
  const meta = await createAngularMetadataReader().read([
    { path: "frontend/package.json", content: PACKAGE },
    { path: "frontend/src/orders.service.ts", content: SERVICE_SOURCE },
    { path: "frontend/src/page.ts", content: `${CORE}import { OrdersService } from './orders.service';\n@Injectable()\nexport class Page {\n  orders = inject(OrdersService);\n}\n` },
  ]);
  assert.deepEqual(summary(meta), ["Page > OrdersService (frontend/src/orders.service.ts:3) @ frontend/src/page.ts:5"]);
});
