import assert from "node:assert/strict";
import test from "node:test";
import { createJavaNameBindings } from "../core/adapters/spring/java-name-bindings.adapter.ts";
import { createJavaParser } from "../core/adapters/tree-sitter/java-parser.adapter.ts";
import { createImportOrigins } from "../core/adapters/typescript/import-origins.adapter.ts";
import { createDerivedFacts } from "../core/application/snapshot/derived-facts.ts";
import { createSnapshotDataCache } from "../core/application/snapshot/snapshot-data-cache.ts";
import type { DerivedFacts } from "../core/ports/derived-facts.port.ts";
import type { SourceFile } from "../core/ports/entrypoint-extractor.port.ts";

/**
 * Complete keys (ADR-0045 decision 10): a retained cross-file answer, read again over the same derived facts after one
 * file it does not own changed, answers what a read without retention answers, never the answer kept before the change.
 */
function sharedFacts(): DerivedFacts {
  return createDerivedFacts(createSnapshotDataCache(1 << 24), { of: (text) => text }, "untrusted");
}

const CONFIG: SourceFile = { path: "tsconfig.json", content: "{}" };
const MANIFEST: SourceFile = { path: "package.json", content: JSON.stringify({ dependencies: { "@angular/router": "1.0.0" } }) };

test("a new ambient .d.ts global withdraws the library binding of a name another file uses", async () => {
  const use: SourceFile = { path: "src/cache.ts", content: "export function run(): void {\n  console.log('x');\n}\n" };
  const globals: SourceFile = { path: "src/globals.d.ts", content: "declare global {\n  var console: unknown;\n}\nexport {};\n" };
  const site = { file: use.path, line: 2, column: 3, spelled: "console", owner: { name: "run", line: 1, endLine: 3 } };
  const facts = sharedFacts();

  assert.deepEqual(await createImportOrigins([CONFIG, MANIFEST, use], { facts }).rootBindings([site]), [{ kind: "ambient", root: "console" }]);
  const after = await createImportOrigins([CONFIG, MANIFEST, use, globals], { facts }).rootBindings([site]);
  assert.deepEqual(after, await createImportOrigins([CONFIG, MANIFEST, use, globals]).rootBindings([site]));
  assert.deepEqual(after, [{ kind: "unknown" }]);
});

test("an edited superclass in another file withdraws the library type an annotation names", async () => {
  const use: SourceFile = { path: "src/use.ts", content: "import { Router } from '@angular/router';\nexport function run(value: Router): void { value.go(); }" };
  const plain: SourceFile = { path: "src/sub.ts", content: "export class AppRouter {}\n" };
  const subclass: SourceFile = { path: "src/sub.ts", content: "import { Router } from '@angular/router';\nexport class AppRouter extends Router {}\n" };
  const site = { file: use.path, line: 2, column: use.content.split("\n")[1]!.indexOf("Router") + 1, spelled: "Router", owner: { name: "run", line: 2, endLine: 2 } };
  const facts = sharedFacts();

  assert.deepEqual(await createImportOrigins([CONFIG, MANIFEST, use, plain], { facts }).declaredTypes([site]), [{ kind: "package", module: "@angular/router", name: "Router" }]);
  const after = await createImportOrigins([CONFIG, MANIFEST, use, subclass], { facts }).declaredTypes([site]);
  assert.deepEqual(after, await createImportOrigins([CONFIG, MANIFEST, use, subclass]).declaredTypes([site]));
  assert.deepEqual(after, [{ kind: "unknown" }]);
});

test("a re-export edited in another file moves the declaration a namespace member reaches", async () => {
  const page: SourceFile = { path: "src/page.ts", content: "import * as ns from './barrel';\nexport function run(): void {\n  ns.load();\n}\n" };
  const a: SourceFile = { path: "src/a.ts", content: "export function load(): void {}\n" };
  const b: SourceFile = { path: "src/b.ts", content: "export function load(): void {}\n" };
  const barrel = (from: string): SourceFile => ({ path: "src/barrel.ts", content: `export { load } from '${from}';\n` });
  const site = { file: page.path, line: 3, column: 3, spelled: "ns", owner: { name: "run", line: 2, endLine: 4 } };
  const facts = sharedFacts();

  assert.deepEqual(await createImportOrigins([CONFIG, MANIFEST, page, a, b, barrel("./a")], { facts }).rootBindings([site]), [{ kind: "located", root: "ns", file: "src/a.ts", path: "load" }]);
  const after = await createImportOrigins([CONFIG, MANIFEST, page, a, b, barrel("./b")], { facts }).rootBindings([site]);
  assert.deepEqual(after, await createImportOrigins([CONFIG, MANIFEST, page, a, b, barrel("./b")]).rootBindings([site]));
  assert.deepEqual(after, [{ kind: "located", root: "ns", file: "src/b.ts", path: "load" }]);
});

test("a new non-Java source no reader parses withdraws the method a Java call names", async () => {
  const java = (name: string, lines: readonly string[]): SourceFile => ({ path: `src/main/java/app/${name}`, content: `${lines.join("\n")}\n` });
  const store = java("Store.java", ["package app;", "", "public interface Store {", "  void save(String value);", "}"]);
  const use = java("Use.java", ["package app;", "", "class Use {", "  void run(Store store) { store.save(\"x\"); }", "}"]);
  const sources = [store, use];
  const paths = sources.map(({ path }) => path);
  const withKotlin = [...paths, "src/main/kotlin/Twin.kt"];
  const site = { file: use.path, line: 4, column: use.content.split("\n")[3]!.indexOf("{ ") + 3, member: "save" };
  const facts = sharedFacts();

  assert.deepEqual(await createJavaNameBindings(createJavaParser, sources, paths, facts).receiverMethods([site]), [{ kind: "method", file: store.path, start: 4, nameLine: 4 }]);
  const after = await createJavaNameBindings(createJavaParser, sources, withKotlin, facts).receiverMethods([site]);
  assert.deepEqual(after, await createJavaNameBindings(createJavaParser, sources, withKotlin).receiverMethods([site]));
  assert.deepEqual(after, [{ kind: "unproven" }]);
});
