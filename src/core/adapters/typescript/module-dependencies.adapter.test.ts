import { test } from "node:test";
import assert from "node:assert/strict";
import { createModuleDependenciesReader } from "./module-dependencies.adapter.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";

const config: SourceFile = { path: "tsconfig.json", content: '{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["src/lib/*"]}}}' };
const manifest: SourceFile = { path: "package.json", content: '{"dependencies":{"pkg":"1"}}' };
const barrel: SourceFile = { path: "src/lib/index.ts", content: "export { item } from './item';" };
const item: SourceFile = { path: "src/lib/item.ts", content: "export const item = 1;" };

test("extracts ordered static evidence and resolves aliases, external packages and unknown modules", async () => {
  const source: SourceFile = { path: "src/use.ts", content: [
    "import '@lib/index';",
    "import type { Item } from '@lib/index';",
    "export { item as renamed } from '@lib/index';",
    "export * as items from '@lib/index';",
    "import data = require('pkg/sub');",
    "export * from 'missing';",
    "export { Item as renamed };",
  ].join("\n") };
  const reader = createModuleDependenciesReader();
  const result = await reader.extract([source, item, manifest, barrel, config]);
  assert.deepEqual(result.files.map(({ file }) => file), ["src/lib/index.ts", "src/lib/item.ts", "src/use.ts"]);
  assert.deepEqual(result.files.find(({ file }) => file === source.path), { file: source.path, statements: source.content.split("\n"), moduleOnly: true });
  assert.deepEqual(result.dependencies.filter(({ file }) => file === source.path).map(({ line, endLine, specifier, kind, typeOnly, target }) => ({ line, endLine, specifier, kind, typeOnly, target })), [
    { line: 1, endLine: 1, specifier: "@lib/index", kind: "import", typeOnly: false, target: { kind: "repository", file: "src/lib/index.ts" } },
    { line: 2, endLine: 2, specifier: "@lib/index", kind: "import", typeOnly: true, target: { kind: "repository", file: "src/lib/index.ts" } },
    { line: 3, endLine: 3, specifier: "@lib/index", kind: "reexport", typeOnly: false, target: { kind: "repository", file: "src/lib/index.ts" } },
    { line: 4, endLine: 4, specifier: "@lib/index", kind: "reexport", typeOnly: false, target: { kind: "repository", file: "src/lib/index.ts" } },
    { line: 5, endLine: 5, specifier: "pkg/sub", kind: "import", typeOnly: false, target: { kind: "external", module: "pkg" } },
    { line: 6, endLine: 6, specifier: "missing", kind: "reexport", typeOnly: false, target: { kind: "unresolved", reason: "missing matches no `paths` or `baseUrl` entry of tsconfig.json" } },
  ]);
  assert.deepEqual(result.unread, []);
  assert.deepEqual(await reader.extract([config, barrel, manifest, item, source]), result);
});

test("an unbound local export cannot certify a declaration-free module", async () => {
  const result = await createModuleDependenciesReader().extract([{ path: "src/index.ts", content: "export { Missing };" }]);
  assert.equal(result.files[0]?.moduleOnly, false);
  assert.deepEqual(result.unread, [{ file: "src/index.ts", reason: "no-extractor" }]);
});

test("test consumers are read when supplied by the snapshot", async () => {
  const result = await createModuleDependenciesReader().extract([item, { path: "src/use.spec.ts", content: "import { item } from './lib/item';" }]);
  assert.equal(result.dependencies.find(({ file }) => file === "src/use.spec.ts")?.target.kind, "repository");
});

test("export visibility belongs to the module surface but declaration bodies do not", async () => {
  const reader = createModuleDependenciesReader();
  const read = async (content: string) => (await reader.extract([{ path: "src/service.ts", content }])).files[0]!;
  const before = await read("export function send() { return 1; }");
  const bodyOnly = await read("export function send() { return 2; }");
  const hidden = await read("function send() { return 2; }");
  assert.deepEqual(before.statements, bodyOnly.statements);
  assert.notDeepEqual(before.statements, hidden.statements);
  assert.equal(before.moduleOnly, false);
});

test("export assignments preserve binding changes without treating function bodies as module headers", async () => {
  const reader = createModuleDependenciesReader();
  const surface = async (content: string) => (await reader.extract([{ path: "src/default.ts", content }])).files[0]!.statements;
  assert.deepEqual(await surface("export default () => 1;"), await surface("export default () => 2;"));
  assert.notDeepEqual(await surface("export default first;"), await surface("export default second;"));
  assert.notDeepEqual(await surface("export = first;"), await surface("export default first;"));
});

