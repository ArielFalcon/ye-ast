import { test } from "node:test";
import assert from "node:assert/strict";
import { createImportOrigins } from "./import-origins.adapter.ts";
import { sourceTree } from "./source-tree.ts";
import ts from "typescript";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { RootOrigin } from "../../domain/impact/edge-policy.ts";
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

test("a parameter of a function declaration, a method or a constructor proves a bare call of it local", async () => {
  const file = "src/declared.ts";
  const text = "export function clean(text: string, redact: (v: string) => string) { return redact(text); }\nclass C { run(redact: () => void) { redact(); } constructor(redact: () => void) { redact(); } }";
  const lines = text.split("\n");
  const sites = [[1, lines[0]!.indexOf("redact(text)")], [2, lines[1]!.indexOf("redact();")], [2, lines[1]!.lastIndexOf("redact();")]] as const;
  const results = await createImportOrigins([{ path: file, content: text }]).origins(sites.map(([line, offset]) => ({ file, line, column: offset + 1, name: "redact", fullName: "redact", kind: "calls" })));

  assert.deepEqual(results.map((f) => (f.status === "complete" ? f.value.kind : "unknown")), ["local-parameter", "local-parameter", "local-parameter"]);
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

test("a reader parses a file once however many times its sites are asked, and answers each ask the same", async () => {
  const parsed: string[] = [];
  const reader = createImportOrigins(SOURCES, (file) => (parsed.push(file.path), sourceTree({ ...file }, ts.ScriptTarget.Latest)));
  const ask = (line: number, name: string) => reader.origins([{ file: PAGE.path, line, column: 1, name, fullName: name, kind: "calls" }]);

  const answers = [await ask(11, "Store"), await ask(12, "helper"), await ask(11, "Store")];

  assert.deepEqual(parsed, [PAGE.path]);
  assert.deepEqual(answers[0], answers[2]);
  assert.deepEqual(only(answers[1]!), { status: "complete", value: { kind: "repository", file: "src/local.ts" }, occurrence: true, evidence: [{ path: "src/page.ts", line: 12 }] });
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
  "  static run(): void { this.fetch(); }",
  "  static field = this.fetch();",
  "  nest(): void { class Inner { fetch(): void {} go(): void { this.fetch(); } } }",
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

test("a bare graph call on the this of a static member, or of a class declared inside a function, proves nothing", async () => {
  assert.deepEqual(await ownCallKinds([8, 9, 10]), ["unknown", "unknown", "unknown"]);
});

const RESOLVED_LINES = [
  "import * as rx from 'rxjs';",
  "import { filter } from 'rxjs';",
  "import { Store } from '@app/store';",
  "",
  "export function use(node: rx.Observable): unknown {",
  "  filter(node);",
  "  const made = new rx.Subject();",
  "  Store.create().run();",
  "  return made;",
  "}",
  "",
];
const RESOLVED: SourceFile = { path: "src/resolved.ts", content: RESOLVED_LINES.join("\n") };

/** The site the graph writes for `kind` at the first `spelled` of a 1-based line, naming `name`. */
function resolvedSite(line: number, spelled: string, kind: string, name: string) {
  return { file: RESOLVED.path, line, column: RESOLVED_LINES[line - 1]!.indexOf(spelled) + 1, kind, name };
}

async function rootOf(site: ReturnType<typeof resolvedSite>): Promise<RootOrigin> {
  return only(await createImportOrigins([...SOURCES, RESOLVED]).rootOrigins([site]));
}

const RXJS: ImportOrigin = { kind: "external", module: "rxjs" };

test("a qualified type the graph resolved by its last name is rooted at the namespace import before it", async () => {
  const finding = await rootOf(resolvedSite(5, "Observable", "references", "Observable"));

  assert.deepEqual(finding, { status: "complete", value: RXJS, evidence: [{ path: RESOLVED.path, line: 5 }] });
});

test("a call is rooted at the start of its callee, where the graph writes the edge", async () => {
  const finding = await rootOf(resolvedSite(6, "filter", "calls", "filter"));

  assert.deepEqual(finding.status === "complete" && finding.value, RXJS);
});

test("an instantiation is rooted at the class after the new keyword, where the graph writes the edge", async () => {
  const finding = await rootOf(resolvedSite(7, "new", "instantiates", "Subject"));

  assert.deepEqual(finding.status === "complete" && finding.value, RXJS);
});

test("a chain whose root is a repository import is rooted there, whatever member it ends in", async () => {
  const finding = await rootOf(resolvedSite(8, "Store", "calls", "create"));

  assert.deepEqual(finding.status === "complete" && finding.value, { kind: "repository", file: "src/store.ts" });
});

test("only a site that spells its root alone is bare", async () => {
  const alone = await rootOf(resolvedSite(6, "filter", "calls", "filter"));
  const chained = await rootOf(resolvedSite(8, "Store", "calls", "create"));

  assert.equal(alone.bare, true);
  assert.equal(chained.bare, undefined);
});

test("a root spelled alone that a parameter binds is local, one a local variable binds is unknown", async () => {
  const file = "src/shadow.ts";
  const text = 'import { redact } from "./redact.ts";\nexport function clean(text: string, redact: (v: string) => string) { return redact(text); }\nexport function plain(text: string) { const redact = (v: string) => v; return redact(text); }\n';
  const lines = text.split("\n");
  const reader = createImportOrigins([...SOURCES, { path: file, content: text }]);
  const [parameter, variable] = await reader.rootOrigins([2, 3].map((line) => ({ file, line, column: lines[line - 1]!.lastIndexOf("redact(") + 1, kind: "calls", name: "redact" })));

  assert.deepEqual(parameter, { status: "complete", value: { kind: "local-parameter", name: "redact" }, evidence: [{ path: file, line: 2 }], bare: true });
  assert.equal(variable!.status, "unknown");
});

/** The root of the last bare `redact(` call in `body`, written inside a function whose parameter is `redact`. */
async function parameterRootOf(body: string): Promise<RootOrigin> {
  const file = "src/scoped.ts";
  const text = `export function outer(redact: (s: string) => string) {\n${body}\n}\n`;
  const lines = text.split("\n");
  const line = lines.findLastIndex((candidate) => candidate.includes("redact(")) + 1;
  return only(await createImportOrigins([{ path: file, content: text }]).rootOrigins([{ file, line, column: lines[line - 1]!.lastIndexOf("redact(") + 1, kind: "calls", name: "redact" }]));
}

test("a call reaches the parameter of the function around it through a closure or a class, unless a declaration in between rebinds its name", async () => {
  for (const body of [
    "  return redact('x');",
    "  return () => redact('x');",
    "  return [1].map(() => () => redact('x'));",
    "  class Holder {\n    static {\n      redact('x');\n    }\n  }",
    "  class Holder {\n    value = redact('x');\n  }",
  ]) {
    const root = await parameterRootOf(body);
    assert.equal(root.status === "complete" && root.value.kind, "local-parameter", body);
  }
  for (const body of [
    "  class Holder {\n    static {\n      const redact = (s: string) => s;\n      redact('x');\n    }\n  }",
    "  const inner = () => {\n    const redact = (s: string) => s;\n    redact('x');\n  };",
    "  const named = function redact() {\n    redact('x');\n  };",
    "  function redact(s: string) {\n    return s;\n  }\n  redact('x');",
    "  var redact = (s: string) => s;\n  redact('x');",
    "  if (Date.now() > 0) {\n    var redact = (s: string) => s;\n  }\n  redact('x');",
    "  class redact {}\n  redact('x');",
  ]) {
    const root = await parameterRootOf(body);
    assert.notEqual(root.status === "complete" && root.value.kind, "local-parameter", body);
  }
});

test("a call inside with, or in a script that calls eval directly around it, is never proven a parameter; strict code or an indirect eval is", async () => {
  const cases = [
    { file: "src/with.ts", text: "function run(redact: () => void) { with (other) { redact(); } }\n", local: false },
    { file: "src/sloppy.ts", text: "function run(redact: () => void) { eval('var redact = 1'); redact(); }\n", local: false },
    { file: "src/sloppy-outer.ts", text: "function run(redact: () => void) { eval('x'); return () => redact(); }\n", local: false },
    { file: "src/parenthesized.ts", text: "function run(redact: () => void) { (eval)('var redact = 1'); return () => redact(); }\n", local: false },
    { file: "src/asserted.ts", text: "function run(redact: () => void) { (eval as any)('var redact = 1'); return redact(); }\n", local: false },
    { file: "src/non-null.ts", text: "function run(redact: () => void) { eval!('var redact = 1'); return redact(); }\n", local: false },
    { file: "src/satisfies.ts", text: "function run(redact: () => void) { (eval satisfies unknown)('var redact = 1'); return redact(); }\n", local: false },
    { file: "src/angle.ts", text: "function run(redact: () => void) { (<any>eval)('var redact = 1'); return redact(); }\n", local: false },
    { file: "src/comma.ts", text: "function run(redact: () => void) { (0, eval)('x'); redact(); }\n", local: true },
    { file: "src/optional.ts", text: "function run(redact: () => void) { eval?.('x'); redact(); }\n", local: true },
    { file: "src/directive.ts", text: "function run(redact: () => void) { 'use strict'; eval('x'); redact(); }\n", local: true },
    { file: "src/module.ts", text: "export function run(redact: () => void) { eval('x'); redact(); }\n", local: true },
    { file: "src/class.ts", text: "class Runner { run(redact: () => void) { eval('x'); redact(); } }\n", local: true },
  ];
  for (const { file, text, local } of cases) {
    const [root] = await createImportOrigins([{ path: file, content: text }]).rootOrigins([{ file, line: 1, column: text.lastIndexOf("redact()") + 1, kind: "calls", name: "redact" }]);
    assert.equal(root!.status === "complete" && root!.value.kind === "local-parameter", local, file);
  }
});

test("a shorthand property that passes a parameter on is a use of the parameter", async () => {
  const file = "src/shorthand.ts";
  const text = "export function wrap(redact: () => void) { return { redact }; }\n";
  const [root] = await createImportOrigins([{ path: file, content: text }]).rootOrigins([{ file, line: 1, column: text.lastIndexOf("redact") + 1, kind: "references", name: "redact" }]);

  assert.equal(root!.status === "complete" && root!.value.kind, "local-parameter");
});

test("a parameter is proven beside one with a default, a rest or a destructuring, never when it has one itself", async () => {
  const file = "src/siblings.ts";
  const lines = [
    "export function defaultRun(redact: () => number, other = 0) { return redact(); }",
    "export function restRun(redact: () => number, ...others: number[]) { return redact(); }",
    "export function shapedRun(redact: () => number, { size }: { size: number }) { return redact(); }",
    "export function ownDefault(redact = () => 1) { return redact(); }",
  ];
  const text = `${lines.join("\n")}\n`;
  const roots = await createImportOrigins([{ path: file, content: text }]).rootOrigins(lines.map((line, index) => ({ file, line: index + 1, column: line.lastIndexOf("redact(") + 1, kind: "calls", name: "redact" })));

  assert.deepEqual(roots.map((root) => root.status === "complete" && root.value.kind), ["local-parameter", "local-parameter", "local-parameter", false]);
});

test("a call inside a block, a catch clause or a loop that rebinds the parameter's name is not proven to use the parameter", async () => {
  for (const body of [
    "  try {\n  } catch (redact) {\n    redact('x');\n  }",
    "  for (const redact of [(s: string) => s]) {\n    redact('x');\n  }",
    "  {\n    let redact = (s: string) => s;\n    redact('x');\n  }",
  ]) {
    const root = await parameterRootOf(body);
    assert.notEqual(root.status === "complete" && root.value.kind, "local-parameter", body);
  }
});

test("a type spelled like a parameter is not the parameter", async () => {
  const file = "src/typed.ts";
  const text = "export function make(Order: number) { const made: Order | undefined = undefined; return made; }\n";
  const [type] = await createImportOrigins([{ path: file, content: text }]).rootOrigins([{ file, line: 1, column: text.lastIndexOf("Order") + 1, kind: "references", name: "Order" }]);

  assert.notEqual(type!.status === "complete" && type!.value.kind, "local-parameter");
});

test("a chain through a call, or one that ends in another name than the edge's, is unknown", async () => {
  for (const site of [resolvedSite(8, "Store", "calls", "run"), resolvedSite(5, "Observable", "references", "Subject")]) {
    assert.equal((await rootOf(site)).status, "unknown", `${site.line}:${site.name}`);
  }
});

/** The root `expression` is spelled at, in a module that uses it, beside `defining`: a file of the snapshot that may declare it globally. */
async function globalRootOf(defining: SourceFile, expression: string, kind: string, name: string): Promise<Finding<ImportOrigin>> {
  const use: SourceFile = { path: "src/use.ts", content: `export function use(): unknown {\n  return ${expression};\n}\n` };
  const site = { file: use.path, line: 2, column: "  return ".length + 1, kind, name };
  return only(await createImportOrigins([CONFIG, MANIFEST, defining, use]).rootOrigins([site]));
}

const script = (content: string): SourceFile => ({ path: "src/script.ts", content });

test("a library name a script's top-level variable statement binds, by var, let, const or destructuring, is the repository's own global", async () => {
  for (const [declaration, name] of [["var Intl = 1;", "Intl"], ["let Reflect = 1;", "Reflect"], ["const { Proxy } = { Proxy: 1 };", "Proxy"]] as const) {
    assert.equal((await globalRootOf(script(`${declaration}\n`), name, "references", name)).status, "unknown", declaration);
  }
});

test("a library name a script's top-level class, function, enum, interface, type, namespace or import alias declares is the repository's own global", async () => {
  for (const [declaration, name] of [["class URL {}", "URL"], ["function fetch(): void {}", "fetch"], ["enum Date { A }", "Date"], ["interface Map { own: true }", "Map"], ["type WeakRef = string;", "WeakRef"], ["namespace Atomics { export const own = 1; }", "Atomics"], ["namespace N { export const y = 1; }\nimport Symbol = N.y;", "Symbol"]] as const) {
    assert.equal((await globalRootOf(script(`${declaration}\n`), name, "references", name)).status, "unknown", declaration);
  }
});

test("a library name a module declares in a declare global block is the repository's own global", async () => {
  const augmenting: SourceFile = { path: "src/augment.ts", content: "declare global {\n  var Iterator: unknown;\n}\nexport {};\n" };

  assert.equal((await globalRootOf(augmenting, "Iterator", "references", "Iterator")).status, "unknown");
});

test("a library name a module declares at its top level is not global, so its use elsewhere stays ambient", async () => {
  const module: SourceFile = { path: "src/headers.ts", content: "export class Headers {}\n" };

  assert.deepEqual(await globalRootOf(module, "new Headers()", "instantiates", "Headers"), { status: "complete", value: { kind: "ambient", name: "Headers" }, evidence: [{ path: "src/use.ts", line: 2 }], bare: true });
});

const replacedRootsOf = (...lines: string[]) => {
  const manifest = { path: "package.json", content: JSON.stringify({ dependencies: { lodash: "4.0.0" } }) };
  return createImportOrigins([manifest, { path: "src/patch.ts", content: ["export {};", ...lines].join("\n") }]).replacedRoots();
};

const writtenBy = async (...lines: string[]) => {
  const roots = await replacedRootsOf(...lines);
  return { paths: roots.paths.map((path) => path.join(".")), packages: [...roots.packages].sort() };
};

const pathsWrittenBy = async (...lines: string[]) => (await writtenBy(...lines)).paths;

test("a source that writes through a global, directly, through the global object or a writing call, writes the member path from that global", async () => {
  for (const [line, path] of [
    ["Math.max = () => 0;", "Math.max"],
    ["Map.prototype.get = function get() { return 1; };", "Map.prototype.get"],
    ["Math.seed += 1;", "Math.seed"],
    ["Math.seed++;", "Math.seed"],
    ["delete JSON.parse;", "JSON.parse"],
    ["[Math.max] = [() => 0];", "Math.max"],
    ["for (Math.seed of [1]) {}", "Math.seed"],
    ["globalThis.Math.max = () => 0;", "Math.max"],
    ["window.fetch = () => undefined;", "fetch"],
    ["Object.defineProperty(Array.prototype, 'push', { value: () => 0 });", "Array.prototype.push"],
    ["Reflect.set(String.prototype, 'trim', () => '');", "String.prototype.trim"],
    ["Object.defineProperty(globalThis, 'fetch', { value: () => undefined });", "fetch"],
    ["Array.prototype = [];", "Array.prototype.*"],
  ] as const) assert.deepEqual(await writtenBy(line), { paths: [path], packages: [] }, line);
  assert.deepEqual(await pathsWrittenBy("Object.assign(Math, { max: () => 0, min: () => 0 });"), ["Math.max", "Math.min"]);
});

test("a member a write does not state is every member below its path, and only below it", async () => {
  for (const [line, path] of [
    ["for (const key of keys) Array.prototype[key] = impl[key];", "Array.prototype.*"],
    ["Array.prototype[name] = () => 0;", "Array.prototype.*"],
    ["Object.assign(process.env, vars);", "process.env.*"],
    ["const host = process.env; host[name] = 'on';", "process.env.*"],
    ["Object.setPrototypeOf(Array.prototype, impl);", "Array.prototype.*"],
    ["globalThis[name] = 1;", "*"],
    ["Object.defineProperty(globalThis, name, {});", "*"],
    ["value.__proto__.push = () => 0;", "*.prototype.push"],
    ["Object.getPrototypeOf([]).push = () => 0;", "*.prototype.push"],
  ] as const) assert.deepEqual(await pathsWrittenBy("declare const keys: string[], name: string, impl: any, vars: object, value: any;", line), [path], line);
});

test("an alias stands for the path it is declared from: an initializer, a destructured key, index or rename, a nested pattern, a parameter's default, or a literal's member", async () => {
  for (const [line, path] of [
    ["const { prototype } = Array; prototype.push = () => 0;", "Array.prototype.push"],
    ["const { prototype: proto } = Array; proto.push = () => 0;", "Array.prototype.push"],
    ["const { prototype: { push } } = Array; push.extra = 1;", "Array.prototype.push.extra"],
    ["const [entry] = Array.prototype; entry.extra = 1;", "Array.prototype.0.extra"],
    ["const A = Array; const P = A.prototype; P.push = () => 0;", "Array.prototype.push"],
    ["const { prototype } = Array; Object.defineProperty(prototype, 'push', { value: () => 0 });", "Array.prototype.push"],
    ["function patch(proto = Array.prototype) { proto.push = () => 0; }", "Array.prototype.push"],
    ["function patch({ prototype } = Array) { prototype.push = () => 0; }", "Array.prototype.push"],
    ["const { Array: List } = globalThis; List.prototype.push = () => 0;", "Array.prototype.push"],
    ["[Array][0].prototype.push = () => 0;", "Array.prototype.push"],
    ["const holder = { list: Array }; holder.list.prototype.push = () => 0;", "Array.prototype.push"],
    ["const holder = { ...mixin, list: Array }; holder.list.prototype.push = () => 0;", "Array.prototype.push"],
    ["const { [name]: picked } = Array; picked.push = () => 0;", "Array.*.push"],
    ["const { ...rest } = Math; rest.max = () => 0;", "Math.*.max"],
  ] as const) assert.deepEqual(await pathsWrittenBy("declare const name: string, mixin: object;", line), [path], line);
  assert.deepEqual(await pathsWrittenBy("declare const flag: boolean;", "(flag ? Array : Map).prototype.push = () => 0;"), ["Array.prototype.push", "Map.prototype.push"]);
});

test("a write through a local named like a global, through this, into a local or into a call's result writes nothing global", async () => {
  assert.deepEqual(
    await writtenBy(
      "const { inner } = { inner: { y: 0 } }; inner.y = 1;",
      "let current = { entries: 0, list: [] as Item[], max: Math.max }; current.entries++; current.list = [];",
      "const kinds = { list: Array }; kinds.list = Map;",
      "function g({ x }: { x: { y: number } }) { x.y = 1; }",
      "function f(Math: { max(): number }) { Math.max = () => 0; }",
      "class C { x = 0; set() { this.x = 1; } }",
      "let count = 0; count++;",
      "hasOwnProperty.call({}, \"a\"); constructor.name.at(0);",
      "Object.assign(Object.create(null), {});",
      "const made = Object.create(null); made.x = 1;",
    ),
    { paths: [], packages: [] },
  );
});

test("a write through an import of a package replaces that package, and one of a repository module nothing", async () => {
  assert.deepEqual(await writtenBy("import _ from 'lodash';", "import * as local from './local';", "_.map = () => [];", "local.helper = () => undefined;"), { paths: [], packages: ["lodash"] });
});

test("a name a with body or a direct eval may rebind proves no origin, while the same name outside them still does", async () => {
  const file = "src/dynamic.ts";
  const lines = ["function inside(scope: object) {", "  with (scope) { Math.max(1); fetch(''); }", "}", "function outside() { Math.max(1); fetch(''); }"];
  const reader = createImportOrigins([{ path: file, content: lines.join("\n") }]);
  const column = (line: number, text: string, from = 0) => lines[line - 1]!.indexOf(text, from) + 1;
  const roots = await reader.rootOrigins([2, 4].map((line) => ({ file, line, column: column(line, "Math.max"), kind: "calls", name: "max" })));
  const bare = await reader.origins([2, 4].map((line) => ({ file, line, column: column(line, "fetch("), name: "fetch", fullName: "fetch", kind: "calls" })));
  assert.deepEqual(roots.map((root) => root.status), ["unknown", "complete"]);
  assert.deepEqual(bare.map((origin) => origin.status), ["unknown", "complete"]);
});

const USES: SourceFile = {
  path: "src/uses.ts",
  content: [
    "import ts from 'typescript';",
    "import { helper } from './local';",
    "export function run<T>(input: ts.Expression, value: T): T {",
    "  const seen = new Set(input).add(value);",
    "  helper(input).length;",
    "  seen.size;",
    "  process.exit();",
    "  return value;",
    "}",
    "export class Holder { read(): void { this.run(); } run(): void {} }",
    "new Holder();",
    "",
  ].join("\n"),
};
const USE_SOURCES = [CONFIG, { path: "package.json", content: JSON.stringify({ dependencies: { typescript: "6.0.3" } }) }, LOCAL, USES];

/** The declaration `run` of the uses fixture, as the index places it. */
const RUN = { name: "run", line: 3, endLine: 9 };

/** The 1-based place of the first `spelling` on a line of the uses fixture, written by `run`'s body. */
function useAt(line: number, spelling: string, spelled: string) {
  return { file: USES.path, line, column: USES.content.split("\n")[line - 1]!.indexOf(spelling) + 1, spelled, owner: RUN };
}

test("a qualified type name placed at either name is rooted at its first name, which an import binds to a package", async () => {
  const bindings = await createImportOrigins(USE_SOURCES).rootBindings([useAt(3, "ts.Expression", "ts"), useAt(3, "Expression", "Expression")]);

  const expected = { kind: "import", root: "ts", member: "Expression", origin: { kind: "external", module: "typescript" } };
  assert.deepEqual(bindings, [expected, expected]);
});

test("a member of a call's result is rooted at the callee, which an import binds to a repository file", async () => {
  const [binding] = await createImportOrigins(USE_SOURCES).rootBindings([useAt(5, "helper(input).length", "helper")]);

  assert.deepEqual(binding, { kind: "import", root: "helper", origin: { kind: "repository", file: "src/local.ts" } });
});

test("a member call on an instantiation placed at its new keyword is rooted at the class, which the language declares", async () => {
  const bindings = await createImportOrigins(USE_SOURCES).rootBindings([useAt(4, "new Set", "Set"), useAt(4, "new Set", "add")]);

  assert.deepEqual(bindings, [{ kind: "ambient", root: "Set" }, { kind: "ambient", root: "Set" }]);
});

test("a value name the file's scoping binds inside the owner's syntax is local, and outside it is declared at the line of its name", async () => {
  const bindings = await createImportOrigins(USE_SOURCES).rootBindings([useAt(6, "seen.size", "seen"), useAt(11, "Holder", "Holder")]);

  assert.deepEqual(bindings, [{ kind: "local", root: "seen" }, { kind: "declared", root: "Holder", lines: [10], captured: false }]);
});

test("a value a function around the use declares is captured, while a function it declares or a value of the file is not", async () => {
  const factory: SourceFile = { path: "src/factory.ts", content: "const limit = 1;\nexport function make(deps: { open(): void }) {\n  function helper() {}\n  return function f() { deps.open(); helper.call(limit); };\n}\n" };
  const owner = { name: "f", line: 4, endLine: 4 };
  const at = (column: number, spelled: string) => ({ file: factory.path, line: 4, column, spelled, owner });
  const bindings = await createImportOrigins([...USE_SOURCES, factory]).rootBindings([at(25, "deps"), at(38, "helper"), at(50, "limit")]);

  assert.deepEqual(bindings, [
    { kind: "declared", root: "deps", lines: [2], captured: true },
    { kind: "declared", root: "helper", lines: [3], captured: false },
    { kind: "declared", root: "limit", lines: [1], captured: false },
  ]);
});

test("a type parameter the owner's syntax declares is local, at its own name and where it binds a type name", async () => {
  const mapped: SourceFile = { path: "src/mapped.ts", content: "export type Flags<T> = { [K in keyof T]?: K };\n" };
  const owner = { name: "Flags", line: 1, endLine: 1 };
  const bindings = await createImportOrigins([...USE_SOURCES, mapped]).rootBindings([{ file: mapped.path, line: 1, column: 27, spelled: "K", owner }, { file: mapped.path, line: 1, column: 43, spelled: "K", owner }]);
  assert.deepEqual(bindings, [{ kind: "local", root: "K" }, { kind: "local", root: "K" }]);
});

test("a type name a type parameter of the owner binds is local", async () => {
  const [binding] = await createImportOrigins(USE_SOURCES).rootBindings([useAt(3, "T {", "T")]);

  assert.deepEqual(binding, { kind: "local", root: "T" });
});

test("a use written on this, placed at this or at a later name, is bound to this with the member after it", async () => {
  const bindings = await createImportOrigins(USE_SOURCES).rootBindings([useAt(10, "this.run", "this"), useAt(10, "run()", "run")]);

  assert.deepEqual(bindings, [{ kind: "this", member: "run" }, { kind: "this", member: "run" }]);
});

test("a name nothing binds that the pinned libraries do not declare is unknown", async () => {
  const [binding] = await createImportOrigins(USE_SOURCES).rootBindings([useAt(7, "process", "process")]);

  assert.deepEqual(binding, { kind: "unknown" });
});

test("a library name the snapshot declares globally is unknown, never ambient", async () => {
  const global: SourceFile = { path: "src/globals.d.ts", content: "declare global {\n  var Set: unknown;\n}\nexport {};\n" };
  const [binding] = await createImportOrigins([...USE_SOURCES, global]).rootBindings([useAt(4, "new Set", "Set")]);

  assert.deepEqual(binding, { kind: "unknown" });
});

test("a site placed at any name of a chain, or past its calls, is rooted at its first name; a chain without the name is unknown", async () => {
  const bindings = await createImportOrigins(USE_SOURCES).rootBindings([useAt(6, "seen.size", "size"), useAt(5, "helper(input).length", "length"), useAt(6, "seen.size", "other")]);

  assert.deepEqual(bindings, [{ kind: "local", root: "seen" }, { kind: "import", root: "helper", origin: { kind: "repository", file: "src/local.ts" } }, { kind: "unknown" }]);
});

test("super is rooted at its class's extends expression, bound as that name is", async () => {
  const derived: SourceFile = { path: "src/derived.ts", content: "export class Failure extends Error {\n  constructor() { super('x'); }\n}\n" };
  const [binding] = await createImportOrigins([...USE_SOURCES, derived]).rootBindings([{ file: derived.path, line: 2, column: 19, spelled: "super", owner: { name: "constructor", line: 2, endLine: 2 } }]);

  assert.deepEqual(binding, { kind: "ambient", root: "Error" });
});

/**
 * The type a `value` parameter is annotated with on the last line, after the given lines, among the given extra sources,
 * placed where the receiver reader places it: past `readonly`.
 */
async function declaredTypeOf(annotation: string, spelled: string, lines: readonly string[] = [], extra: readonly SourceFile[] = []) {
  const content = [...lines, `export function run(value: ${annotation}): void { value.go(); }`];
  const file: SourceFile = { path: "src/use.ts", content: content.join("\n") };
  const manifest: SourceFile = { path: "package.json", content: JSON.stringify({ name: "shop", dependencies: { "@angular/router": "1.0.0" } }) };
  const site = { file: file.path, line: content.length, column: content.at(-1)!.indexOf(annotation.replace(/^readonly /, "")) + 1, spelled, owner: { name: "run", line: content.length, endLine: content.length } };
  const [type] = await createImportOrigins([CONFIG, manifest, LOCAL, file, ...extra]).declaredTypes([site]);
  return type;
}

test("an annotation names a library type by its keyword, array syntax or an unbound name, and a package's export by its exported name", async () => {
  for (const [annotation, spelled, lines, expected] of [
    ["Map<string, number>", "Map", [], { kind: "global", name: "Map" }],
    ["string", "string", [], { kind: "global", name: "String" }],
    ["number", "number", [], { kind: "global", name: "Number" }],
    ["readonly number[]", "Array", [], { kind: "global", name: "Array" }],
    ["Router", "Router", ["import { Router } from '@angular/router';"], { kind: "package", module: "@angular/router", name: "Router" }],
    ["Base", "Base", ["import { Router as Base } from '@angular/router';"], { kind: "package", module: "@angular/router", name: "Router" }],
    ["ng.Router", "ng", ["import * as ng from '@angular/router';"], { kind: "package", module: "@angular/router", name: "Router" }],
  ] as const) assert.deepEqual(await declaredTypeOf(annotation, spelled, lines), expected, annotation);
});

test("an annotation the repository declares, imports from its own files or packages, binds to nothing, or a repository type extends or implements, is unknown", async () => {
  const subtypes: SourceFile = {
    path: "src/subtypes.ts",
    content: ["import { Router as Base } from '@angular/router';", "export class AppRouter extends Base {}", "export class Cache extends Map<string, number> {}", "export interface Labels extends ReadonlyArray<string> {}"].join("\n"),
  };
  for (const [annotation, spelled, lines, extra] of [
    ["Local", "Local", ["class Local {}"], []],
    ["T", "T", ["type T = { go(): void };"], []],
    ["helper", "helper", ["import { helper } from './local';"], []],
    ["Shared", "Shared", ["import { Shared } from 'shop';"], []],
    ["ApiClient", "ApiClient", [], []],
    ["any", "any", [], []],
    ["Router", "Router", ["import { Router } from '@angular/router';"], [subtypes]],
    ["Map<string, number>", "Map", [], [subtypes]],
    ["ReadonlyArray<string>", "ReadonlyArray", [], [subtypes]],
  ] as const) assert.deepEqual(await declaredTypeOf(annotation, spelled, lines, extra), { kind: "unknown" }, `${annotation} ${extra.length}`);
});

test("a repository type whose heritage follows constants, type aliases and imports of the repository to a library type makes that type unknown", async () => {
  const aliases: SourceFile = {
    path: "src/aliases.ts",
    content: [
      "import { Router } from '@angular/router';",
      "import { Base } from './bases';",
      "const Fault = Error;",
      "type Items = Array<string>;",
      "const Navigator = Router;",
      "export class RepoError extends Fault {}",
      "export class RepoItems implements Items {}",
      "export class Repo extends Navigator {}",
      "export class Cache extends Base {}",
    ].join("\n"),
  };
  const bases: SourceFile = { path: "src/bases.ts", content: "export const Base = Map;" };
  for (const [annotation, spelled, lines] of [
    ["Error", "Error", []],
    ["string[]", "Array", []],
    ["Router", "Router", ["import { Router } from '@angular/router';"]],
    ["Map<string, number>", "Map", []],
  ] as const) assert.deepEqual(await declaredTypeOf(annotation, spelled, lines, [aliases, bases]), { kind: "unknown" }, annotation);
});

test("heritage that names no repository class or interface and no library type makes every annotation unknown", async () => {
  const holder: SourceFile = { path: "src/holder.ts", content: "export class Holder { static Inner = Map; }" };
  for (const heritage of [
    ["function Mixin(Base: ErrorConstructor) { return class extends Base {}; }", "export class RepoError extends Mixin(Error) {}"],
    ["import { mixinWith } from '@angular/router';", "export class Mixed extends mixinWith(Map) {}"],
    ["export class Dynamic extends (globalThis as any).Base {}"],
    ["export class Collating extends Intl.Collator {}"],
    ["import * as holders from './holder';", "export class Deep extends holders.Holder.Inner {}"],
    ["import { Holder } from './holder';", "export function scoped(scope: object) { with (scope) { return class extends Holder {}; } }"],
    ["let Kind = Map;", "Kind = Set;", "export class Changing extends Kind {}"],
    ["export class Chosen extends (Math.random() > 0.5 ? Error : Map) {}"],
    ["export class Broken extends Set {", "  run(: void {}"],
  ]) {
    const extra: SourceFile = { path: "src/heritage.ts", content: heritage.join("\n") };
    assert.deepEqual(await declaredTypeOf("Set<string>", "Set", [], [extra, holder]), { kind: "unknown" }, heritage.at(-1));
  }
});

test("heritage between repository classes and interfaces, imported or local, proves the library types they do not reach", async () => {
  const shapes: SourceFile = {
    path: "src/shapes.ts",
    content: ["import { Shape } from './shape';", "import * as kinds from './shape';", "interface Named {}", "export class Square extends Shape implements Named {}", "export class Round extends kinds.Shape {}", "const Alias = Square;", "export class Box extends Alias {}", "type Outline = Named;", "export class Frame implements Outline {}", "import type { Outlined } from './shape';", "export interface Drawn extends Outlined, kinds.Outlined {}", "type Sized = { size: number };", "export interface Measured extends Sized {}"].join("\n"),
  };
  const shape: SourceFile = { path: "src/shape.ts", content: "export class Shape {}\nexport interface Outlined {}" };
  assert.deepEqual(await declaredTypeOf("Map<string, number>", "Map", [], [shapes, shape]), { kind: "global", name: "Map" });
});
