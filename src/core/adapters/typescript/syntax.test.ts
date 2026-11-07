import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { sourceTree } from "./source-tree.ts";
import { thisClass, unwrapped } from "./syntax.ts";

function treeOf(content: string): ts.SourceFile {
  return sourceTree({ path: "src/probe.ts", content }, ts.ScriptTarget.Latest, ts.ScriptKind.TS);
}

function first<T extends ts.Node>(tree: ts.SourceFile, matches: (node: ts.Node) => node is T): T {
  let found: T | undefined;
  const visit = (node: ts.Node): void => {
    if (found === undefined && matches(node)) found = node;
    if (found === undefined) node.forEachChild(visit);
  };
  visit(tree);
  assert.ok(found !== undefined);
  return found;
}

const isThis = (node: ts.Node): node is ts.ThisExpression => node.kind === ts.SyntaxKind.ThisKeyword;

test("unwrapped takes off every parenthesis, type assertion, satisfies and non-null around a value, in any nesting", () => {
  const tree = treeOf("const value = ((<Order>(order as unknown))! satisfies object);");
  const initializer = first(tree, ts.isVariableDeclaration).initializer!;

  const inner = unwrapped(initializer);

  assert.ok(ts.isIdentifier(inner));
  assert.equal(inner.text, "order");
});

for (const [place, body, owner] of [
  ["an instance method", "m() { this.a; }", "Page"],
  ["an arrow function inside an instance method", "m() { return () => this.a; }", "Page"],
  ["an instance property initializer", "a = this.b;", "Page"],
  ["a constructor", "constructor() { this.a; }", "Page"],
  ["a function expression inside a method", "m() { return function () { return this.a; }; }", undefined],
  ["an object literal's method inside a method", "m() { return { n() { return this.a; } }; }", undefined],
  ["a static method", "static m() { this.a; }", undefined],
  ["a static property initializer", "static a = this.b;", undefined],
  ["a static block", "static { this.a; }", undefined],
] as const) {
  test(`thisClass in ${place} is ${owner ?? "no class"}`, () => {
    const tree = treeOf(`class Page {\n  ${body}\n}`);

    assert.equal(thisClass(first(tree, isThis))?.name?.text, owner);
  });
}
