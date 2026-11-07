import assert from "node:assert/strict";
import test from "node:test";
import { createTypeScriptMemberNames } from "./declared-member-names.adapter.ts";

const read = (lines: readonly string[], path = "src/a.ts") => createTypeScriptMemberNames().memberNames({ path, content: lines.join("\n") });
const names = async (lines: readonly string[]) => (await read(lines)).names;

test("every object-literal key is a name, at any depth and in any context, and a spread is none", async () => {
  assert.deepEqual(await names([
    "make({ argMethod() {}, argKey: 1 });",
    "export const outer = { inner: { nestedMethod() {} } };",
    "function factory() { return { returnedMethod() {} }; }",
    "const alias = { aliasKey: run, shorthand, ...rest, 'quoted': 1, get getter() { return 1; }, set setter(v) {} };",
  ]), ["aliasKey", "argKey", "argMethod", "getter", "inner", "nestedMethod", "quoted", "returnedMethod", "setter", "shorthand"]);
});

test("a property assigned through a dot or a literal index is a name", async () => {
  assert.deepEqual(await names(["target.assigned = run;", "this.field.deep = 1;", "target['indexed'] = run;"]), ["assigned", "deep", "indexed"]);
});

test("class members, constructor parameter properties and enum members are names; a declare-only member is not", async () => {
  assert.deepEqual(await names([
    "class Holder {",
    "  table = { fieldMethod() {} };",
    "  declare onlyDeclared: number;",
    "  constructor(private readonly injected: number, plain: number) {}",
    "  run() {}",
    "  abstract area(): number;",
    "}",
    "enum Color { Red }",
  ]), ["Red", "area", "fieldMethod", "injected", "run", "table"]);
});

test("a name only a type, an interface, a type literal or an ambient declaration holds is none", async () => {
  assert.deepEqual(await names([
    "interface Shape { interfaceOnly(): void; prop: number }",
    "type Deep = { outer: { deepOnly(): void } };",
    "function take(options: { paramOnly(): void }): void {}",
    "declare const ambient: { ambientOnly(): void };",
    "declare class Lib { libOnly(): void }",
  ]), []);
});

test("a module's exported value names are names: renamed, re-exported, a namespace re-export and default; a type-only export is none", async () => {
  assert.deepEqual(await names([
    "export { local as renamed };",
    "export { other as reexported } from './other';",
    "export * as space from './space';",
    "export default run;",
    "export type { Shape as typeAlias } from './shape';",
    "export { type Box as boxAlias } from './box';",
  ]), ["default", "reexported", "renamed", "space"]);
  assert.deepEqual(await names(["export default function main() {}"]), ["default"]);
  assert.deepEqual(await names(["export = run;"]), []);
});

test("a member call is a function-value call when its own file binds the receiver to a function value: an initializer, an assignment, a function declaration or a function type", async () => {
  assert.deepEqual((await read([
    "const fn = () => 1;",
    "let handler: () => void;",
    "let later; later = function () {};",
    "function helper(): void {}",
    "export function run(cb: () => void): void {",
    "  fn.call(undefined);",
    "  handler.apply(undefined, []);",
    "  later.call(undefined);",
    "  helper.bind(undefined);",
    "  cb.call(undefined);",
    "}",
  ])).functionValueCalls, [
    { line: 6, receiver: "fn", member: "call" },
    { line: 7, receiver: "handler", member: "apply" },
    { line: 8, receiver: "later", member: "call" },
    { line: 9, receiver: "helper", member: "bind" },
    { line: 10, receiver: "cb", member: "call" },
  ]);
});

