import assert from "node:assert/strict";
import test from "node:test";
import { createJavaImportsReader } from "../core/adapters/spring/java-imports.adapter.ts";
import { createJavaParser } from "../core/adapters/tree-sitter/java-parser.adapter.ts";
import { createModuleDependenciesReader } from "../core/adapters/typescript/module-dependencies.adapter.ts";
import { fakeCodeGraph, fakeNode, type FakeEdge, type FakeNode } from "../core/application/impact/fake-code-graph.testing.ts";
import { createOutlineQueries, type OutlineQueriesDeps } from "../core/application/outline/outline-queries.ts";
import type { OutlineFile } from "../core/domain/outline/outline-fact.ts";
import type { Cut } from "../core/domain/shared/fact.ts";
import type { SourceFile } from "../core/ports/entrypoint-extractor.port.ts";
import type { ModuleDependenciesReader } from "../core/ports/module-dependencies.port.ts";

const USE = "src/use.ts";
const DEFS: SourceFile = { path: "src/defs.ts", content: "export const one = 1;\nexport function two() {}\n" };
const MANIFEST: SourceFile = { path: "package.json", content: JSON.stringify({ dependencies: { zod: "1" } }) };
const USE_NODES: FakeNode[] = [fakeNode("use", "file", USE, 1, 9), fakeNode("use.run", "function", USE, 8, 9, "run")];

/** The outline of `src/use.ts` read through the real module readers over `sources`, on a fake graph. */
async function outlineOf(content: string, options: { nodes?: FakeNode[]; edges?: FakeEdge[]; sources?: SourceFile[]; file?: string; readers?: ModuleDependenciesReader[] } = {}): Promise<{ status: string; file: OutlineFile | undefined; cuts: readonly Cut[] }> {
  const file = options.file ?? USE;
  const sources = [{ path: file, content }, ...(options.sources ?? [DEFS, MANIFEST])];
  const store = fakeCodeGraph(options.nodes ?? USE_NODES, options.edges ?? []);
  const deps = {
    vcs: { resolveCommit: async () => ({ ok: true, value: "a".repeat(40) }), exportCommit: async () => ({ ok: true, value: { files: sources.map(({ path }) => ({ path, blob: "1", written: true })), skipped: [] } }) },
    scratch: { create: async () => "/scratch/head", remove: async () => undefined },
    reader: { read: async () => sources },
    extractor: { extract: () => [] },
    digest: { of: (value: string) => `digest:${value}` },
    producer: { name: "ye-ast", version: "0.0.0" },
    matcher: { matches: () => true },
    graph: { index: async () => ({ ok: true, value: { filesIndexed: 1, filesSkipped: 0, filesErrored: 0, filesNotIndexed: [], versions: { codegraph: "fake", schema: 0, extraction: 0 } } }), open: () => ({ ok: true, value: store }) },
    engines: {},
    moduleReaders: options.readers ?? [createModuleDependenciesReader()],
  } as unknown as OutlineQueriesDeps;
  const answer = await createOutlineQueries(deps).outline({ repo: "/work/shop", repoId: "shop", revision: "HEAD", files: [file] });
  assert.ok(answer.ok && answer.value.status !== "unknown", JSON.stringify(answer));
  return { status: answer.value.status, file: answer.value.value.files?.[0], cuts: answer.value.status === "partial" ? answer.value.cuts : [] };
}

test("a package import is listed as external with every name it binds, even one nothing uses", async () => {
  const { status, file } = await outlineOf("import { z } from 'zod';\nimport type { ZodType as T } from 'zod';");
  assert.equal(status, "complete");
  assert.deepEqual(file?.imports, [
    { line: 1, endLine: 1, specifier: "zod", kind: "import", typeOnly: false, target: { kind: "external", module: "zod" }, bindings: [{ local: "z", imported: "z" }] },
    { line: 2, endLine: 2, specifier: "zod", kind: "import", typeOnly: true, target: { kind: "external", module: "zod" }, bindings: [{ local: "T", imported: "ZodType", typeOnly: true }] },
  ]);
});