test("local export changes are observable while executable and dynamic statements are not module-only", async () => {
  const reader = createModuleDependenciesReader();
  const result = await reader.extract([
    { path: "empty.ts", content: ";" },
    { path: "barrel.ts", content: "export { first };\nexport { second as other };" },
    { path: "body.ts", content: "export function run() {}\nimport('./lazy');\nexport default run;" },
    { path: "ignored.js", content: "import './missing';" },
    { path: "__tests__/fixture.json", content: "this is not typescript" },
  ]);
  assert.deepEqual(result.files, [
    { file: "barrel.ts", statements: ["export { first };", "export { second as other };"], moduleOnly: false },
    { file: "body.ts", statements: [JSON.stringify({ declaration: "FunctionDeclaration", names: ["run"], default: false }), JSON.stringify({ assignment: "default", binding: "run" }), JSON.stringify({ reference: "dynamic-import", specifier: "./lazy" })], moduleOnly: false },
    { file: "empty.ts", statements: [], moduleOnly: true },
  ]);
  assert.equal(result.dependencies.length, 1);
  assert.equal(result.dependencies[0]?.specifier, "./lazy");
  assert.equal(result.dependencies[0]?.target.kind, "unresolved");
  assert.equal(result.unread.some(({ file }) => file === "__tests__/fixture.json"), false);
});

test("nested literal loads and type queries retain distinct dependency evidence without body-only origins", async () => {
  const reader = createModuleDependenciesReader();
  const source = { path: "src/use.ts", content: "export const load = () => import('./lib/item'); type Item = typeof import('./lib/item');" };
  const result = await reader.extract([source, item]);
  assert.deepEqual(result.dependencies.map(({ specifier, target, form, typeOnly, offset }) => ({ specifier, target, form, typeOnly, offset })), [
    { specifier: "./lib/item", target: { kind: "repository", file: item.path }, form: "dynamic-import", typeOnly: false, offset: source.content.indexOf("import(") },
    { specifier: "./lib/item", target: { kind: "repository", file: item.path }, form: "type-query", typeOnly: true, offset: source.content.lastIndexOf("import(") - "typeof ".length },
  ]);
  assert.deepEqual(result.untraversed, []);
  const changedBody = await reader.extract([{ ...source, content: source.content.replace("() => import", "() => 1 || import") }, item]);
  assert.deepEqual(result.files.find(({ file }) => file === source.path)?.statements, changedBody.files.find(({ file }) => file === source.path)?.statements);
});

test("literal and computed references on the same line retain exact unsupported reference coverage", async () => {
  const content = "import('./lib/item'); import(name); function run(require: Function) { require('pkg'); }";
  const result = await createModuleDependenciesReader().extract([{ path: "src/use.ts", content }, item, manifest]);
  assert.equal(result.dependencies.length, 1);
  assert.deepEqual(result.untraversed, [
    { file: "src/use.ts", line: 1, offset: content.indexOf("import(name)"), form: "dynamic-import" },
    { file: "src/use.ts", line: 1, offset: content.indexOf("require('pkg')"), form: "require" },
  ]);
});

test("only referenced present JSON targets are covered as resources without parsing their contents", async () => {
  const result = await createModuleDependenciesReader().extract([
    { path: "src/use.ts", content: "import data from './data.json'; import 'node:crypto'; import './missing.json';" },
    { path: "src/data.json", content: '{"value":1}' },
    { path: "src/unrelated.json", content: "unrelated" },
  ]);
  assert.deepEqual(result.dependencies.map(({ target }) => target.kind), ["repository", "external", "unresolved"]);
  assert.deepEqual(result.files.find(({ file }) => file === "src/data.json"), { file: "src/data.json", statements: ['{"value":1}'], moduleOnly: true, resource: true });
  assert.equal(result.files.some(({ file }) => file === "src/unrelated.json"), false);
});

test("malformed and unsupported static declarations are explicitly unread", async () => {
  const result = await createModuleDependenciesReader().extract([
    { path: "broken.ts", content: "export {" },
    { path: "internal.ts", content: "import Alias = Namespace.Member;" },
  ]);
  assert.deepEqual(result.unread, [{ file: "broken.ts", reason: "source-unreadable" }, { file: "internal.ts", reason: "no-extractor" }]);
  assert.equal(result.files.some(({ file }) => file === "broken.ts"), false);
  assert.equal(result.files.find(({ file }) => file === "internal.ts")?.moduleOnly, false);
});
