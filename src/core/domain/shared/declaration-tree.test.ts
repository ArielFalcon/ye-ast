import assert from "node:assert/strict";
import test from "node:test";
import { declarationPath, declarationTree, innermostAt, selectedBySymbol, type TreeDeclaration } from "./declaration-tree.ts";

function declaration(id: string, name: string, startLine: number, endLine: number): TreeDeclaration {
  return { id, name, startLine, endLine };
}

const DECLARATIONS = [
  declaration("ns", "com.shop", 1, 1),
  declaration("A", "A", 3, 20),
  declaration("A.m", "m", 4, 6),
  declaration("A.Inner", "Inner", 8, 12),
  declaration("A.Inner.m", "m", 9, 10),
  declaration("XA", "XA", 22, 30),
  declaration("XA.m", "m", 23, 25),
];
const CONTAINMENT = [
  { source: "ns", target: "A" },
  { source: "ns", target: "XA" },
  { source: "A", target: "A.m" },
  { source: "A", target: "A.Inner" },
  { source: "A.Inner", target: "A.Inner.m" },
  { source: "XA", target: "XA.m" },
];

function selected(tree: ReturnType<typeof declarationTree>, symbol: string): string[] {
  return selectedBySymbol(tree, symbol).map(declarationPath);
}

test("a dotted symbol selects only the declaration its named container holds directly, matched at whole names", () => {
  const tree = declarationTree(DECLARATIONS, CONTAINMENT);
  assert.deepEqual(selected(tree, "A.m"), ["com.shop.A.m"]);
  assert.deepEqual(selected(tree, "com.shop.A.Inner.m"), ["com.shop.A.Inner.m"]);
});

test("a bare name selects every declaration of that name at any depth", () => {
  const tree = declarationTree(DECLARATIONS, CONTAINMENT);
  assert.deepEqual(selected(tree, "m"), ["com.shop.A.m", "com.shop.A.Inner.m", "com.shop.XA.m"]);
});

test("a declaration no containment pair places is a root, so a dotted symbol cannot reach it through a span", () => {
  const tree = declarationTree([declaration("A", "A", 1, 20), declaration("route", "get", 5, 5)], []);
  assert.deepEqual(selected(tree, "A.get"), []);
  assert.deepEqual(selected(tree, "get"), ["get"]);
});

test("a line selects the innermost declaration the tree places around it, even under a container whose span ends before it", () => {
  const tree = declarationTree(DECLARATIONS, CONTAINMENT);
  assert.deepEqual(innermostAt(tree, 9).map(declarationPath), ["com.shop.A.Inner.m"]);
  assert.deepEqual(innermostAt(tree, 7).map(declarationPath), ["com.shop.A"]);
  assert.deepEqual(innermostAt(tree, 21), []);
});