test("a repository binding reaches the declaration the graph imports edge at its position names", async () => {
  const nodes = [...USE_NODES, fakeNode("two", "function", DEFS.path, 2, 2, "two")];
  const { status, file } = await outlineOf("import { two } from './defs';", { nodes, edges: [{ from: "use", to: "two", kind: "imports", line: 1, column: 9 }] });
  assert.equal(status, "complete");
  assert.deepEqual(file?.imports[0]?.bindings, [{ local: "two", imported: "two", declaration: { file: DEFS.path, name: "two", kind: "function", line: 2, endLine: 2 } }]);
});

test("a repository binding no edge proves makes the outline partial with one unresolved-link cut at its place", async () => {
  const { status, file, cuts } = await outlineOf("import { one } from './defs';");
  assert.equal(status, "partial");
  assert.deepEqual(file?.imports[0]?.bindings, [{ local: "one", imported: "one" }]);
  assert.deepEqual(cuts, [{ kind: "unresolved-link", at: ["src/use.ts:1 one"], reason: "unresolved" }]);
});

test("a namespace binding binds the module itself, so it reaches no declaration and is no cut", async () => {
  const { status, file } = await outlineOf("import * as defs from './defs';");
  assert.equal(status, "complete");
  assert.deepEqual(file?.imports[0]?.bindings, [{ local: "defs", imported: "*" }]);
});

test("a side-effect import is listed with the file it names and no binding", async () => {
  const { status, file } = await outlineOf("import './defs';");
  assert.equal(status, "complete");
  assert.deepEqual(file?.imports, [{ line: 1, endLine: 1, specifier: "./defs", kind: "import", typeOnly: false, target: { kind: "repository", file: DEFS.path }, bindings: [] }]);
});

test("runtime module references are listed with the file they name, or as unresolved when an expression names the module", async () => {
  const { file } = await outlineOf("export async function run(name: string) {\n  await import('./defs');\n  require('./defs');\n  await import(name);\n}");
  assert.deepEqual(file?.imports.map(({ line, form, specifier, target }) => ({ line, form, specifier, target })), [
    { line: 2, form: "dynamic-import", specifier: "./defs", target: { kind: "repository", file: DEFS.path } },
    { line: 3, form: "require", specifier: "./defs", target: { kind: "repository", file: DEFS.path } },
    { line: 4, form: "dynamic-import", specifier: undefined, target: { kind: "unresolved", reason: "a computed expression names the module" } },
  ]);
});

test("a requested source the module reader cannot parse is a no-extractor cut, so its empty imports never read as none", async () => {
  const { status, file, cuts } = await outlineOf("import { one } from './defs';\nexport function (");
  assert.equal(status, "partial");
  assert.deepEqual(file?.imports, []);
  assert.deepEqual(cuts, [{ kind: "no-extractor", at: [USE] }]);
});

test("a requested file no module reader reads is a no-extractor cut, so its empty imports never read as none", async () => {
  const { status, file, cuts } = await outlineOf("import { one } from './defs';", { readers: [createJavaImportsReader(await createJavaParser())] });
  assert.equal(status, "partial");
  assert.deepEqual(file?.imports, []);
  assert.deepEqual(cuts, [{ kind: "no-extractor", at: [USE] }]);
});

test("a Java import of a type the sources declare reaches that type's declaration, without any graph edge", async () => {
  const owner: SourceFile = { path: "src/app/owner/Owner.java", content: "package app.owner;\npublic class Owner {}\n" };
  const client = javaGraph("src/app/api/Client.java", "app.api", [{ id: "Client", kind: "class", line: 3 }]);
  const owners = javaGraph(owner.path, "app.owner", [{ id: "Owner", kind: "class", line: 2 }]);
  const { status, file } = await outlineOf("package app.api;\nimport app.owner.Owner;\nclass Client {}\n", { file: "src/app/api/Client.java", nodes: [...client.nodes, ...owners.nodes], edges: [...client.edges, ...owners.edges], sources: [owner], readers: [createModuleDependenciesReader(), createJavaImportsReader(await createJavaParser())] });
  assert.equal(status, "complete");
  assert.deepEqual(file?.imports, [{ line: 2, endLine: 2, specifier: "app.owner.Owner", kind: "import", typeOnly: false, target: { kind: "repository", file: owner.path }, bindings: [{ local: "Owner", imported: "Owner", declaration: { file: owner.path, name: "Owner", kind: "class", line: 2, endLine: 2 } }] }]);
});

