import { test } from "node:test";
import assert from "node:assert/strict";
import { createTypeResolution, defaultTypeResolutionDeps, type SnapshotSource, type TypeResolutionDeps } from "./type-resolution.adapter.ts";
import type { ReferenceSite } from "../../domain/relations/resolved-reference.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { ResolvedTarget } from "../../domain/relations/resolved-reference.ts";

const MODULES: Record<string, string> = {
  "@dep/lib/package.json": JSON.stringify({ name: "@dep/lib", types: "index.d.ts" }),
  "@dep/lib/index.d.ts": "export declare function remote(): void;\n",
};

function deps(): TypeResolutionDeps {
  return { ...defaultTypeResolutionDeps("/nonexistent-type-root"), readModule: (relative) => MODULES[relative] };
}

function source(path: string, text: string): SnapshotSource {
  return { path, text };
}

/** The site of the last occurrence of `needle`, which is where a call names it rather than where it is declared. */
function siteAt(sources: readonly SnapshotSource[], file: string, needle: string): ReferenceSite {
  const text = sources.find((source) => source.path === file)?.text ?? "";
  const index = text.lastIndexOf(needle);
  assert.ok(index >= 0, `${needle} in ${file}`);
  const before = text.slice(0, index);
  return { file, line: before.split("\n").length, column: index - before.lastIndexOf("\n"), symbol: needle };
}

function only(findings: readonly Finding<ResolvedTarget>[]): Finding<ResolvedTarget> {
  assert.equal(findings.length, 1);
  const finding = findings[0];
  assert.ok(finding !== undefined);
  return finding;
}

function targetOf(finding: Finding<ResolvedTarget>): ResolvedTarget {
  assert.equal(finding.status, "complete");
  if (finding.status !== "complete") throw new Error("a complete finding was expected");
  return finding.value;
}

const STORE = source("src/store.ts", ["export class Store {", "  load(): number {", "    return 1;", "  }", "}", ""].join("\n"));

const PAGE = source(
  "src/page.ts",
  ["import { Store } from './store';", "export class Page {", "  private store = new Store();", "  run(): number {", "    return this.store.load();", "  }", "}", ""].join(
    "\n",
  ),
);

const API = source("src/api.ts", ["import { remote } from '@dep/lib';", "export function call(): void {", "  remote();", "}", ""].join("\n"));

const DECLARED_CONFIG = source(
  "tsconfig.json",
  JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } } }),
);

const ALIASED_SERVICE = source("src/address.service.ts", ["export class AddressService {", "  resolve(): number {", "    return 1;", "  }", "}", ""].join("\n"));

const ALIASED_PAGE = source(
  "src/page.alias.ts",
  ["import { AddressService } from '@app/address.service';", "export function run(): number {", "  return new AddressService().resolve();", "}", ""].join("\n"),
);

const EXTENDED_BASE = source(
  "tsconfig.base.json",
  JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } } }),
);

const EXTENDED_ROOT = source("tsconfig.json", JSON.stringify({ extends: "./tsconfig.base.json" }));

const LIB_FORMAT = source("src/lib/format.ts", ["export function format(): number {", "  return 1;", "}", ""].join("\n"));

const LIB_PAGE = source("src/lib.page.ts", ["import { format } from '@lib/format';", "export function run(): number {", "  return format();", "}", ""].join("\n"));

test("a call through a class field resolves to the declaration of its member, with its span", () => {
  const sources = [STORE, PAGE];
  const resolution = createTypeResolution({ sources, typeRoot: "/nowhere" }, deps());

  assert.deepEqual(only(resolution.resolve([siteAt(sources, "src/page.ts", "load")])), {
    status: "complete",
    value: { kind: "repository", file: "src/store.ts", symbol: "load", line: 2, endLine: 4 },
    evidence: [{ path: "src/page.ts", line: 5 }],
  });
});

test("a site whose column names the receiver still resolves the callee, as the index reports it", () => {
  const sources = [STORE, PAGE];
  const resolution = createTypeResolution({ sources, typeRoot: "/nowhere" }, deps());

  assert.deepEqual(targetOf(only(resolution.resolve([{ file: "src/page.ts", line: 5, column: 12, symbol: "load" }]))), {
    kind: "repository",
    file: "src/store.ts",
    symbol: "load",
    line: 2,
    endLine: 4,
  });
});

test("a position that does not land on the reference's name is unknown, never an answer about another name", () => {
  const sources = [STORE, PAGE];
  const resolution = createTypeResolution({ sources, typeRoot: "/nowhere" }, deps());

  /** Column 17 is the `store` receiver; the index reported the reference as the `load` call it belongs to. */
  assert.deepEqual(only(resolution.resolve([{ file: "src/page.ts", line: 5, column: 17, symbol: "load" }])), {
    status: "unknown",
    reason: "unresolved",
    evidence: [{ path: "src/page.ts", line: 5 }],
  });
});