test("a value is a function value through every wrapper at any depth, either branch of a conditional or a logical operator, and the last of a comma or an assignment", async () => {
  assert.deepEqual((await read([
    "type F = () => number;",
    "export function run(flag: boolean, other: unknown, plain: number): void {",
    "  const wrapped = ((<F>(() => 1)) as F satisfies F)!;",
    "  const chosen = flag ? other : (flag ? function () { return 1; } : other);",
    "  const fallback = other ?? (() => 1);",
    "  const either = (() => 1) || other;",
    "  const both = flag && (() => 1);",
    "  const last = (plain, () => 1);",
    "  let assigned; const chained = (assigned = () => 1);",
    "  const neither = flag ? other : plain;",
    "  const dropped = (() => 1, plain);",
    "  let compound: unknown; compound ??= () => 1;",
    "  let ored: unknown; ored ||= () => 1;",
    "  let anded: unknown = other; anded &&= () => 1;",
    "  wrapped.call(undefined);",
    "  chosen.call(undefined);",
    "  fallback.call(undefined);",
    "  either.call(undefined);",
    "  both.call(undefined);",
    "  last.call(undefined);",
    "  chained.call(undefined);",
    "  neither.call(undefined);",
    "  dropped.call(undefined);",
    "  compound.call(undefined);",
    "  ored.call(undefined);",
    "  anded.call(undefined);",
    "}",
  ])).functionValueCalls, [
    { line: 15, receiver: "wrapped", member: "call" },
    { line: 16, receiver: "chosen", member: "call" },
    { line: 17, receiver: "fallback", member: "call" },
    { line: 18, receiver: "either", member: "call" },
    { line: 19, receiver: "both", member: "call" },
    { line: 20, receiver: "last", member: "call" },
    { line: 21, receiver: "chained", member: "call" },
    { line: 24, receiver: "compound", member: "call" },
    { line: 25, receiver: "ored", member: "call" },
    { line: 26, receiver: "anded", member: "call" },
  ]);
});

test("a receiver bound to a non-function value, shadowed by a parameter, imported, or written nowhere in the file is no function-value call", async () => {
  assert.deepEqual((await read([
    "import { imported } from './elsewhere';",
    "const fn = () => 1;",
    "const data = [1];",
    "export function run(fn: { call(): void }): void {",
    "  fn.call();",
    "  data.map(String);",
    "  imported.call(undefined);",
    "  unknown.call(undefined);",
    "}",
  ])).functionValueCalls, []);
});

test("a var or a nested var-declared loop variable binds at its function or module scope across nested blocks, never across a function, static block or namespace boundary", async () => {
  assert.deepEqual((await read([
    "if (ready) { var top = () => 1; }",
    "top.call(undefined);",
    "export function run(): void {",
    "  try { if (ready) { var cb = () => 1; } } finally {}",
    "  for (var each = () => 1; ; ) break;",
    "  cb.call(undefined);",
    "  each.call(undefined);",
    "  const inner = function () { var hidden = () => 1; };",
    "  hidden.call(undefined);",
    "}",
    "class Holder { static { if (ready) { var held = () => 1; } held.call(undefined); } }",
    "namespace Space { if (ready) { var spaced = () => 1; } spaced.call(undefined); }",
    "held.call(undefined);",
    "spaced.call(undefined);",
  ])).functionValueCalls, [
    { line: 2, receiver: "top", member: "call" },
    { line: 6, receiver: "cb", member: "call" },
    { line: 7, receiver: "each", member: "call" },
    { line: 11, receiver: "held", member: "call" },
    { line: 12, receiver: "spaced", member: "call" },
  ]);
});

test("let, const, class and a function declaration bind in their block, a switch's in its whole case block, and the innermost binding shadows", async () => {
  assert.deepEqual((await read([
    "const fn = () => 1;",
    "const data = { call() {} };",
    "export function run(kind: number): void {",
    "  { let fn = { call() {} }; fn.call(); }",
    "  { class fn {} fn.call(undefined); }",
    "  { let data = () => 1; data.call(undefined); }",
    "  { function local() {} }",
    "  local.call(undefined);",
    "  switch (kind) { case 1: let cased = () => 1; break; case 2: cased.call(undefined); }",
    "  fn.call(undefined);",
    "}",
  ])).functionValueCalls, [
    { line: 6, receiver: "data", member: "call" },
    { line: 9, receiver: "cased", member: "call" },
    { line: 10, receiver: "fn", member: "call" },
  ]);
});

