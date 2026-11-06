import { test } from "node:test";
import assert from "node:assert/strict";
import { readImporters } from "./importers.ts";
import { fakeCodeGraph, fakeNode } from "./fake-code-graph.testing.ts";

test("module forms report dynamic and type consumers separately from static imports", () => {
  const store = fakeCodeGraph([fakeNode("t", "file", "src/target.ts", 1, 1)], [], []);
  const edge = { line: 1, endLine: 1, specifier: "./target", kind: "import" as const, typeOnly: false, target: { kind: "repository" as const, file: "src/target.ts" }, bindings: [] };
  const result = readImporters(store, ["src/target.ts"], [], { files: [], unread: [], dependencies: [
    { ...edge, file: "src/static.ts" },
    { ...edge, file: "src/dynamic.ts", form: "dynamic-import" },
    { ...edge, file: "src/type.ts", form: "type-query" },
  ] });
  assert.deepEqual(result.files[0]?.importers, ["src/static.ts"]);
  assert.deepEqual(result.files[0]?.dynamicImporters, ["src/dynamic.ts"]);
  assert.deepEqual(result.files[0]?.typeImporters, ["src/type.ts"]);
  assert.deepEqual(result.files[0]?.users, ["src/dynamic.ts", "src/static.ts", "src/type.ts"]);
});

test("an indexed JSON file is not claimed unless the module reader certifies it as a resource", () => {
  const store = fakeCodeGraph([fakeNode("j", "file", "src/data.json", 1, 1)], [], []);
  const result = readImporters(store, ["src/data.json"], [], { files: [], unread: [], dependencies: [] });
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.unheld, ["src/data.json"]);
});