test("a call the type root declares is external, named after the package that declares it", () => {
  const sources = [API];
  const resolution = createTypeResolution({ sources, typeRoot: "/nowhere" }, deps());

  assert.deepEqual(only(resolution.resolve([siteAt(sources, "src/api.ts", "remote")])).status, "complete");
  assert.deepEqual(targetOf(only(resolution.resolve([siteAt(sources, "src/api.ts", "remote")]))), { kind: "external", module: "@dep/lib" });
});

test("a call whose import only the snapshot's own `paths` resolves reaches the repository declaration", () => {
  const sources = [DECLARED_CONFIG, ALIASED_SERVICE, ALIASED_PAGE];
  const resolution = createTypeResolution({ sources, typeRoot: "/nowhere" }, deps());

  assert.deepEqual(targetOf(only(resolution.resolve([siteAt(sources, "src/page.alias.ts", "resolve")]))), {
    kind: "repository",
    file: "src/address.service.ts",
    symbol: "resolve",
    line: 2,
    endLine: 4,
  });
});

test("a configuration reached through `extends` decides the paths a call resolves through", () => {
  const sources = [EXTENDED_BASE, EXTENDED_ROOT, LIB_FORMAT, LIB_PAGE];
  const resolution = createTypeResolution({ sources, typeRoot: "/nowhere" }, deps());

  assert.deepEqual(targetOf(only(resolution.resolve([siteAt(sources, "src/lib.page.ts", "format")]))), {
    kind: "repository",
    file: "src/lib/format.ts",
    symbol: "format",
    line: 1,
    endLine: 3,
  });
});

test("a site whose file the snapshot does not hold is unknown, not an empty answer", () => {
  const resolution = createTypeResolution({ sources: [STORE], typeRoot: "/nowhere" }, deps());

  assert.deepEqual(only(resolution.resolve([{ file: "src/ghost.ts", line: 1, column: 1 }])), {
    status: "unknown",
    reason: "source-unreadable",
    evidence: [{ path: "src/ghost.ts", line: 1 }],
  });
});

test("a name no declaration answers is unknown with the reason, never a guess", () => {
  const bare = source("src/bare.ts", ["export function run(): void {", "  missingFunction();", "}", ""].join("\n"));
  const resolution = createTypeResolution({ sources: [bare], typeRoot: "/nowhere" }, deps());

  assert.deepEqual(only(resolution.resolve([siteAt([bare], "src/bare.ts", "missingFunction")])), {
    status: "unknown",
    reason: "unresolved",
    evidence: [{ path: "src/bare.ts", line: 2 }],
  });
});

test("a read under the type root cannot leave it, however it spells the path", () => {
  const read = defaultTypeResolutionDeps("/root/modules").readModule;

  assert.equal(read("../../../etc/passwd"), undefined);
  assert.equal(read("/etc/passwd"), undefined);
});

test("a typed numeric call resolves its numeric overload rather than the first declaration", () => {
  const sources = [source("overload.ts", "function pick(x: string): string;\nfunction pick(x: number): number;\nfunction pick(x: string | number) { return x; }\npick(1);\npick('x');")];
  const resolution = createTypeResolution({ sources, typeRoot: "/nowhere" }, deps());
  const numeric = only(resolution.resolve([{ file: "overload.ts", line: 4, column: 1, symbol: "pick" }]));
  assert.deepEqual(targetOf(numeric), { kind: "repository", file: "overload.ts", symbol: "pick", line: 2, endLine: 2 });
  assert.deepEqual(targetOf(only(resolution.resolve([{ file: "overload.ts", line: 5, column: 1, symbol: "pick" }]))), { kind: "repository", file: "overload.ts", symbol: "pick", line: 1, endLine: 1 });
});

test("overload recovery and indeterminate arguments retain uncertainty", () => {
  const sources = [source("overload.ts", "function pick(x: string): string;\nfunction pick(x: number): number;\nfunction pick(x: string | number) { return x; }\ndeclare const a: any;\ndeclare const u: unknown;\ndeclare const union: string | number;\npick(true);\npick(a);\npick(u);\npick(union);")];
  const resolution = createTypeResolution({ sources, typeRoot: "/nowhere" }, deps());
  for (const line of [7, 8, 9, 10])
    assert.equal(only(resolution.resolve([{ file: "overload.ts", line, column: 1, symbol: "pick" }])).status, "unknown");
});

