import { test } from "node:test";
import assert from "node:assert/strict";
import { createImportOrigins } from "./import-origins.adapter.ts";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ImportOriginSite } from "../../ports/import-origins.port.ts";

const CONFIG: SourceFile = {
  path: "tsconfig.json",
  content: JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } } }),
};

const MANIFEST: SourceFile = {
  path: "package.json",
  content: JSON.stringify({ dependencies: { rxjs: "^7.0.0" } }),
};

const STORE: SourceFile = { path: "src/store.ts", content: "export class Store {}\n" };
const LOCAL: SourceFile = { path: "src/local.ts", content: "export function helper(): void {}\n" };
const PAGE: SourceFile = {
  path: "src/page.ts",
  content: [
    "import { Store } from '@app/store';",
    "import { map } from 'rxjs/operators';",
    "import { filter } from 'rxjs';",
    "import { helper } from './local';",
    "import { ghost } from 'not-a-dependency';",
    "",
    "export function run(): void {",
    "  function map(): void {}",
    "  map();",
    "}",
    "",
  ].join("\n"),
};

const SOURCES = [CONFIG, MANIFEST, STORE, LOCAL, PAGE];

function only(findings: readonly Finding<ImportOrigin>[]): Finding<ImportOrigin> {
  assert.equal(findings.length, 1);
  const finding = findings[0];
  assert.ok(finding !== undefined);
  return finding;
}

test("an aliased specifier names a file of the repository, decided by the snapshot's own paths", async () => {
  const findings = await createImportOrigins(SOURCES).origins([{ file: "src/page.ts", line: 1, name: "Store" }]);

  assert.deepEqual(only(findings), { status: "complete", value: { kind: "repository", file: "src/store.ts" }, evidence: [{ path: "src/page.ts", line: 1 }] });
});

test("a relative specifier names a file of the repository", async () => {
  const findings = await createImportOrigins(SOURCES).origins([{ file: "src/page.ts", line: 4, name: "helper" }]);

  assert.deepEqual(only(findings), { status: "complete", value: { kind: "repository", file: "src/local.ts" }, evidence: [{ path: "src/page.ts", line: 4 }] });
});

test("a package the manifest declares is outside the repository, named after the package", async () => {
  const findings = await createImportOrigins(SOURCES).origins([{ file: "src/page.ts", line: 3, name: "filter" }]);

  assert.deepEqual(only(findings), { status: "complete", value: { kind: "external", module: "rxjs" }, evidence: [{ path: "src/page.ts", line: 3 }] });
});

test("a name the file declares itself is unknown even when an import names it, since the declaration may shadow it", async () => {
  const withoutDeclaration: SourceFile = { path: "src/page.ts", content: "import { map } from 'rxjs/operators';\nexport function run(): void {\n  map();\n}\n" };
  const declared = await createImportOrigins([CONFIG, MANIFEST, withoutDeclaration]).origins([{ file: "src/page.ts", line: 3, name: "map" }]);
  const shadowed = await createImportOrigins(SOURCES).origins([{ file: "src/page.ts", line: 9, name: "map" }]);

  assert.deepEqual(only(declared), { status: "complete", value: { kind: "external", module: "rxjs" }, evidence: [{ path: "src/page.ts", line: 3 }] });
  assert.deepEqual(only(shadowed), { status: "unknown", reason: "unresolved", evidence: [{ path: "src/page.ts", line: 9 }] });
});

test("a name no import of the file binds is unknown, never a guess", async () => {
  const findings = await createImportOrigins(SOURCES).origins([{ file: "src/page.ts", line: 7, name: "this" }]);

  assert.deepEqual(only(findings), { status: "unknown", reason: "unresolved", evidence: [{ path: "src/page.ts", line: 7 }] });
});

test("a bare specifier neither the manifest nor a path governs is unknown, not external by assumption", async () => {
  const findings = await createImportOrigins(SOURCES).origins([{ file: "src/page.ts", line: 5, name: "ghost" }]);

  assert.deepEqual(only(findings), { status: "unknown", reason: "unresolved", evidence: [{ path: "src/page.ts", line: 5 }] });
});
