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
    "Store();",
    "helper();",
    "filter();",
    "console.log();",
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
  const findings = await createImportOrigins(SOURCES).origins([{ file: "src/page.ts", line: 11, column: 1, name: "Store", fullName: "Store", kind: "calls" }]);

  assert.deepEqual(only(findings), { status: "complete", value: { kind: "repository", file: "src/store.ts" }, occurrence: true, evidence: [{ path: "src/page.ts", line: 11 }] });
});

test("a relative specifier names a file of the repository", async () => {
  const findings = await createImportOrigins(SOURCES).origins([{ file: "src/page.ts", line: 12, column: 1, name: "helper", fullName: "helper", kind: "calls" }]);

  assert.deepEqual(only(findings), { status: "complete", value: { kind: "repository", file: "src/local.ts" }, occurrence: true, evidence: [{ path: "src/page.ts", line: 12 }] });
});

test("a package the manifest declares is outside the repository, named after the package", async () => {
  const findings = await createImportOrigins(SOURCES).origins([{ file: "src/page.ts", line: 13, column: 1, name: "filter", fullName: "filter", kind: "calls" }]);

  assert.deepEqual(only(findings), { status: "complete", value: { kind: "external", module: "rxjs" }, occurrence: true, evidence: [{ path: "src/page.ts", line: 13 }] });
});

