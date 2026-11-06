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
  const reader = createImportOrigins(SOURCES, (file) => (parsed.push(file.path), sourceTree({ ...file }, ts.ScriptTarget.Latest, true)));
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
    "",
  ].join("\n"),
};
const USE_SOURCES = [CONFIG, { path: "package.json", content: JSON.stringify({ dependencies: { typescript: "6.0.3" } }) }, LOCAL, USES];

/** The 1-based place of the first `spelling` on a line of the uses fixture. */
function useAt(line: number, spelling: string, root: string) {
  return { file: USES.path, line, column: USES.content.split("\n")[line - 1]!.indexOf(spelling) + 1, root };
}

test("a qualified type name is rooted at its first name, which an import binds to a package", async () => {
  const [binding] = await createImportOrigins(USE_SOURCES).rootBindings([useAt(3, "ts.Expression", "ts")]);

  assert.deepEqual(binding, { kind: "import", origin: { kind: "external", module: "typescript" } });
});

test("a member of a call's result is rooted at the callee, which an import binds to a repository file", async () => {
  const [binding] = await createImportOrigins(USE_SOURCES).rootBindings([useAt(5, "helper(input).length", "helper")]);

  assert.deepEqual(binding, { kind: "import", origin: { kind: "repository", file: "src/local.ts" } });
});

test("a member call on an instantiation placed at its new keyword is rooted at the class, which the language declares", async () => {
  const [binding] = await createImportOrigins(USE_SOURCES).rootBindings([useAt(4, "new Set", "Set")]);

  assert.deepEqual(binding, { kind: "ambient" });
});

test("a value name the file's scoping binds is declared at the line of its declaration", async () => {
  const [binding] = await createImportOrigins(USE_SOURCES).rootBindings([useAt(6, "seen.size", "seen")]);

  assert.deepEqual(binding, { kind: "declared", lines: [4] });
});

test("a type name a type parameter binds is declared at the type parameter", async () => {
  const [binding] = await createImportOrigins(USE_SOURCES).rootBindings([useAt(3, "T {", "T")]);

  assert.deepEqual(binding, { kind: "declared", lines: [3] });
});

test("a use written on this is bound to this", async () => {
  const [binding] = await createImportOrigins(USE_SOURCES).rootBindings([useAt(10, "this.run", "this")]);

  assert.deepEqual(binding, { kind: "this" });
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

test("a place that spells another root than the site's is unknown", async () => {
  const [binding] = await createImportOrigins(USE_SOURCES).rootBindings([useAt(6, "seen.size", "size")]);

  assert.deepEqual(binding, { kind: "unknown" });
});
