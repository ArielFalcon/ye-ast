import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeclarationModel, AmbiguousDeclaration } from "./declaration-model.ts";
import { fakeCodeGraph, fakeNode } from "./fake-code-graph.testing.ts";
import type { DeclaredDeclaration } from "../../ports/declared-member-names.port.ts";

const FILE = "src/a.ts";
const declared = (name: string, line: number, container?: number): DeclaredDeclaration => ({
  name, kind: "method", invoked: true,
  span: { start: { line, column: 2 }, end: { line, column: 18 } },
  ...(container === undefined ? {} : { container: { line: container, column: 0 } }),
});

test("syntax joins the index identity and proven containment without a file node or duplicate member", async () => {
  const store = fakeCodeGraph([fakeNode("file", "file", FILE, 1, 20), fakeNode("A", "class", FILE, 1, 9), fakeNode("m", "method", FILE, 3, 3)], [
    { from: "file", to: "A", kind: "contains" }, { from: "A", to: "m", kind: "contains" },
  ]);
  let reads = 0;
  const model = createDeclarationModel({ store, declarationsIn: async () => (reads++, [declared("m", 3, 1), declared("n", 5, 1)]) });
  const tree = await model.tree(FILE);
  assert.deepEqual(tree.map(({ declaration, children }) => [declaration.id, children.map(({ declaration }) => [declaration.id, declaration.path])]), [
    ["index:A", [["index:m", "A.m"], ["syntax:src/a.ts:5:2", "A.n"]]],
  ]);
  assert.equal((await model.select(FILE, "A.m"))[0]?.symbol?.id, "m");
  assert.equal((await model.select(FILE, "A.n"))[0]?.symbol, undefined);
  assert.deepEqual((await model.ownersOf(FILE, { line: 5, column: 3 })).map(({ name }) => name), ["n", "A"]);
  assert.deepEqual((await model.ownersOf(FILE, { line: 5, column: 18 })).map(({ name }) => name), ["A"]);
  assert.equal(reads, 1);
});

test("duplicate paths report both declarations while unproven containers receive no invented path", async () => {
  const store = fakeCodeGraph([fakeNode("A", "class", FILE, 1, 10)], []);
  const model = createDeclarationModel({ store, declarationsIn: async () => [declared("n", 3, 1), declared("n", 5, 1), declared("hidden", 7, 6)] });
  await assert.rejects(model.select(FILE, "A.n"), (error: unknown) => error instanceof AmbiguousDeclaration && error.declarations.map(({ startLine }) => startLine).join(",") === "3,5");
  assert.equal((await model.list(FILE)).find(({ name }) => name === "hidden")?.path, undefined);
  assert.deepEqual(await model.select(FILE, "hidden"), []);
});

test("a constructor missing from the index never merges into its same-named class", async () => {
  const store = fakeCodeGraph([fakeNode("A", "class", FILE, 1, 8)], []);
  const model = createDeclarationModel({ store, declarationsIn: async () => [declared("A", 3, 1)] });
  assert.deepEqual((await model.list(FILE)).map(({ path, symbol }) => [path, symbol?.kind]), [["A", "class"], ["A.A", undefined]]);
});

test("parser headers preceding indexed starts still join the same callable and its container", async () => {
  const store = fakeCodeGraph([
    { ...fakeNode("run", "function", FILE, 1, 5), startColumn: 7, endColumn: 1 },
    { ...fakeNode("nested", "function", FILE, 3, 4, "run"), startColumn: 2, endColumn: 3 },
    { ...fakeNode("Box", "class", FILE, 7, 12), startColumn: 7, endColumn: 1 },
  ], [{ from: "run", to: "nested", kind: "contains" }]);
  const model = createDeclarationModel({ store, declarationsIn: async () => [
    { name: "run", kind: "function", invoked: true, span: { start: { line: 1, column: 0 }, end: { line: 5, column: 1 } } },
    { name: "n", kind: "method", invoked: true, container: { line: 7, column: 0 }, span: { start: { line: 9, column: 2 }, end: { line: 10, column: 3 } } },
  ] });
  assert.equal((await model.select(FILE, "run"))[0]?.id, "index:run");
  assert.equal((await model.select(FILE, "run"))[0]?.invoked, true);
  assert.equal((await model.select(FILE, "Box.n"))[0]?.path, "Box.n");
});

test("indexed overloads retain the existing declaration-set target semantics", async () => {
  const store = fakeCodeGraph([fakeNode("A", "class", FILE, 1, 8), fakeNode("first", "method", FILE, 3, 3, "m"), fakeNode("second", "method", FILE, 5, 5, "m")], [
    { from: "A", to: "first", kind: "contains" }, { from: "A", to: "second", kind: "contains" },
  ]);
  const model = createDeclarationModel({ store, declarationsIn: async () => [declared("m", 3, 1), declared("m", 5, 1)] });
  assert.deepEqual((await model.select(FILE, "A.m")).map(({ symbol }) => symbol?.id), ["first", "second"]);
});