test("a parameter binds in its function and a catch variable in its catch block, each shadowing an outer function value", async () => {
  assert.deepEqual((await read([
    "const fn = () => 1;",
    "export function run(fn: { call(): void }): void {",
    "  fn.call();",
    "  try {} catch (fn) { fn.call(); }",
    "  const caught = () => 1;",
    "  try {} catch (caught) { caught.call(); }",
    "  caught.call(undefined);",
    "}",
  ])).functionValueCalls, [{ line: 7, receiver: "caught", member: "call" }]);
});

test("a receiver holds a function value when any declaration of its binding does, and through every wrapper around it", async () => {
  assert.deepEqual((await read([
    "export function run(): void {",
    "  var f;",
    "  { var f = () => 1; }",
    "  f.call(undefined);",
    "  const g = () => 1;",
    "  (g).call(undefined);",
    "  (g as () => number).call(undefined);",
    "  (g satisfies () => number).call(undefined);",
    "  (<() => number>g).call(undefined);",
    "  g!.call(undefined);",
    "}",
  ])).functionValueCalls, [6, 4, 7, 8, 9, 10].sort((a, b) => a - b).map((line) => ({ line, receiver: line === 4 ? "f" : "g", member: "call" })));
});

test("this.<field> binds to the field of the enclosing class, through an arrow; an object-literal method or a function rebinds this", async () => {
  assert.deepEqual((await read([
    "class Holder {",
    "  private fn = () => 1;",
    "  private typed?: () => void;",
    "  private plain = 1;",
    "  private assigned;",
    "  constructor(private readonly injected: () => void) { this.assigned = () => 2; }",
    "  run(): void {",
    "    this.fn.call(this);",
    "    this.typed.call(this);",
    "    this.plain.toFixed();",
    "    const later = () => this.assigned.call(this);",
    "    this.injected.call(this);",
    "    const o = { k() { this.fn.call(this); } };",
    "    function inner() { this.fn.call(this); }",
    "  }",
    "}",
  ])).functionValueCalls, [
    { line: 8, receiver: "fn", member: "call" },
    { line: 9, receiver: "typed", member: "call" },
    { line: 11, receiver: "assigned", member: "call" },
    { line: 12, receiver: "injected", member: "call" },
  ]);
});

test("a computed key or index adds no name; a literal one adds its name", async () => {
  assert.deepEqual(await names(["const table = { [key]: run, ['literal']: run };", "target[name] = run;", "target['indexed'] = run;"]), ["indexed", "literal"]);
});

test("a file that is not a TypeScript source declares none", async () => {
  assert.deepEqual(await read(["const table = { plain: run };"], "src/a.d.ts"), { names: [], functionValueCalls: [], callables: [], receiverBindings: [] });
  assert.deepEqual(await read(["class A { void run() {} }"], "src/A.java"), { names: [], functionValueCalls: [], callables: [], receiverBindings: [] });
});

test("functions, overload signatures and ambient functions are callables that no subtype overrides, with a body only when written", async () => {
  assert.deepEqual((await read([
    "export function pick(a: string): string;",
    "export function pick(a: any): any { return a; }",
    "declare function ambient(): void;",
  ])).callables, [
    { name: "pick", start: 1, nameLine: 1, body: false, overridable: false },
    { name: "pick", start: 2, nameLine: 2, body: true, overridable: false },
    { name: "ambient", start: 3, nameLine: 3, body: false, overridable: false },
  ]);
});