test("full graph expression metadata anchors a generic receiver without borrowing its nested call", () => {
  const text = "class Service { run() {} }\nfunction identity<T>(x:T):T { return x; }\nfunction use(s:Service) { identity(s).run(); identity(s).run(); }";
  const resolution = createTypeResolution({ sources: [source("generic.ts", text)], typeRoot: "/nowhere" }, deps());
  const column = text.split("\n")[2]!.indexOf("identity(s)") + 1;
  const site = { file: "generic.ts", line: 3, column, symbol: "run", fullName: "identity().run", kind: "calls" };
  assert.deepEqual(targetOf(only(resolution.resolve([site]))), { kind: "repository", file: "generic.ts", symbol: "run", line: 1, endLine: 1 });
  assert.equal(only(resolution.resolve([{ ...site, column: column + 1 }])).status, "unknown");
  assert.equal(only(resolution.resolve([{ ...site, fullName: "other().run" }])).status, "unknown");
});

test("a constructor keeps its class target and uses the decorated declaration name anchor", () => {
  const sources = [source("decorated.ts", "declare function decorate(x: unknown): any;\n@decorate\nclass Service {}\nnew Service();")];
  const resolution = createTypeResolution({ sources, typeRoot: "/nowhere" }, deps());
  assert.deepEqual(targetOf(only(resolution.resolve([siteAt(sources, "decorated.ts", "Service")]))), { kind: "repository", file: "decorated.ts", symbol: "Service", line: 3, endLine: 3 });
});

test("a resolved occurrence in a class decorator attests its declaration-name owner", () => {
  const text = "class Service { run() { return 1; } }\nconst service = new Service();\nfunction identity<T>(x:T):T { return x; }\nfunction decorate(x:unknown): ClassDecorator { return () => {}; }\n@decorate(identity(service).run())\nexport class Screen {}";
  const resolver = createTypeResolution({ sources: [source("decorated.ts", text)], typeRoot: "/nowhere" }, deps());
  const finding = only(resolver.resolve([{ file: "decorated.ts", line: 5, column: 11, symbol: "run", fullName: "identity().run", kind: "calls" }]));
  assert.equal(finding.status, "complete");
  assert.deepEqual("sourceOwner" in finding && finding.sourceOwner, { file: "decorated.ts", symbol: "Screen", line: 6, column: 14 });
});

test("anchored expression proofs preserve UTF-16 columns, nested spellings, and refuse stale or unsupported sites", () => {
  const text = "class Service { run() {} }\nfunction identity<T>(x:T):T { return x; }\nfunction use(s:Service) { const café='😀'; identity(s).run(); identity(s).run(); }\nfunction nested(s:Service) { identity(identity(s)).run(); }\nfunction zero(s:Service) {\nidentity(s).run();\n}";
  const resolution = createTypeResolution({ sources: [source("matrix.ts", text)], typeRoot: "/nowhere" }, deps());
  const first = text.split("\n")[2]!.indexOf("identity(s)") + 1;
  const nested = text.split("\n")[3]!.indexOf("identity(identity") + 1;
  for (const site of [{ line: 3, column: first, fullName: "identity().run", symbol: "run" }, { line: 4, column: nested, fullName: "identity().run", symbol: "run" }, { line: 6, column: 1, fullName: "identity().run", symbol: "run" }]) {
    assert.deepEqual(targetOf(only(resolution.resolve([{ file: "matrix.ts", kind: "calls", ...site }]))), { kind: "repository", file: "matrix.ts", symbol: "run", line: 1, endLine: 1 });
  }
  assert.deepEqual(targetOf(only(resolution.resolve([{ file: "matrix.ts", kind: "calls", line: 4, column: nested, fullName: "identity", symbol: "identity" }]))), { kind: "repository", file: "matrix.ts", symbol: "identity", line: 2, endLine: 2 });
  for (const override of [{ column: first - 1 }, { column: first + 1 }, { column: 1000 }, { column: 0 }, { line: 99 }, { fullName: "other().run" }, { kind: "imports" }]) {
    assert.equal(only(resolution.resolve([{ file: "matrix.ts", line: 3, column: first, symbol: "run", fullName: "identity().run", kind: "calls", ...override }])).status, "unknown");
  }
  const computed = source("computed.ts", "class Service { run() {} }\nfunction use(s:Service) { s['run'](); }");
  assert.equal(only(createTypeResolution({ sources: [computed], typeRoot: "/nowhere" }, deps()).resolve([{ file: "computed.ts", line: 2, column: 27, symbol: "run", fullName: "s.run", kind: "calls" }])).status, "unknown");
});
