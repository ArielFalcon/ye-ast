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

test("a repository whose root manifest does not name @angular/core has no Angular class, no injection and no field", async () => {
  const files = { [SERVICE]: SERVICE_SOURCE, "src/app/a.ts": `${CORE}import { OrdersService } from './orders.service';\n@Component({})\nexport class A { s = inject(OrdersService); }\n` };

  assert.deepEqual(await read(files, JSON.stringify({ dependencies: { react: "19.0.0" } })), { classes: [], findings: [], fields: [], locals: [] });
  assert.equal((await read(files)).findings.length, 1);
});

test("a TypeScript source no package.json above it holds is unknown with reason no-project, never silence", async () => {
  const meta = await read({ [SERVICE]: SERVICE_SOURCE }, null);

  assert.deepEqual(summary(meta), [`no-project @ ${SERVICE}:1`]);
  assert.deepEqual(meta.classes, []);
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

test("a field fixed by its declaration holds what it injects or creates; a reassigned, static, plain-parameter or substituted one holds nothing known", async () => {
  const manifest = JSON.stringify({ dependencies: { "@angular/core": "22.0.0", "@angular/common": "22.0.0" } });
  const meta = await read(
    {
      [SERVICE]: SERVICE_SOURCE,
      "src/app/other.service.ts": `${CORE}\nexport class OtherService {}\n`,
      "src/app/providers.ts": `${CORE}import { OtherService } from './other.service';\n\nexport const PROVIDERS = [{ provide: OtherService, useFactory: () => null }];\n`,
      "src/app/a.ts": `${CORE}import { HttpClient } from '@angular/common/http';\nimport { OrdersService } from './orders.service';\nimport { OtherService } from './other.service';\n\n@Injectable()\nexport class A {\n  private readonly orders = inject(OrdersService);\n  private readonly http = inject(HttpClient);\n  private readonly cache = new Map<string, number>();\n  private readonly other = inject(OtherService);\n  private moved = inject(OrdersService);\n  static shared = new Map();\n  constructor(private readonly svc: OrdersService, plain: OrdersService) {}\n  swap(): void {\n    this.moved = new OrdersService();\n  }\n}\n`,
    },
    manifest,
  );

  const fields = meta.fields.map(({ owner, field, holds }) => `${owner.symbol}.${field} ${"class" in holds ? `${holds.class.path}:${holds.class.symbol}` : holds.external}`);
  assert.deepEqual(fields, ["A.cache global#Map", "A.http @angular/common/http#HttpClient", `A.orders ${SERVICE}:OrdersService`, `A.svc ${SERVICE}:OrdersService`]);
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

test("a class and a declared token both relate; a member of a value and an expression stay unknown with no-extractor", async () => {
  const meta = await read({
    [SERVICE]: SERVICE_SOURCE,
    "src/app/tokens.ts": `${CORE}export const API_URL = new InjectionToken<string>('api');\nexport class Tokens {\n  static API = 'x';\n}\n`,
    "src/app/a.ts": `${CORE}import { OrdersService } from './orders.service';\nimport { API_URL, Tokens } from './tokens';\n\n@Injectable()\nexport class A {\n  constructor(\n    @Inject(OrdersService) a: object,\n    @Inject(API_URL) b: string,\n    @Inject('legacy') c: string,\n  ) {}\n  d = inject(API_URL);\n  e = inject(Tokens.API);\n}\n`,
  });

  assert.deepEqual(summary(meta), [
    "no-extractor @ src/app/a.ts:10",
    "no-extractor @ src/app/a.ts:13",
    "A > OrdersService (src/app/orders.service.ts:3) @ src/app/a.ts:8",
    "A > API_URL (src/app/tokens.ts:2) @ src/app/a.ts:9",
  ]);
  assert.deepEqual(meta.memberUses ?? [], []);
});

test("an unbound instantiated token remains unresolved", async () => {
  const meta = await read({
    [SERVICE]: SERVICE_SOURCE,
    "src/app/a.ts": `${CORE}\n@Injectable()\nexport class A {\n  private readonly element = inject(ElementRef<HTMLElement>);\n}\n`,
  });

  assert.deepEqual(summary(meta), ["unresolved @ src/app/a.ts:5"]);
});

test("instantiated imported tokens resolve through aliases and namespaces in injection positions", async () => {
  const meta = await read({
    [SERVICE]: SERVICE_SOURCE,
    "src/app/a.ts": `${CORE}import { OrdersService as Alias } from './orders.service';\nimport * as ns from './orders.service';\n@Injectable()\nexport class A {\n  field = inject(Alias<string>);\n  constructor(@Inject(ns.OrdersService<number>) value: unknown) {}\n}\nexport function guard() { return inject((ns.OrdersService<string>)); }\n`,
  });
  assert.deepEqual(summary(meta), [
    "A > OrdersService (src/app/orders.service.ts:3) @ src/app/a.ts:6",
    "guard > OrdersService (src/app/orders.service.ts:3) @ src/app/a.ts:9",
  ]);
});

test("instantiated external, unresolved, dynamic and shadowed tokens retain their existing boundaries", async () => {
  const meta = await read({
    [SERVICE]: SERVICE_SOURCE,
    "src/app/a.ts": `${CORE}import { ElementRef } from '@angular/core';\nimport { Gone } from './missing';\nimport { OrdersService } from './orders.service';\nexport const external = () => inject(ElementRef<HTMLElement>);\nexport const missing = () => inject(Gone<string>);\nexport const dynamic = () => inject(select()<string>);\nexport function shadow(OrdersService: any) { return inject(OrdersService<string>); }\nexport const malformed = () => inject(OrdersService<>);\n`,
  });
  assert.deepEqual(summary(meta), ["unresolved @ src/app/a.ts:6", "no-extractor @ src/app/a.ts:7", "unresolved @ src/app/a.ts:8", "no-extractor @ src/app/a.ts:9"]);
  assert.deepEqual(meta.memberUses ?? [], []);
  const shadowedApi = await read({ [SERVICE]: SERVICE_SOURCE, "src/app/b.ts": `${CORE}import { OrdersService } from './orders.service';\nexport function run(inject: any) { return inject(OrdersService<string>); }\n` });
  assert.deepEqual(summary(shadowedApi), []);
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

test("a local a function takes from inject() is a binding of that function to the class it names", async () => {
  const meta = await read({
    [SERVICE]: SERVICE_SOURCE,
    "src/app/guard.ts": `${CORE}import { OrdersService } from './orders.service';\nexport const guard = () => {\n  const orders = inject(OrdersService);\n  orders.list();\n};\n`,
  });

  assert.deepEqual(meta.locals, [
    { owner: { path: "src/app/guard.ts", symbol: "guard", line: 3 }, local: "orders", holds: { class: { path: SERVICE, symbol: "OrdersService", line: 3 } } },
  ]);
});

test("a fixed field call identifies its own concrete member when source is complete", async () => {
  const files = [
    { path: "package.json", content: PACKAGE },
    { path: SERVICE, content: "export class OrdersService {\n  write() {}\n}\n" },
    { path: "src/app/a.ts", content: `${CORE}import { OrdersService } from './orders.service';\nexport class A {\n  store = new OrdersService();\n  run() { this.store.write(); }\n}\n` },
  ];
  const meta = await createAngularMetadataReader().read(files, { memberProofs: { completeSource: true } });
  assert.deepEqual(meta.memberUses, [{ owner: { path: "src/app/a.ts", symbol: "A", line: 3 }, receiver: { path: SERVICE, symbol: "OrdersService", line: 1 }, member: { path: SERVICE, symbol: "write", line: 2 }, reference: { file: "src/app/a.ts", line: 5, column: 11, name: "this.store.write", kind: "calls" } }]);
});

async function memberProofs(owner: string, target = "export class Store { write() {} }", extra: Record<string, string> = {}, enabled = true): Promise<AngularMetadata> {
  const files = { "package.json": PACKAGE, "src/store.ts": target, "src/owner.ts": `${CORE}import { Store } from './store';\n${owner}`, ...extra };
  return createAngularMetadataReader().read(Object.entries(files).map(([path, content]) => ({ path, content })), { memberProofs: { completeSource: enabled } });
}

const OWNER = "export class Owner { store = new Store(); run() { this.store.write(); } }";

test("member evidence requires complete source without changing existing origins", async () => {
  const files = [{ path: "package.json", content: PACKAGE }, { path: "src/store.ts", content: "export class Store { write() {} }" }, { path: "src/owner.ts", content: `import { Store } from './store'; ${OWNER}` }];
  const reader = createAngularMetadataReader();
  const old = await reader.read(files);
  const no = await reader.read(files, { memberProofs: { completeSource: false } });
  const yes = await reader.read(files, { memberProofs: { completeSource: true } });
  assert.deepEqual(no, { ...old, memberUses: [] });
  assert.deepEqual(yes.fields, old.fields);
  assert.equal(yes.memberUses?.length, 1);
});

test("member proof follows renamed imports and barrel exports", async () => {
  const meta = await memberProofs("import { Renamed as Alias } from './barrel'; export class Owner { store = new Alias(); run() { this.store.write(); } }", undefined, { "src/barrel.ts": "export { Store as Renamed } from './store';" });
  assert.deepEqual(meta.memberUses?.map((use) => [use.receiver.path, use.receiver.symbol, use.member.symbol]), [["src/store.ts", "Store", "write"]]);
});

test("only unique own concrete instance methods can be proved", async () => {
  for (const target of [
    "export class Store { static write() {} }",
    "export class Store { get write() { return () => {}; } }",
    "class Base { write() {} } export class Store extends Base {}",
    "export class Store { write(x: string): void; write(x?: string) {} }",
    "export class Store {}",
  ]) assert.deepEqual((await memberProofs(OWNER, target)).memberUses, [], target);
});

test("optional or computed receiver and member calls cannot prove a member", async () => {
  for (const expression of ["this.store?.write()", "this.store.write?.()", "this.store['write']()", "this['store'].write()"])
    assert.deepEqual((await memberProofs(`export class Owner { store = new Store(); run() { ${expression}; } }`)).memberUses, [], expression);
});

test("arrow callbacks preserve lexical this but ordinary functions do not", async () => {
  const meta = await memberProofs("export class Owner { store = new Store(); run() { const a = () => this.store.write(); function b() { this.store.write(); } } }");
  assert.equal(meta.memberUses?.length, 1);
});

test("receiver mutations or escapes invalidate its member proof", async () => {
  for (const change of ["this.store = new Store()", "this.store ||= new Store()", "[this.store] = [new Store()]", "this['store'] = new Store()", "this.store.write = () => {}", "this.store['write'] = () => {}", "consume(this.store)", "return this", "this.store.write.bind(this.store)"])
    assert.deepEqual((await memberProofs(`export class Owner { store = new Store(); run() { this.store.write(); ${change}; } }`)).memberUses, [], change);
});

test("member mutation elsewhere in the project prevents proof", async () => {
  for (const change of ["x.write = () => {}", "x.write++", "[x.write] = [fn]", "x[key] = fn"])
    assert.deepEqual((await memberProofs(OWNER, undefined, { "src/mutate.ts": change })).memberUses, [], change);
});

test("malformed or unowned source cannot authorize member evidence", async () => {
  assert.deepEqual((await memberProofs(OWNER, "export class Store { write() {} }", { "src/broken.ts": "const x = ;" })).memberUses, []);
  assert.deepEqual((await memberProofs(OWNER, undefined, { "other/package.json": "{}", "other/file.ts": "export const x = 1;" })).memberUses, []);
  assert.deepEqual((await memberProofs(OWNER, undefined, { "src/store.ts": "" })).memberUses, []);
});

test("provider substitution and unknown provider token prevent proof", async () => {
  for (const provider of ["[{ provide: Store, useClass: Other }]", "[{ provide: Store, useExisting: Other }]", "[{ provide: Store, useFactory: () => null }]", "[{ provide: Store, useValue: {} }]", "[{ provide: choose(), useValue: {} }]"])
    assert.deepEqual((await memberProofs(OWNER, undefined, { "src/providers.ts": `import { Store } from './store'; const providers = ${provider};` })).memberUses, [], provider);
});

test("a file-wide shadow of a constructor or namespace import prevents proof", async () => {
  for (const suffix of ["function f(Store: unknown) {}", "function f() { const Store = 1; }"])
    assert.deepEqual((await memberProofs(`${OWNER} ${suffix}`)).memberUses, [], suffix);
  const meta = await memberProofs("import * as ns from './store'; export class Owner { store = new ns.Store(); run() { this.store.write(); } } function f(ns: unknown) {}");
  assert.deepEqual(meta.memberUses, []);
});

test("a local class must be a unique top-level binding", async () => {
  const local = "class Local { write() {} } export class Owner { store = new Local(); run() { this.store.write(); } }";
  assert.equal((await memberProofs(local)).memberUses?.length, 1);
  assert.deepEqual((await memberProofs(`${local} function f(Local: unknown) {}`)).memberUses, []);
  assert.deepEqual((await memberProofs("function f() { class Local { write() {} } class Owner { store = new Local(); run() { this.store.write(); } } } ")).memberUses, []);
});

test("prototype aliases and reflective mutations prevent member proofs", async () => {
  for (const mutation of ["const proto = Store.prototype;", "Object.assign(x, { write() {} });", "Object.defineProperty(x, 'write', { value: fn });", "Reflect.set(x, 'write', fn);"])
    assert.deepEqual((await memberProofs(OWNER, undefined, { "src/mutate.ts": `import { Store } from './store'; ${mutation}` })).memberUses, [], mutation);
});

test("shadowing an import in a barrel prevents its use as member proof", async () => {
  const owner = "import { Alias } from './barrel'; export class Owner { store = new Alias(); run() { this.store.write(); } }";
  const meta = await memberProofs(owner, undefined, { "src/barrel.ts": "import { Store } from './store'; function f(Store: unknown) {} export { Store as Alias };" });
  assert.deepEqual(meta.memberUses, []);
});

test("an unshadowed namespace injection can prove a class member", async () => {
  const meta = await memberProofs("import * as ns from './store'; export class Owner { store = inject(ns.Store); run() { this.store.write(); } }");
  assert.equal(meta.memberUses?.length, 1);
});

test("shadowing Angular inject prevents field and member proof", async () => {
  const meta = await memberProofs("export class Owner { store = inject(Store); run() { this.store.write(); } } function f(inject: unknown) {}");
  assert.equal(meta.fields.length, 0);
  assert.deepEqual(meta.memberUses, []);
});

test("an object method has its own this even when nested inside a class method", async () => {
  const meta = await memberProofs("export class Owner { store = new Store(); run() { const obj = { call() { this.store.write(); } }; } }");
  assert.deepEqual(meta.memberUses, []);
});

test("a call made by a field initializer does not prove an initialized receiver", async () => {
  const meta = await memberProofs("export class Owner { result = this.store.write(); store = new Store(); }");
  assert.deepEqual(meta.memberUses, []);
});

test("a computed member can conflict with an apparently unique implementation", async () => {
  const meta = await memberProofs(OWNER, "export class Store { write() {} ['write']() {} }");
  assert.deepEqual(meta.memberUses, []);
});

test("a shadowed provider token cannot authorize a fixed injected member", async () => {
  const meta = await memberProofs("export class Owner { store = inject(Store); run() { this.store.write(); } }", undefined, { "src/providers.ts": "import { Store } from './store'; function f(Store: unknown) {} const providers = [{ provide: Store, useValue: {} }];" });
  assert.deepEqual(meta.memberUses, []);
});

test("a constructor parameter property can use its existing fixed injection origin", async () => {
  const meta = await memberProofs("@Injectable() export class Owner { constructor(private store: Store) {} run() { this.store.write(); } }");
  assert.equal(meta.memberUses?.length, 1);
});

test("a receiver class that escapes its own instance cannot prove a stable member", async () => {
  const meta = await memberProofs(OWNER, "export class Store { constructor() { register(this); } write() {} }");
  assert.deepEqual(meta.memberUses, []);
});

test("computed prototype access can escape an implementation", async () => {
  const meta = await memberProofs(OWNER, undefined, { "src/mutate.ts": "import { Store } from './store'; const proto = Store['prototype']; share(proto);" });
  assert.deepEqual(meta.memberUses, []);
});

test("a decorated method cannot be assumed to retain its source implementation", async () => {
  assert.deepEqual((await memberProofs(OWNER, "export class Store { @replace write() {} }")).memberUses, []);
});

test("sources in another Angular project cannot hide provider substitutions", async () => {
  const meta = await memberProofs(OWNER, undefined, { "other/package.json": PACKAGE, "other/provider.ts": "import { Store } from '../src/store'; const p = [{ provide: Store, useValue: {} }];" });
  assert.deepEqual(meta.memberUses, []);
});

test("same-line member calls retain distinct one-based UTF-16 positions", async () => {
  const line = "export class Owner { store = new Store(); run() { '😀'; this.store.write(); this.store.write(); } }";
  const meta = await memberProofs(line);
  const first = line.indexOf("this.store.write");
  const second = line.indexOf("this.store.write", first + 1);
  assert.deepEqual(meta.memberUses?.map((use) => [use.reference.line, use.reference.column]), [[3, first + 1], [3, second + 1]]);
});

test("namespace and named expression bindings can shadow a constructor import", async () => {
  for (const shadow of ["namespace Store {}", "const f = function Store() {};", "const C = class Store {};", "function f<Store>() {}"])
    assert.deepEqual((await memberProofs(`${OWNER} ${shadow}`)).memberUses, [], shadow);
});

test("iteration assignments can mutate a member or an unknown computed property", async () => {
  for (const mutation of ["for (x.write of values) {}", "for (x[key] in values) {}"])
    assert.deepEqual((await memberProofs(OWNER, undefined, { "src/mutate.ts": mutation })).memberUses, [], mutation);
});

test("an escaped reflective mutator prevents member proofs", async () => {
  const meta = await memberProofs(OWNER, undefined, { "src/mutate.ts": "const mutate = Object.assign; mutate(x, { write() {} });" });
  assert.deepEqual(meta.memberUses, []);
});


test("a derived field replacement cannot certify the inherited receiver target", async () => {
  const owner = "export class Owner { store = new Store(); run() { this.store.write(); } }";
  assert.equal((await memberProofs(owner)).memberUses?.length, 1);
  for (const body of ["store = new Other();", "get store() { return new Other(); }", "constructor() { super(); this.store = new Other(); }"])
    assert.deepEqual((await memberProofs(owner, undefined, { "src/child.ts": `import { Owner as Base } from './owner'; class Other { write() {} } export class Child extends Base { ${body} }` })).memberUses, [], body);
});

test("a parameter shadowing Angular inject does not create an injection relation", async () => {
  const meta = await read({ [SERVICE]: SERVICE_SOURCE, "src/app/shadow.ts": `${CORE}import { OrdersService } from './orders.service';\nexport function guard(inject: (value: unknown) => unknown) { return inject(OrdersService); }\n` });
  assert.equal(meta.findings.some((finding) => finding.status === "complete" && finding.value.kind === "injects"), false);
});

test("inline injection proves the actual own method at its exact call site", async () => {
  const line = "export function provideAuthLifecycle() { '😀'; return inject(Store).write(); }";
  const meta = await memberProofs(line, "export class Store {\n  write() {}\n}");
  assert.deepEqual(meta.memberUses, [{ owner: { path: "src/owner.ts", symbol: "provideAuthLifecycle", line: 3 }, receiver: { path: "src/store.ts", symbol: "Store", line: 1 }, member: { path: "src/store.ts", symbol: "write", line: 2 }, reference: { file: "src/owner.ts", line: 3, column: line.indexOf("inject(Store)") + 1, name: "inject().write", kind: "calls" } }]);
  assert.deepEqual(meta.locals, []);
});

test("a shadowed token cannot produce a class injection or inline proof", async () => {
  const meta = await memberProofs("export function run(Store: unknown) { return inject(Store).write(); }");
  assert.equal(meta.findings.some((finding) => finding.status === "complete" && finding.value.to.symbol === "Store"), false);
  assert.ok(meta.findings.some((finding) => finding.status === "unknown"));
  assert.deepEqual(meta.memberUses, []);
});

test("inline calls resolve aliases and namespaces through barrels and retain separate same-line positions", async () => {
  const line = "export const lifecycle = () => { '😀'; di(Alias).write(); ng.inject(ns.Other).run(); };";
  const meta = await memberProofs(`import { inject as di } from '@angular/core'; import * as ng from '@angular/core'; import { Renamed as Alias } from './barrel'; import * as ns from './barrel';\n${line}`, undefined, { "src/barrel.ts": "export { Store as Renamed } from './store'; export { Other } from './other';", "src/other.ts": "export class Other { run() {} }" });
  assert.deepEqual(meta.memberUses?.map((use) => [use.owner.symbol, use.receiver.symbol, use.member.symbol, use.reference.name, use.reference.line, use.reference.column]), [
    ["lifecycle", "Store", "write", "di().write", 4, line.indexOf("di(Alias)") + 1],
    ["lifecycle", "Other", "run", "ng.inject().run", 4, line.indexOf("ng.inject(ns.Other)") + 1],
  ]);
  assert.equal(meta.locals.length, 0);
});

test("inline evidence requires explicit complete-source eligibility", async () => {
  const files = [{ path: "package.json", content: PACKAGE }, { path: "src/store.ts", content: "export class Store { write() {} }" }, { path: "src/owner.ts", content: `${CORE}import { Store } from './store'; export function run() { inject(Store).write(); }` }];
  const reader = createAngularMetadataReader();
  for (const options of [undefined, { memberProofs: { completeSource: false } }]) {
    const meta = await reader.read(files, options);
    assert.deepEqual(meta.memberUses, options === undefined ? undefined : []);
    assert.ok(meta.findings.some((finding) => finding.status === "complete" && finding.value.to.symbol === "Store"));
  }
  assert.equal((await reader.read(files, { memberProofs: { completeSource: true } })).memberUses?.length, 1);
});

test("shadowed API and namespace roots never produce Angular relations", async () => {
  const cases = [
    `${CORE}import { Store } from './store'; export function run(inject: any) { inject(Store).write(); }`,
    `import * as ng from '@angular/core'; import { Store } from './store'; export function run(ng: any) { ng.inject(Store).write(); }`,
    `import { Store } from './store'; function inject(x: unknown) { return x; } export function run() { inject(Store); }`,
  ];
  for (const content of cases) {
    const meta = await memberProofs('', undefined, { "src/owner.ts": content });
    assert.equal(meta.findings.some((finding) => finding.status === "complete"), false);
    assert.deepEqual(meta.memberUses, []);
  }
});

test("a paths override of Angular core is not an Angular API binding", async () => {
  const meta = await memberProofs("export function run() { inject(Store).write(); }", undefined, { "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@angular/core": ["src/fake-core.ts"] } } }), "src/fake-core.ts": "export function inject(x: unknown) { return x; }" });
  assert.equal(meta.findings.some((finding) => finding.status === "complete"), false);
  assert.deepEqual(meta.memberUses, []);
});

test("shadowed class and namespace tokens stay unknown with and without member proofs", async () => {
  for (const [code, extra] of [
    ["export function run(Store: any) { inject(Store).write(); }", {}],
    ["import * as ns from './store'; export function run(ns: any) { inject(ns.Store).write(); }", {}],
    ["class Local { write() {} } export function run(Local: any) { inject(Local).write(); }", {}],
  ] as const) for (const enabled of [true, false]) {
    const meta = await memberProofs(code, undefined, extra, enabled);
    assert.equal(meta.findings.some((finding) => finding.status === "complete" && ["Store", "Local"].includes(finding.value.to.symbol)), false);
    assert.ok(meta.findings.some((finding) => finding.status === "unknown"));
    assert.equal(meta.memberUses?.length ?? 0, 0);
  }
});

test("unsupported inline forms retain no member evidence", async () => {
  for (const expression of ["inject(Store, { optional: true }).write()", "inject(Store)?.write()", "inject(Store).write?.()", "inject(Store)['write']()", "inject(Store).write().next()", "inject(select()).write()", "inject<Store>(Store).write()", "inject(Store).write<number>()", "(inject(Store).write()).next()", "ng?.inject(Store).write()"])
    assert.deepEqual((await memberProofs(`import * as ng from '@angular/core'; export function run() { ${expression}; }`)).memberUses, [], expression);
});

test("inline proof refuses substituted, unstable and unavailable implementations", async () => {
  for (const target of ["export class Store { static write() {} }", "class Base { write() {} } export class Store extends Base {}", "export abstract class Store { write() {} }", "export class Store { @replace write() {} }", "export class Store { constructor() { register(this); } write() {} }", "export class Store { ['write']() {} }", "export class Store {}"])
    assert.deepEqual((await memberProofs("export function run() { inject(Store).write(); }", target)).memberUses, [], target);
  for (const provider of ["useClass: Other", "useExisting: Other", "useFactory: () => null", "useValue: {}"])
    assert.deepEqual((await memberProofs("export function run() { inject(Store).write(); }", undefined, { "src/providers.ts": `import { Store } from './store'; const providers = [{ provide: Store, ${provider} }];` })).memberUses, [], provider);
  assert.deepEqual((await memberProofs("export function run() { inject(Store).write(); }", undefined, { "src/mutate.ts": "x.write = () => {};" })).memberUses, []);
  assert.deepEqual((await memberProofs("export function run() { inject(Store).write(); }", "")).memberUses, []);
});

test("an unshadowed local class can be injected inline", async () => {
  const meta = await memberProofs("class Local { write() {} } export function run() { inject(Local).write(); }");
  assert.equal(meta.memberUses?.[0]?.receiver.symbol, "Local");
});

test("optional or wrapped token expressions do not establish inline member identity", async () => {
  for (const token of ["(Store)", "ns?.Store", "Store as any"]) {
    const meta = await memberProofs(`import * as ns from './store'; export function run() { inject(${token}).write(); }`);
    assert.deepEqual(meta.memberUses, [], token);
  }
});

test("inline class and variable initializer owners retain their own symbols", async () => {
  const meta = await memberProofs("export class Owner { run() { inject(Store).write(); } }\nexport const initial = inject(Store).write();");
  assert.deepEqual(meta.memberUses?.map((use) => [use.owner.symbol, use.owner.line, use.reference.name]), [["Owner", 3, "inject().write"], ["initial", 4, "inject().write"]]);
});

test("shadowed injected tokens cannot create field or local origins", async () => {
  const meta = await memberProofs("export class Owner { store = inject(Store); } export function run(Store: any) { const local = inject(Store); }");
  assert.deepEqual(meta.fields, []);
  assert.deepEqual(meta.locals, []);
  assert.ok(meta.findings.some((finding) => finding.status === "unknown"));
});

test("an instantiated token relation does not grant inline member proof", async () => {
  const meta = await memberProofs("export function run() { inject(Store<string>).write(); }");
  assert.ok(meta.findings.some((finding) => finding.status === "complete" && finding.value.to.symbol === "Store"));
  assert.deepEqual(meta.memberUses, []);
});

for (const [form, code] of [
  ["field", "export class Holder { store = inject(Store<string>); run() { this.store.write(); } }"],
  ["constructor property", "@Injectable() export class Holder { constructor(@Inject(Store<string>) private store: Store) {} run() { this.store.write(); } }"],
  ["constant local", "export function run() { const store = inject(Store<string>); store.write(); }"],
] as const) {
  test(`an instantiated token in a ${form} establishes a relation without receiver identity`, async () => {
    const meta = await memberProofs(code);
    assert.ok(meta.findings.some((finding) => finding.status === "complete" && finding.value.to.symbol === "Store"), code);
    assert.deepEqual(meta.memberUses, [], code);
    assert.deepEqual(meta.fields, [], code);
    assert.deepEqual(meta.locals, [], code);
  });
}

test("an inline InjectionToken or malformed project does not prove a member", async () => {
  const token = await memberProofs("export const token = new InjectionToken('t'); export function run() { inject(token).write(); }");
  assert.deepEqual(token.memberUses, []);
  assert.ok(token.findings.some((finding) => finding.status === "complete" && finding.value.to.symbol === "token"));
  const malformed = await memberProofs("export function run() { inject(Store).write(); }", undefined, { "src/broken.ts": "const value = ;" });
  assert.deepEqual(malformed.memberUses, []);
});

test("an inline token reached through a shadowed barrel is not member proof", async () => {
  const meta = await memberProofs("import { Alias } from './barrel'; export function run() { inject(Alias).write(); }", undefined, { "src/barrel.ts": "import { Store } from './store'; function f(Store: unknown) {} export { Store as Alias };" });
  assert.deepEqual(meta.memberUses, []);
});

test("inline proofs are withheld for unknown providers and derived member replacement", async () => {
  const owner = "export function run() { inject(Store).write(); }";
  for (const extra of [
    { "src/providers.ts": "const providers = [{ provide: choose(), useValue: {} }];" },
    { "src/derived.ts": "import { Store } from './store'; class Derived extends Store { write = () => {}; }" },
    { "other/package.json": "{}", "other/file.ts": "const unknown = true;" },
  ]) assert.deepEqual((await memberProofs(owner, undefined, extra)).memberUses, []);
});


test("an existing const injection local uses the exact member proof channel", async () => {
  const meta = await memberProofs("export function boot() { const svc = inject(Store); return svc.write(); }");
  assert.equal(meta.memberUses?.length, 1);
  assert.equal(meta.memberUses?.[0]?.reference.name, "svc.write");
  assert.equal(meta.memberUses?.[0]?.owner.symbol, "boot");
});

test("a reassigned or shadowed injection local is not an exact member target", async () => {
  for (const source of [
    "export function boot() { let svc = inject(Store); svc = other; svc.write(); }",
    "export function boot() { const svc = inject(Store); run((svc: unknown) => svc.write()); }",
    "export function boot() { const svc = inject(Store); svc.write = other; svc.write(); }",
    "export function boot() { const svc = inject(Store); publish(svc); svc.write(); }",
    "export function boot() { svc.write(); const svc = inject(Store); }",
    "export class Owner { one() { const svc = inject(Store); svc.write(); } two() { svc.write(); } }",
    "export function boot() { const svc = inject(Store); eval('mutate(svc)'); svc.write(); }",
  ]) assert.deepEqual((await memberProofs(source)).memberUses, [], source);
});

test("const local calls retain potential sites despite unrelated mutation and overloads", async () => {
  const source = "export function boot() { const svc = inject(Store); svc.write(); }";
  for (const complete of [true, false]) {
    const meta = await memberProofs(source, "export class Store { write(x: string): void; write(x: number): void; write(x: any) {} }", { "src/other.ts": "Object.assign({}, {});" }, complete);
    assert.deepEqual(meta.memberUses, []);
    assert.deepEqual(meta.locals[0]?.calls?.map(({ name }) => name), ["svc.write"]);
  }
});

test("unsafe local bindings do not admit potential call sites", async () => {
  for (const source of [
    "export function boot() { let svc = inject(Store); svc = other; svc.write(); }",
    "export function boot() { const svc = inject(Store); run((svc: any) => svc.write()); }",
    "export function boot() { const svc = inject(Store); publish(svc); svc.write(); }",
    "export function boot() { svc.write(); const svc = inject(Store); }",
    "export function boot() { const svc = inject(Store); eval('mutate(svc)'); svc.write(); }",
    "export function boot() { const svc = inject(Store); with (other) { svc.write(); } }",
  ]) assert.deepEqual((await memberProofs(source)).locals.flatMap((local) => local.calls ?? []), [], source);
});

test("unrelated unknown providers do not suppress potential local sites; known substitutions do", async () => {
  const owner = "export function boot() { const svc = inject(Store); svc.write(); }";
  const unknown = await memberProofs(owner, undefined, { "src/providers.ts": "const providers = [{ provide: unknownToken(), useValue: 1 }];" });
  assert.equal(unknown.locals[0]?.calls?.length, 1);
  assert.deepEqual(unknown.memberUses, []);
  const replaced = await memberProofs(owner, undefined, { "src/providers.ts": "import { Store } from './store'; const providers = [{ provide: Store, useValue: {} }];" });
  assert.deepEqual(replaced.locals, []);
});