test("class methods are overridable unless static or private, abstract ones have no body, and an interface method signature has none", async () => {
  assert.deepEqual((await read([
    "abstract class Shape {",
    "  @dec()",
    "  run(): void {}",
    "  abstract area(): number;",
    "  static make(): void {}",
    "  private hidden(): void {}",
    "  #secret(): void {}",
    "}",
    "interface Port { send(): void; size: number }",
  ])).callables, [
    { name: "run", start: 2, nameLine: 3, body: true, overridable: true },
    { name: "area", start: 4, nameLine: 4, body: false, overridable: true },
    { name: "make", start: 5, nameLine: 5, body: true, overridable: false },
    { name: "hidden", start: 6, nameLine: 6, body: true, overridable: false },
    { name: "#secret", start: 7, nameLine: 7, body: true, overridable: false },
    { name: "send", start: 9, nameLine: 9, body: false, overridable: true },
  ]);
});

test("a local bound by every store to one class is held by the one class declaration the file binds its name to, or constructed where its imported or unbound name is rooted", async () => {
  assert.deepEqual((await read([
    "import { Store } from './store';",
    "class Local {}",
    "const Factory = function () {};",
    "export function run(): void {",
    "  const local = new Local();",
    "  local.save();",
    "  let store;",
    "  store = new Store();",
    "  store.save();",
    "  const made = new Factory();",
    "  made.save();",
    "  const merged = new Merged();",
    "  merged.save();",
    "}",
    "class Merged {}",
    "namespace Merged { export const value = 1; }",
  ])).receiverBindings, [
    { line: 6, column: 3, receiver: "local", member: "save", holds: { kind: "declared", name: "Local", line: 2 } },
    { line: 9, column: 3, receiver: "store", member: "save", holds: { kind: "constructed", name: "Store", line: 8, column: 11 } },
  ]);
});

test("a direct eval, strict or not, in the scope of a local or in a scope inside it unbinds it, and one elsewhere does not", async () => {
  assert.deepEqual((await read([
    "export function same(): void {",
    "  let a = [];",
    "  eval('a = other');",
    "  a.push(1);",
    "}",
    "export function nested(): void {",
    "  const b = [];",
    "  (() => eval('b'))();",
    "  b.push(1);",
    "}",
    "export function elsewhere(): void {",
    "  const c = [];",
    "  c.push(1);",
    "}",
    "export function unrelated(): void {",
    "  eval('1');",
    "}",
  ])).receiverBindings.map(({ receiver }) => receiver), ["c"]);
});

test("a receiver declared once with one type, a parameter, a local no store binds, a field or a constructor property, is held by that annotation", async () => {
  assert.deepEqual((await read([
    "import { Router } from '@angular/router';",
    "export class Page {",
    "  private label: string = '';",
    "  constructor(private router: Router) {}",
    "  go(list: readonly number[], cache: (Map<string, number>) | null): void {",
    "    this.router.navigate([]);",
    "    this.label.trim();",
    "    list.at(0);",
    "    cache.get('a');",
    "    let pending: Router;",
    "    pending.navigate([]);",
    "    const items: unknown[] = [];",
    "    items.push(1);",
    "  }",
    "}",
  ])).receiverBindings, [
    { line: 6, column: 5, receiver: "router", member: "navigate", holds: { kind: "annotated", type: "Router", line: 4, column: 31 } },
    { line: 7, column: 5, receiver: "label", member: "trim", holds: { kind: "annotated", type: "string", line: 3, column: 18 } },
    { line: 8, column: 5, receiver: "list", member: "at", holds: { kind: "annotated", type: "Array", line: 5, column: 21 } },
    { line: 9, column: 5, receiver: "cache", member: "get", holds: { kind: "annotated", type: "Map", line: 5, column: 39 } },
    { line: 11, column: 5, receiver: "pending", member: "navigate", holds: { kind: "annotated", type: "Router", line: 10, column: 18 } },
    { line: 13, column: 5, receiver: "items", member: "push", holds: { kind: "literal", type: "Array" } },
  ]);
  assert.deepEqual((await read(["export class Label {", "  private text: string;", "  #mark: string;", "  set(value: string): void { this.text = value; this.text.trim(); this.#mark.trim(); }", "}"])).receiverBindings, [
    { line: 4, column: 49, receiver: "text", member: "trim", holds: { kind: "annotated", type: "string", line: 2, column: 17 } },
    { line: 4, column: 67, receiver: "#mark", member: "trim", holds: { kind: "annotated", type: "string", line: 3, column: 10 } },
  ]);
});

