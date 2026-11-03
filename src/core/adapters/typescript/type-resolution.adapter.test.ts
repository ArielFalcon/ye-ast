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