/** The graph codegraph writes for a Java file: its package as a namespace that contains each type, and each type its members. */
function javaGraph(file: string, packageName: string, members: readonly { id: string; kind: string; line: number; in?: string }[]): { nodes: FakeNode[]; edges: FakeEdge[] } {
  const namespace = `${file}#${packageName}`;
  const nodes = [fakeNode(`${file}#file`, "file", file, 1, 9), fakeNode(namespace, "namespace", file, 1, 1, packageName), ...members.map(({ id, kind, line }) => fakeNode(`${file}#${id}`, kind, file, line, line, id.slice(id.lastIndexOf(".") + 1)))];
  const edges = members.map(({ id, in: container }): FakeEdge => ({ from: container === undefined ? namespace : `${file}#${container}`, to: `${file}#${id}`, kind: "contains" }));
  return { nodes, edges };
}

test("a Java static import of a member the named type only inherits reaches no declaration, even one of that name in the same file", async () => {
  const parent: SourceFile = { path: "app/Parent.java", content: "package app;\nclass Parent { public static int LIMIT = 1; }\n" };
  const owner: SourceFile = { path: "app/Owner.java", content: "package app;\nclass Owner extends Parent {}\nclass Other { public static int LIMIT = 2; }\n" };
  const client = javaGraph("app/Client.java", "app", [{ id: "Client", kind: "class", line: 3 }]);
  const owners = javaGraph(owner.path, "app", [{ id: "Owner", kind: "class", line: 2 }, { id: "Other", kind: "class", line: 3 }, { id: "Other.LIMIT", kind: "field", line: 3, in: "Other" }]);
  const parents = javaGraph(parent.path, "app", [{ id: "Parent", kind: "class", line: 2 }, { id: "Parent.LIMIT", kind: "field", line: 2, in: "Parent" }]);
  const { status, file, cuts } = await outlineOf("package app;\nimport static app.Owner.LIMIT;\nclass Client {}\n", {
    file: "app/Client.java",
    nodes: [...client.nodes, ...owners.nodes, ...parents.nodes],
    edges: [...client.edges, ...owners.edges, ...parents.edges],
    sources: [parent, owner],
    readers: [createJavaImportsReader(await createJavaParser())],
  });
  assert.equal(status, "partial");
  assert.deepEqual(file?.imports[0]?.bindings, [{ local: "LIMIT", imported: "LIMIT" }]);
  assert.deepEqual(cuts, [{ kind: "unresolved-link", at: ["app/Client.java:2 LIMIT"], reason: "unresolved" }]);
});

test("a Java import reaches the declaration at its qualified name from the file's top level, never a nested one ending the same", async () => {
  const owner: SourceFile = { path: "app/Owner.java", content: "package app;\nclass Owner {}\nclass Other {\n  public static int LIMIT = 2;\n  static class Owner { static int LIMIT = 3; }\n}\n" };
  const client = javaGraph("app/Client.java", "app", [{ id: "Client", kind: "class", line: 4 }]);
  const owners = javaGraph(owner.path, "app", [
    { id: "Owner", kind: "class", line: 2 },
    { id: "Other", kind: "class", line: 3 },
    { id: "Other.LIMIT", kind: "field", line: 4, in: "Other" },
    { id: "Other.Owner", kind: "class", line: 5, in: "Other" },
    { id: "Other.Owner.LIMIT", kind: "field", line: 5, in: "Other.Owner" },
  ]);
  const { file } = await outlineOf("package app;\nimport static app.Owner.LIMIT;\nimport static app.Other.LIMIT;\nclass Client {}\n", {
    file: "app/Client.java",
    nodes: [...client.nodes, ...owners.nodes],
    edges: [...client.edges, ...owners.edges],
    sources: [owner],
    readers: [createJavaImportsReader(await createJavaParser())],
  });
  assert.deepEqual(file?.imports.map(({ bindings }) => bindings[0]?.declaration), [undefined, { file: owner.path, name: "LIMIT", kind: "field", line: 4, endLine: 4 }]);
});
