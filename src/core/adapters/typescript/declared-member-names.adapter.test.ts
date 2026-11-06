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
  assert.deepEqual(await read(["const table = { plain: run };"], "src/a.d.ts"), { names: [], functionValueCalls: [], callables: [] });
  assert.deepEqual(await read(["class A { void run() {} }"], "src/A.java"), { names: [], functionValueCalls: [], callables: [] });
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
