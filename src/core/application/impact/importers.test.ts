import { test } from "node:test";
import assert from "node:assert/strict";
import { readImporters } from "./importers.ts";
import { fakeCodeGraph, fakeNode } from "../navigation/fake-code-graph.testing.ts";

test("module forms report dynamic and type consumers separately from static imports", async () => {
  const store = fakeCodeGraph([fakeNode("t", "file", "src/target.ts", 1, 1)], [], []);
  const edge = { line: 1, endLine: 1, specifier: "./target", kind: "import" as const, typeOnly: false, target: { kind: "repository" as const, file: "src/target.ts" }, bindings: [] };
  const result = await readImporters(store, ["src/target.ts"], [], { files: [], unread: [], dependencies: [
    { ...edge, file: "src/static.ts" },
    { ...edge, file: "src/dynamic.ts", form: "dynamic-import" },
    { ...edge, file: "src/type.ts", form: "type-query" },
  ] });
  assert.deepEqual(result.files[0]?.importers, ["src/static.ts"]);
  assert.deepEqual(result.files[0]?.dynamicImporters, ["src/dynamic.ts"]);
  assert.deepEqual(result.files[0]?.typeImporters, ["src/type.ts"]);
  assert.deepEqual(result.files[0]?.users, ["src/dynamic.ts", "src/static.ts", "src/type.ts"]);
});

test("an indexed JSON file is not claimed unless the module reader certifies it as a resource", async () => {
  const store = fakeCodeGraph([fakeNode("j", "file", "src/data.json", 1, 1)], [], []);
  const result = await readImporters(store, ["src/data.json"], [], { files: [], unread: [], dependencies: [] });
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.unheld, ["src/data.json"]);
});

test("a call the base binds into the file makes its file a user, and one it only attributes to the file a namer", async () => {
  const store = fakeCodeGraph([fakeNode("load", "function", "src/target.ts", 1, 3), fakeNode("bound", "function", "src/bound.ts", 1, 3), fakeNode("guess", "function", "src/guess.ts", 1, 3)], [], []);
  const [bound, guess, load] = store.symbolsInFiles(["src/bound.ts", "src/guess.ts", "src/target.ts"]);
  const reference = (body: typeof guess) => ({ from: body!.id, name: "load", kind: "calls", file: body!.file, line: 2, column: 2, candidates: [] });
  const into = async () => ({
    edges: [{ edge: { source: bound!.id, target: load!.id, kind: "calls", line: 2, column: 2, confidence: null }, source: bound!, target: load! }],
    attributed: [{ node: load!, call: { body: guess!, reference: reference(guess) } }],
  });

  const result = await readImporters(store, ["src/target.ts"], [], undefined, undefined, into as never);

  assert.deepEqual(result.files.map(({ users, unresolvedNamers, places }) => ({ users, unresolvedNamers, places })), [{ users: ["src/bound.ts"], unresolvedNamers: ["src/guess.ts"], places: [{ file: "src/bound.ts", line: 2 }, { file: "src/guess.ts", line: 2 }] }]);
});

test("every relationship keeps the line it was read at", async () => {
  const store = fakeCodeGraph([fakeNode("target", "function", "src/target.ts", 1), fakeNode("caller", "function", "src/caller.ts", 1), fakeNode("missing", "function", "src/missing.ts", 1)], [
    { from: "caller", to: "target", kind: "calls", line: 12 }, { from: "caller", to: "target", kind: "calls", line: 12 },
    { from: "missing", to: "target", kind: "calls" }, { from: "missing", to: "target", kind: "calls", line: 0 },
  ]);
  const references = [{ file: "src/caller.ts", name: "target", kind: "calls", line: 11 }, { file: "src/missing.ts", name: "target", kind: "calls", line: null as unknown as number }];
  const modules = { files: [], unread: [], dependencies: [{ file: "src/caller.ts", line: 8, endLine: 8, specifier: "./target", kind: "import" as const, typeOnly: false, target: { kind: "repository" as const, file: "src/target.ts" }, bindings: [] }] };
  const result = await readImporters(store, ["src/target.ts"], references, modules);
  assert.deepEqual(result.files[0]?.places, [{ file: "src/caller.ts", line: 8 }, { file: "src/caller.ts", line: 11 }, { file: "src/caller.ts", line: 12 }]);
  assert.deepEqual(result.files[0]?.unresolvedNamers, ["src/caller.ts", "src/missing.ts"]);
  const empty = await readImporters(store, ["src/target.ts"], references.slice(1));
  const withoutLines = fakeCodeGraph([fakeNode("target", "file", "src/target.ts", 1), fakeNode("missing", "function", "src/missing.ts", 1)], [{ from: "missing", to: "target", kind: "calls" }]);
  assert.equal((await readImporters(withoutLines, ["src/target.ts"], references.slice(1))).files[0]?.places, undefined);
  assert.ok(empty.files[0]?.users.includes("src/missing.ts"));
});
