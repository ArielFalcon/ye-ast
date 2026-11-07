import { strict as assert } from "node:assert";
import { test } from "node:test";
import ts from "typescript";
import { sourceTree } from "./source-tree.ts";

test("reuses only trees with matching source and parser options", () => {
  const file = { path: "a.ts", content: "const x = 1" };
  const parse = (kind = ts.ScriptKind.TS) => sourceTree(file, ts.ScriptTarget.Latest, kind);
  const first = parse();
  assert.equal(parse(), first);
  assert.notEqual(parse(ts.ScriptKind.TSX), first);
  assert.notEqual(sourceTree(file, ts.ScriptTarget.ES2022, ts.ScriptKind.TS), first);
  file.content = "const x = 2";
  assert.notEqual(parse(), first);
  const changed = parse();
  file.path = "b.ts";
  assert.notEqual(parse(), changed);
});

test("one shared tree serves every reader, so it carries parent pointers", () => {
  const tree = sourceTree({ path: "a.ts", content: "const x = 1" }, ts.ScriptTarget.Latest, ts.ScriptKind.TS);
  assert.equal(tree.statements[0]!.parent, tree);
});

test("another file object with the same path and content reuses the tree, as an unchanged file of two revisions does", () => {
  const base = { path: "a.ts", content: "export const x = 1" };
  const tree = sourceTree(base, ts.ScriptTarget.Latest, ts.ScriptKind.TS);
  assert.equal(sourceTree({ ...base }, ts.ScriptTarget.Latest, ts.ScriptKind.TS), tree);
  assert.notEqual(sourceTree({ ...base, content: "export const x = 2" }, ts.ScriptTarget.Latest, ts.ScriptKind.TS), tree);
  assert.notEqual(sourceTree({ ...base, path: "b.ts" }, ts.ScriptTarget.Latest, ts.ScriptKind.TS), tree);
});