test("a destructured, untyped, any, union, function-typed, getter or static receiver, one declared twice or exported, one that escapes or is written through, or one a direct eval or a with body may write is held by no annotation", async () => {
  assert.deepEqual((await read([
    "import { Router } from '@angular/router';",
    "class Repo { navigate(): void {} }",
    "export class Page {",
    "  private get current(): Router { return undefined!; }",
    "  private shared: Router;",
    "  private static shared: Router;",
    "  private static only: Router;",
    "  run({ nested }: { nested: Router }, plain, loose: any, either: Router | Repo, call: () => void): void {",
    "    nested.navigate([]);",
    "    plain.navigate([]);",
    "    loose.navigate([]);",
    "    either.navigate([]);",
    "    call.call(undefined);",
    "    this.current.navigate([]);",
    "    this.shared.navigate([]);",
    "  }",
    "  static reset(): void { this.only.navigate([]); }",
    "}",
    "export function scoped(target: Router, scope: object): void {",
    "  with (scope) { target = other; }",
    "  target.navigate([]);",
    "}",
  ])).receiverBindings, []);
  assert.deepEqual((await read(["import { Router } from '@angular/router';", "var twice: Router;", "var twice: Router;", "twice.navigate([]);"])).receiverBindings, []);
  assert.deepEqual((await read([
    "import { keep } from './keep';",
    "export function escapes(param: string[]): string[] {",
    "  const passed: string[] = [];",
    "  keep(passed);",
    "  passed.push('a');",
    "  const patched: string[] = [];",
    "  patched.push = keep;",
    "  patched.push('a');",
    "  param.push('a');",
    "  shared.push('a');",
    "  return param;",
    "}",
    "export const shared: string[] = [];",
    "export class Holder {",
    "  private passed: string[] = [];",
    "  private patched: string[] = [];",
    "  go(): void {",
    "    keep(this.passed);",
    "    this.passed.push('a');",
    "    this.patched.push = keep;",
    "    this.patched.push('a');",
    "  }",
    "}",
  ])).receiverBindings, []);
  assert.deepEqual((await read([
    "import { Router } from '@angular/router';",
    "export function patched(router: Router): void {",
    "  eval('router = other');",
    "  router.navigate([]);",
    "}",
    "export class Patched {",
    "  private router: Router;",
    "  go(): void { eval('this.router = other'); this.router.navigate([]); }",
    "}",
  ])).receiverBindings, []);
});

test("a public, protected or unmodified field, which a subclass, a superclass method or another module can write, is held by no annotation", async () => {
  assert.deepEqual((await read([
    "import { keep } from './keep';",
    "export class Page { cache: Map<string, string> = new Map(); run(): void { this.cache.get('k'); } }",
    "export class Sub extends Page { patch(): void { this.cache.get = keep; } }",
  ])).receiverBindings, []);
  assert.deepEqual((await read([
    "import { keep } from './keep';",
    "class Base { patch(): void { const self = this as any; self.cache.get = keep; } }",
    "export class Page extends Base { protected cache: Map<string, string> = new Map(); run(): void { super.patch(); this.cache.get('k'); } }",
  ])).receiverBindings, []);
  assert.deepEqual((await read([
    "import { keep } from './keep';",
    "export class Page { public cache: Map<string, string> = new Map(); run(): void { this.cache.get('k'); } }",
    "new Page().cache.get = keep;",
  ])).receiverBindings, []);
});

