import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Parser, type Tree } from "web-tree-sitter";
import { createJavaParser, createJavaTreeHolds } from "./java-parser.adapter.ts";

/** Native parses and the trees not freed yet. */
const native = { parses: 0, alive: new Set<Tree>() };
const parse = Parser.prototype.parse;

beforeEach(() => {
  native.parses = 0;
  native.alive.clear();
  Parser.prototype.parse = function (this: Parser, ...args: Parameters<Parser["parse"]>) {
    const tree = parse.apply(this, args);
    if (tree !== null) {
      native.parses++;
      native.alive.add(tree);
      const free = tree.delete.bind(tree);
      tree.delete = () => {
        native.alive.delete(tree);
        free();
      };
    }
    return tree;
  };
});

afterEach(() => {
  Parser.prototype.parse = parse;
});

test("a source with a syntax error is a fault at its line, never a throw", async () => {
  const parser = await createJavaParser();

  const result = parser.parse({ path: "src/a/A.java", content: "package a;\n\nclass A {\n  void run( {\n}\n" });

  assert.deepEqual(result, { ok: false, fault: { kind: "syntax-error", line: 4 } });
});

test("sources an open hold kept parse once by content, and their tree outlives every reader's dispose until the hold is released", async () => {
  const holds = createJavaTreeHolds();
  const parser = await createJavaParser(holds);
  const hold = holds.open();
  const [first, same] = hold.keep([{ path: "src/A.java", content: "class A {}" }, { path: "other/A.java", content: "class A {}" }]);

  const read = parser.parse(first!);
  assert.ok(read.ok);
  read.value.dispose();
  const again = parser.parse(same!);
  assert.ok(again.ok);
  assert.equal(again.value.root.id, read.value.root.id);
  assert.deepEqual([native.parses, native.alive.size], [1, 1]);

  hold.release();
  assert.equal(native.alive.size, 0);
});

test("a source no open hold kept, the original of a kept copy, one kept by a released hold, or by another hold, gets a tree of its own", async () => {
  const holds = createJavaTreeHolds();
  const parser = await createJavaParser(holds);
  const original = { path: "src/A.java", content: "class A {}" };
  const theirs = holds.open();
  const [hers] = theirs.keep([original]);
  const mine = holds.open();
  const [kept] = mine.keep([original]);
  const parsedHers = parser.parse(hers!);
  assert.ok(parsedHers.ok);

  const own = parser.parse(original);
  assert.ok(own.ok);
  own.value.dispose();
  assert.deepEqual([native.parses, native.alive.size], [2, 1]);
  const parsedMine = parser.parse(kept!);
  assert.ok(parsedMine.ok);
  assert.notEqual(parsedMine.value.root.tree, parsedHers.value.root.tree);
  mine.release();
  assert.deepEqual([native.parses, native.alive.size], [3, 1]);
  const afterRelease = parser.parse(kept!);
  assert.ok(afterRelease.ok);
  afterRelease.value.dispose();
  assert.deepEqual([native.parses, native.alive.size], [4, 1]);
  theirs.release();
  assert.equal(native.alive.size, 0);
});