test("a name the file declares itself is unknown even when an import names it, since the declaration may shadow it", async () => {
  const withoutDeclaration: SourceFile = { path: "src/page.ts", content: "import { map } from 'rxjs/operators';\nexport function run(): void {\n  map();\n}\n" };
  const declared = await createImportOrigins([CONFIG, MANIFEST, withoutDeclaration]).origins([{ file: "src/page.ts", line: 3, column: 3, name: "map", fullName: "map", kind: "calls" }]);
  const shadowed = await createImportOrigins(SOURCES).origins([{ file: "src/page.ts", line: 9, name: "map" }]);

  assert.deepEqual(only(declared), { status: "complete", value: { kind: "external", module: "rxjs" }, occurrence: true, evidence: [{ path: "src/page.ts", line: 3 }] });
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

test("a name nothing binds but the language's own libraries declare is ambient, so no repository declaration can answer it", async () => {
  const findings = await createImportOrigins(SOURCES).origins([{ file: "src/page.ts", line: 14, column: 1, name: "console", fullName: "console.log", kind: "calls" }]);

  assert.deepEqual(only(findings), { status: "complete", value: { kind: "ambient", name: "console" }, occurrence: true, evidence: [{ path: "src/page.ts", line: 14 }] });
});

test("a name the file declares itself is unknown even when a library declares it", async () => {
  const declared: SourceFile = { path: "src/page.ts", content: "export function run(): void {\n  const console = { log: () => undefined };\n  console.log();\n}\n" };
  const findings = await createImportOrigins([CONFIG, MANIFEST, declared]).origins([{ file: "src/page.ts", line: 3, name: "console" }]);

  assert.deepEqual(only(findings), { status: "unknown", reason: "unresolved", evidence: [{ path: "src/page.ts", line: 3 }] });
});

test("a name the snapshot declares globally is never ambient, because the repository may own it", async () => {
  const global: SourceFile = { path: "src/globals.d.ts", content: "declare global {\n  var caches: unknown;\n}\nexport {};\n" };
  const page: SourceFile = { path: "src/cache.ts", content: "export function run(): void {\n  caches.open('x');\n}\n" };
  const findings = await createImportOrigins([CONFIG, MANIFEST, global, page]).origins([{ file: "src/cache.ts", line: 2, name: "caches" }]);

  assert.deepEqual(only(findings), { status: "unknown", reason: "unresolved", evidence: [{ path: "src/cache.ts", line: 2 }] });
});

test("callback_parameter_bare_call_is_local and wrong coordinates remain unknown", async () => {
  const text = "const x = new Promise(resolve => resolve(value));";
  const file = "src/callback.ts";
  const column = text.indexOf("resolve(value)") + 1;
  const reader = createImportOrigins([{ path: file, content: text }]);
  const results = await reader.origins([
    { file, line: 1, column, name: "resolve", fullName: "resolve", kind: "calls" },
    { file, line: 1, column: column + 1, name: "resolve", fullName: "resolve", kind: "calls" },
  ]);
  assert.equal(results[0]?.status, "complete");
  if (results[0]?.status === "complete") assert.deepEqual(results[0].value, { kind: "local-parameter", name: "resolve" });
  assert.equal(results[1]?.status, "unknown");
});

test("local parameter proof handles Unicode, nested parameters and same-line uses", async () => {
  const file = "src/callback.ts";
  const text = "const x='é😀'; outside(); run(resolve => resolve(1)); resolve(2); run(resolve => run(resolve => resolve(3)));";
  const reader = createImportOrigins([{ path: file, content: text }]);
  const points = [text.indexOf("outside()"), text.indexOf("resolve(1)"), text.indexOf("resolve(2)"), text.indexOf("resolve(3)")];
  const results = await reader.origins(points.map((offset, i) => ({ file, line: 1, column: offset + 1, name: i === 0 ? "outside" : "resolve", fullName: i === 0 ? "outside" : "resolve", kind: "calls" })));
  assert.deepEqual(results.map((f) => f.status === "complete" ? f.value.kind : "unknown"), ["unknown", "local-parameter", "unknown", "local-parameter"]);
});

test("local parameter refuses unsupported syntax and malformed files", async () => {
  const examples = [
    "run((...resolve) => resolve());", "run((resolve = other) => resolve());", "run(({resolve}) => resolve());",
    "run(resolve => resolve.x());", "run(resolve => { eval('x'); resolve(); });", "run(resolve => { const resolve = other; resolve(); });",
    "run(resolve => resolve( ;",
  ];
  for (const [i, text] of examples.entries()) {
    const file = `src/bad${i}.ts`;
    const offset = text.lastIndexOf(i === 3 ? "resolve.x" : "resolve(");
    const result = await createImportOrigins([{ path: file, content: text }]).origins([{ file, line: 1, column: offset + 1, name: "resolve", fullName: i === 3 ? "resolve.x" : "resolve", kind: "calls" }]);
    assert.notEqual(result[0]?.status === "complete" ? result[0].value.kind : "unknown", "local-parameter", text);
  }
});

test("first-column call is validated and missing or wrong points are unknown", async () => {
  const file = "src/first.ts";
  const reader = createImportOrigins([{ path: file, content: "Promise.resolve();" }]);
  const found = await reader.origins([
    { file, line: 1, column: 1, name: "Promise", fullName: "Promise.resolve", kind: "calls" },
    { file, line: 1, column: 2, name: "Promise", fullName: "Promise.resolve", kind: "calls" },
    { file, line: 1, name: "Promise", fullName: "Promise.resolve", kind: "calls" },
  ]);
  assert.equal(found[0]?.status, "complete");
  assert.equal(found[1]?.status, "unknown");
  assert.equal(found[2]?.status, "unknown");
});

test("nested calls at the same point retain distinct names", async () => {
  const file = "src/nested.ts";
  const text = "inject(Svc).hit();";
  const reader = createImportOrigins([{ path: file, content: text }]);
  const found = await reader.origins([
    { file, line: 1, column: 1, name: "inject", fullName: "inject", kind: "calls" },
    { file, line: 1, column: 1, name: "inject()", fullName: "inject().hit", kind: "calls" },
  ]);
  assert.deepEqual(found.map((f) => f.occurrence), [true, true]);
});

test("outer import shadowed by a callback parameter proves only the local occurrence", async () => {
  const file = "src/shadow.ts";
  const text = "import { resolve } from 'rxjs'; resolve(); run(resolve => resolve());";
  const first = text.indexOf("resolve();"), second = text.lastIndexOf("resolve()");
  const found = await createImportOrigins([MANIFEST, { path: file, content: text }]).origins([first, second].map((point) => ({ file, line: 1, column: point + 1, name: "resolve", fullName: "resolve", kind: "calls" })));
  assert.equal(found[0]?.status, "unknown");
  assert.ok(found[1]?.status === "complete" && found[1].value.kind === "local-parameter");
});

test("a callback call at raw column zero is local", async () => {
  const file = "src/first.ts";
  const text = "run(resolve => {\nresolve(value);\n});";
  const found = await createImportOrigins([{ path: file, content: text }]).origins([{ file, line: 2, column: 1, name: "resolve", fullName: "resolve", kind: "calls" }]);
  assert.ok(found[0]?.status === "complete" && found[0].value.kind === "local-parameter");
});

test("function reference in a call argument validates its own coordinate", async () => {
  const file = "src/use.ts";
  const text = "import { Store } from './store'; const value = inject(Store);";
  const column = text.lastIndexOf("Store") + 1;
  const result = await createImportOrigins([STORE, { path: file, content: text }]).origins([{ file, line: 1, column, name: "Store", fullName: "Store", kind: "function_ref" }]);
  assert.ok(result[0]?.occurrence === true && result[0].status === "complete" && result[0].value.kind === "repository");
});

test("reference kinds reject declaration names at stale coordinates", async () => {
  const file = "src/stale.ts", text = "class Store {}";
  const found = await createImportOrigins([{ path: file, content: text }]).origins(["references", "function_ref"].map((kind) => ({ file, line: 1, column: 7, name: "Store", fullName: "Store", kind })));
  assert.deepEqual(found.map((finding) => finding.occurrence), [undefined, undefined]);
});

test("missing source and unsupported TSX are unknown", async () => {
  const reader = createImportOrigins([{ path: "src/view.tsx", content: "run(resolve => resolve())" }]);
  const found = await reader.origins(["src/missing.ts", "src/view.tsx"].map((file) => ({ file, line: 1, column: 16, name: "resolve", fullName: "resolve", kind: "calls" })));
  assert.ok(found.every((item) => item.status === "unknown" && item.occurrence === undefined));
});

test("nested function bindings and eval do not contaminate an outer callback scope", async () => {
  const file = "src/scopes.ts";
  const text = "run(resolve => { function nested() { const resolve = other; eval('x'); } resolve(1); });";
  const results = await createImportOrigins([{ path: file, content: text }]).origins([
    { file, line: 1, column: text.indexOf("resolve(1)") + 1, name: "resolve", fullName: "resolve", kind: "calls" },
  ]);
  assert.ok(results[0]?.status === "complete" && results[0].value.kind === "local-parameter");
});

test("an import-equals require binds its name to the module it names, unless the file declares the name again", async () => {
  const bound: SourceFile = { path: "src/legacy.ts", content: "import ops = require('rxjs/operators');\nops.map();\n" };
  const shadowed: SourceFile = { path: "src/shadow.ts", content: "import ops = require('rxjs/operators');\nops.map();\nfunction run(ops: unknown) {}\n" };
  const site = (file: string): ImportOriginSite => ({ file, line: 2, column: 1, name: "ops", fullName: "ops.map", kind: "calls" });
  const findings = await createImportOrigins([MANIFEST, bound, shadowed]).origins([site("src/legacy.ts"), site("src/shadow.ts")]);

  assert.deepEqual(findings, [
    { status: "complete", value: { kind: "external", module: "rxjs" }, occurrence: true, evidence: [{ path: "src/legacy.ts", line: 2 }] },
    { status: "unknown", reason: "unresolved", occurrence: true, evidence: [{ path: "src/shadow.ts", line: 2 }] },
  ]);
});

/** A class whose method shares a library global's name, called as the graph spells it: the bare name, at the call. */
const OWN_CALLS = [
  "export class Svc {",
  "  fetch(): void {}",
  "  direct(): void { this.fetch(); }",
  "  arrow = () => this.fetch();",
  "  inherited(): void { super.fetch(); }",
  "  rebound(): void { [1].map(function () { this.fetch(); }); }",
  "  literal(): void { const o = { m() { this.fetch(); } }; }",
  "}",
];

async function ownCallKinds(lines: readonly number[]): Promise<string[]> {
  const file = "src/svc.ts";
  const sites = lines.map((line): ImportOriginSite => {
    const text = OWN_CALLS[line - 1]!;
    const column = Math.max(text.indexOf("this.fetch"), text.indexOf("super.fetch")) + 1;
    return { file, line, column, name: "fetch", fullName: "fetch", kind: "calls" };
  });
  const found = await createImportOrigins([{ path: file, content: OWN_CALLS.join("\n") }]).origins(sites);
  return found.map((finding) => (finding.status === "complete" ? finding.value.kind : "unknown"));
}

test("a bare graph call written on this inside a class member names a member of that class, not a library global", async () => {
  assert.deepEqual(await ownCallKinds([3, 4]), ["this-member", "this-member"]);
});

test("a bare graph call on super, or on a this a function or an object method rebinds, proves nothing", async () => {
  assert.deepEqual(await ownCallKinds([5, 6, 7]), ["unknown", "unknown", "unknown"]);
});
