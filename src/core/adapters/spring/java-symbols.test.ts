import assert from "node:assert/strict";
import test from "node:test";
import type { Node } from "web-tree-sitter";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { isTypeDeclaration } from "./java-symbols.ts";

const SOURCE = [
  "class Outer {",
  "  interface Port {}",
  "  enum Kind { A }",
  "  record Pair(int a) {}",
  "  @interface Marker {}",
  "  Outer() {}",
  "  void run() { class Local {} }",
  "}",
].join("\n");

test("a type declaration is a class, an interface, an enum, a record or an annotation type, never a method or a constructor", async () => {
  const parsed = (await createJavaParser()).parse(SOURCE);
  assert.ok(parsed.ok);
  const declared: string[] = [];
  const visit = (node: Node): void => {
    if (isTypeDeclaration(node)) declared.push(node.childForFieldName("name")?.text ?? "");
    node.namedChildren.forEach(visit);
  };

  visit(parsed.value.root);
  parsed.value.dispose();

  assert.deepEqual(declared, ["Outer", "Port", "Kind", "Pair", "Marker", "Local"]);
});