test("a private field the class reaches through another receiver than its own `this` is held by no annotation", async () => {
  assert.deepEqual((await read([
    "import { keep } from './keep';",
    "export class Page {",
    "  private cache: Map<string, string> = new Map();",
    "  run(): void { this.cache.get('k'); }",
    "  static patch(page: Page): void { page.cache.get = keep; }",
    "}",
    "export class Held {",
    "  #cache: Map<string, string> = new Map();",
    "  run(): void { this.#cache.get('k'); }",
    "  copy(other: Held): void { other.#cache.get = keep; }",
    "}",
    "export class Spread {",
    "  private cache: Map<string, string> = new Map();",
    "  run(): void { this.cache.get('k'); }",
    "  copy(other: Spread): void { const { cache } = other; cache.get = keep; }",
    "}",
    "export class Indexed {",
    "  private cache: Map<string, string> = new Map();",
    "  run(): void { this.cache.get('k'); }",
    "  copy(other: Indexed): void { other['cache'].get = keep; }",
    "}",
    "export class Nested {",
    "  private cache: Map<string, string> = new Map();",
    "  run(): void { this.cache.get('k'); const patch = function (this: Nested) { this.cache.get = keep; }; keep(patch); }",
    "}",
  ])).receiverBindings, []);
});

test("a private field of a class that indexes, destructures or reflects on another receiver by a key no literal states is held by no annotation", async () => {
  const reaches = [
    "static mutate(other: Page0): void { const key = 'cache'; other[key].get = keep; }",
    "static mutate(other: Page1): void { other[`cache`].get = keep; }",
    "static mutate(other: Page2, key: string): void { other[String(key)].get = keep; }",
    "static mutate(other: Page3, key: 'cache'): void { const { [key]: found } = other; found.get = keep; }",
    "static mutate(other: Page4): void { const { ...rest } = other; keep(rest); }",
    "static mutate(other: Page5, key: string): void { Reflect.get(other, key).get = keep; }",
    "static mutate(other: Page6, key: string): void { Reflect.set(other, key, keep); }",
    "static mutate(other: Page7, key: string): void { Object.defineProperty(other, key, { value: keep }); }",
    "run2(): void { const patch = function (this: Page8) { const key = 'cache'; this[key].get = keep; }; keep(patch); }",
  ];
  const classes = reaches.map((reach, index) => `export class Page${index} { private cache: Map<string, string> = new Map(); run(): void { this.cache.get('k'); } ${reach} }`);
  assert.deepEqual((await read(["import { keep } from './keep';", ...classes])).receiverBindings, []);
  assert.deepEqual((await read([
    "import { keep } from './keep';",
    "export class Page { constructor(private cache: Map<string, string>) {} run(): void { this.cache.get('k'); } static mutate(other: Page): void { const key = 'cache'; other[key].get = keep; } }",
  ])).receiverBindings, []);
  assert.deepEqual((await read([
    "import { keep } from './keep';",
    "export class Page { private cache: Map<string, string> = new Map(); run(): void { this.cache.get('k'); } static mutate(other: { [key: string]: Map<string, string> }): void { other['labels'].get = keep; other[0].get = keep; Reflect.get(other, 'labels'); } }",
  ])).receiverBindings.map(({ receiver }) => receiver), ["cache"]);
});

test("a field of a class whose own `this` escapes it, is computed into, assigned into or destructured is held by no annotation", async () => {
  const escapes = [
    "const self = this; self.r.navigate = keep;",
    "this['r'].navigate = keep;",
    "Object.assign(this, { r: { navigate: keep } });",
    "keep(this);",
    "const copy = { ...this }; keep(copy);",
    "const { r } = this; r.navigate = keep;",
    "const self = (): Page => this; self().r.navigate = keep;",
  ];
  const classes = escapes.map((escape, index) => `export class Page${index} { private r: Router; run(): void { ${escape} this.r.navigate([]); } }`);
  assert.deepEqual((await read(["import { Router } from '@angular/router';", "import { keep } from './keep';", ...classes])).receiverBindings, []);
  assert.deepEqual((await read(["import { Router } from '@angular/router';", "export class Page { private r: Router; run(): Page { this.r.navigate([]); return this; } }"])).receiverBindings, []);
});
