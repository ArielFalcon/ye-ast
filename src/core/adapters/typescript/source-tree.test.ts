import { strict as assert } from "node:assert";
import { test } from "node:test";
import ts from "typescript";
import { sourceTree } from "./source-tree.ts";

test("reuses only trees with matching source and parser options", () => {
  const file = { path: "a.ts", content: "const x = 1" };
  const parse = (parents: boolean, kind = ts.ScriptKind.TS) => sourceTree(file, ts.ScriptTarget.Latest, parents, kind);
  const first = parse(true);
  assert.equal(parse(true), first);
  assert.notEqual(parse(false), first);
  assert.notEqual(parse(true, ts.ScriptKind.TSX), first);
  assert.notEqual(sourceTree(file, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS), first);
  assert.notEqual(sourceTree({ ...file }, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), first);
  file.content = "const x = 2";
  assert.notEqual(parse(true), first);
  const changed = parse(true);
  file.path = "b.ts";
  assert.notEqual(parse(true), changed);
});
