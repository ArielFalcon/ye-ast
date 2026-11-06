import assert from "node:assert/strict";
import test from "node:test";
import { fakeCodeGraph, fakeNode } from "../navigation/fake-code-graph.testing.ts";
import { fakeLive, type FakeLive } from "../live/fake-live.testing.ts";
import type { OutlineSelector } from "../../ports/outline-queries.port.ts";
import type { VcsFault } from "../../ports/vcs.port.ts";
import type { ResolvedNameSite, RootBinding, UseSite } from "../../ports/import-origins.port.ts";
import type { RootOrigin } from "../../domain/impact/edge-policy.ts";
import type { ModuleDependency } from "../../domain/impact/module-dependency.ts";
import type { OutlineUse } from "../../domain/outline/outline-fact.ts";
import { createSnapshotDataCache } from "../snapshot/snapshot-data-cache.ts";
import { createOutlineQueries, type OutlineQueriesDeps } from "./outline-queries.ts";

const SHA = "a".repeat(40);
const SUMMARY = { filesIndexed: 1, filesSkipped: 0, filesErrored: 0, filesNotIndexed: [], versions: { codegraph: "fake", schema: 0, extraction: 0 } };
const STORE = "/scratch/store";

interface Options {
  live?: FakeLive;
  /** The paths the commit export wrote, so the index's own list of what it could not hold is meaningful. */
  written?: readonly string[];
  nodes?: Parameters<typeof fakeCodeGraph>[0];
  edges?: Parameters<typeof fakeCodeGraph>[1];
  /** What the path matcher answers for a repository path and a declared glob; every glob matches by default. */
  matches?: (path: string, glob: string) => boolean;
  snapshotCache?: OutlineQueriesDeps["snapshotCache"];
  /** The files the unmodelled-constructs reader marks among the sources it receives. */
  unmodelled?: readonly string[];
  /** The Vcs lists and writes apart; writing answers the fault when given. */
  lazy?: { materialize?: VcsFault };
  unresolved?: Parameters<typeof fakeCodeGraph>[2];
  /** Where each resolved edge's root is bound, by `<line>:<1-based column>`; unknown otherwise. */
  roots?: Readonly<Record<string, RootOrigin>>;
  /** What binds each use's root, by `<line>:<1-based column> <root>`; unknown otherwise. */
  bindings?: Readonly<Record<string, RootBinding>>;
  /** The module statements the TypeScript reader answers. */
  dependencies?: readonly ModuleDependency[];
}

function setup(options: Options = {}) {
  const log = { closed: 0, reads: 0, extractions: 0, readPaths: [] as string[][], materialized: 0, readBeforeWrite: false, moduleReads: [] as (readonly string[] | undefined)[], scanned: [] as string[][] };
  const store = { ...fakeCodeGraph(options.nodes ?? [], options.edges ?? [], options.unresolved ?? []), close: () => void (log.closed += 1) };
  const written = options.written ?? [];
  const deps = {
    vcs: {
      resolveCommit: async () => ({ ok: true, value: SHA }),
      exportCommit: async () => ({ ok: true, value: { files: written.map((path) => ({ path, blob: "1", written: true })), skipped: [] } }),
      ...(options.lazy && {
        listCommit: async () => ({ ok: true, value: { files: written.map((path) => ({ path, blob: "1", written: true })), skipped: [] } }),
        materializeCommit: async () => (log.materialized++, options.lazy!.materialize ? { ok: false, fault: options.lazy!.materialize } : { ok: true, value: undefined }),
      }),
    },
    scratch: { create: async () => "/scratch/head", remove: async () => undefined },
    reader: { read: async (_root: string, paths: readonly string[]) => { log.reads++; if (options.lazy && log.materialized === 0) log.readBeforeWrite = true; log.readPaths.push([...paths]); return paths.map((path) => ({ path, content: "" })); } },
    extractor: { extract: () => { log.extractions++; return []; } },
    digest: { of: (value: string) => `digest:${value}` },
    producer: { name: "ye-ast", version: "0.0.0" },
    matcher: { matches: options.matches ?? (() => true) },
    graph: { index: async () => ({ ok: true, value: SUMMARY }), open: () => ({ ok: true, value: store }) },
    engines: {},
    moduleReaders: [{ extract: async (_sources: unknown, read?: { files?: readonly string[] }) => { log.moduleReads.push(read?.files); return { files: written.map((file) => ({ file, statements: [], moduleOnly: true })), dependencies: options.dependencies ?? [], unread: [] }; } }],
    importOrigins: () => ({
      origins: async () => [],
      rootOrigins: async (sites: readonly ResolvedNameSite[]) => sites.map((site): RootOrigin => options.roots?.[`${site.line}:${site.column}`] ?? { status: "unknown", reason: "unresolved", evidence: [] }),
      rootBindings: async (sites: readonly UseSite[]) => sites.map((site): RootBinding => options.bindings?.[`${site.line}:${site.column} ${site.spelled}`] ?? { kind: "unknown" }),
    }),
    ...(options.snapshotCache && { snapshotCache: options.snapshotCache }),
    ...(options.unmodelled && { unmodelled: { extract: async (sources: readonly { path: string }[]) => (log.scanned.push(sources.map(({ path }) => path)), sources).map(({ path }) => path).filter((path) => options.unmodelled!.includes(path)) } }),
    ...(options.live && { live: options.live.deps, trust: { read: async () => ({ ok: true, value: "trusted" }) } }),
  } as unknown as OutlineQueriesDeps;
  return { queries: createOutlineQueries(deps), log, store };
}

test("a requested file the scope leaves out is unknown with its evidence, not an empty outline", async () => {
  const { queries } = setup({ matches: (path, glob) => (glob === "docs/**" ? path.startsWith("docs/") : true) });

  const answer = await queries.outline({ repo: "/work/shop", repoId: "shop", revision: "HEAD", files: ["src/A.ts", "docs/notes.md"], scope: { exclude: ["docs/**"] } });

  assert.equal(answer.ok, true);
  const fact = answer.ok ? answer.value : undefined;
  assert.equal(fact?.status, "unknown");
  assert.equal(fact?.status === "unknown" ? fact.reason : "", "out-of-scope");
  assert.deepEqual(fact?.evidence, [{ path: "docs/notes.md", line: 1 }]);
});

test("a file the index holds nothing of is a cut, and says which reason, so an empty list never reads as nothing declared", async () => {
  const { queries } = setup({ written: ["src/Held.ts"] });

  const answer = await queries.outline({ repo: "/work/shop", repoId: "shop", revision: "HEAD", files: ["src/Held.ts", "src/Never.ts"] });

  const fact = answer.ok ? answer.value : undefined;
  assert.equal(fact?.status, "partial");
  assert.deepEqual(fact?.value, { files: [], unheld: ["src/Held.ts", "src/Never.ts"] });
  assert.deepEqual(fact?.cuts?.map((cut) => [cut.kind, cut.at]), [
    ["no-extractor", ["src/Held.ts"]],
    ["not-exported", ["src/Never.ts"]],
  ]);
});

test("a file the index holds answers its declarations and closes the store", async () => {
  const { queries, log, store } = setup({
    written: ["src/Order.java"],
    nodes: [fakeNode("Order.java", "file", "src/Order.java", 1, 40), fakeNode("Order.total", "method", "src/Order.java", 20, 24, "total")],
  });
  assert.ok(store);

  const answer = await queries.outline({ repo: "/work/shop", repoId: "shop", revision: "HEAD", files: ["src/Order.java"] });

  const fact = answer.ok ? answer.value : undefined;
  assert.equal(fact?.status, "complete");
  assert.deepEqual(fact?.value, { files: [{ file: "src/Order.java", declarations: [{ kind: "method", name: "total", line: 20, endLine: 24 }], imports: [] }], unheld: [] });
  assert.equal(log.closed, 1, "the store is closed on every path that opened it");
});

for (const live of [false, true]) {
  test(`a ${live ? "live" : "revisioned"} outline reads the index and its sources without extracting entrypoints`, async () => {
    const mirror = live ? fakeLive({ "src/Order.java": "1" }) : undefined;
    const { queries, log } = setup({
      written: ["src/Order.java"],
      nodes: [fakeNode("Order.total", "method", "src/Order.java", 20, 24, "total")],
      ...(mirror && { live: mirror }),
    });

    const answer = await queries.outline({ repo: "/work/shop", repoId: "shop", files: ["src/Order.java"], ...(live ? { live: true } : { revision: "HEAD" }) });

    assert.ok(answer.ok);
    assert.equal(answer.value.status, "complete");
    assert.deepEqual(answer.value.value, { files: [{ file: "src/Order.java", declarations: [{ kind: "method", name: "total", line: 20, endLine: 24 }], imports: [] }], unheld: [] });
    assert.equal(log.extractions, 0);
    assert.equal(log.closed, 1);
    if (mirror) assert.deepEqual(mirror.held, { locks: 1, released: 1 });
  });
}

test("an aborted live outline returns the cancellation fault before acquiring its mirror or reading its index", async () => {
  const mirror = fakeLive({ "src/Order.java": "1" });
  const { queries, log } = setup({ live: mirror });
  const controller = new AbortController();
  controller.abort();

  const answer = await queries.outline({ repo: "/work/shop", repoId: "shop", files: ["src/Order.java"], live: true, signal: controller.signal });

  assert.ok(!answer.ok);
  assert.equal(answer.fault.kind, "aborted");
  assert.equal(log.closed, 0);
  assert.equal(log.reads, 0);
  assert.equal(log.extractions, 0);
  assert.deepEqual(mirror.held, { locks: 0, released: 0 });
});

const API = "src/api.ts";
const TWO_CLASSES = {
  written: [API],
  nodes: [
    fakeNode("api", "file", API, 1, 40),
    fakeNode("A", "class", API, 1, 12, "A"),
    fakeNode("A.m", "method", API, 2, 6, "m"),
    fakeNode("A.m.inner", "function", API, 3, 5, "inner"),
    fakeNode("A.n", "method", API, 8, 10, "n"),
    fakeNode("B", "class", API, 14, 24, "B"),
    fakeNode("B.m", "method", API, 15, 18, "m"),
    fakeNode("Aardvark", "constant", API, 30, 30, "Aardvark"),
  ],
  edges: [
    { from: "api", to: "A", kind: "contains" },
    { from: "api", to: "B", kind: "contains" },
    { from: "A", to: "A.m", kind: "contains" },
    { from: "A.m", to: "A.m.inner", kind: "contains" },
    { from: "A", to: "A.n", kind: "contains" },
    { from: "B", to: "B.m", kind: "contains" },
    { from: "api", to: "other", kind: "imports", line: 1 },
  ],
};

async function focusOf(focus: readonly OutlineSelector[]) {
  return setup(TWO_CLASSES).queries.outline({ repo: "/work/shop", repoId: "shop", revision: "HEAD", focus });
}

function focusValue(answer: Awaited<ReturnType<typeof focusOf>>) {
  assert.ok(answer.ok && answer.value.status === "complete", JSON.stringify(answer));
  return answer.value.value;
}

test("a dotted focus answers only that member with its subtree and its containers, without siblings nor imports", async () => {
  const value = focusValue(await focusOf([{ file: API, symbol: "A.m" }]));
  assert.deepEqual(value, {
    focus: [{
      file: API,
      selector: "A.m",
      path: "A.m",
      ancestors: [{ kind: "class", name: "A", line: 1, endLine: 12 }],
      declaration: { kind: "method", name: "m", line: 2, endLine: 6, children: [{ kind: "function", name: "inner", line: 3, endLine: 5 }] },
      omitted: 4,
      uses: [],
    }],
    unheld: [],
  });
});

test("the matches of several selectors come in line order, whatever order the request gives", async () => {
  const value = focusValue(await focusOf([{ file: API, symbol: "m" }, { file: API, symbol: "Aardvark" }, { file: API, line: 16 }]));
  assert.deepEqual(value.focus?.map((match) => [match.path, match.selector]), [["A.m", "m"], ["B.m", "16"], ["B.m", "m"], ["Aardvark", "Aardvark"]]);
});

test("a focus symbol that matches no declaration is an unknown-symbol fault whose candidates are the file's dotted paths", async () => {
  const answer = await focusOf([{ file: API, symbol: "B.n" }]);
  assert.ok(!answer.ok);
  assert.deepEqual(answer.fault.kind === "unknown-symbol" && answer.fault.entries, [{ file: API, symbol: "B.n", candidates: ["A", "A.m", "A.m.inner", "A.n", "Aardvark", "B", "B.m"] }]);
});

test("a focus line outside every declaration is a top-level-line fault with the file's dotted paths", async () => {
  const answer = await focusOf([{ file: API, symbol: "A" }, { file: API, line: 27 }]);
  assert.ok(!answer.ok);
  assert.deepEqual(answer.fault.kind === "top-level-line" && answer.fault.entries, [{ file: API, line: 27, candidates: ["A", "A.m", "A.m.inner", "A.n", "Aardvark", "B", "B.m"] }]);
});

test("a focus on a file the index holds nothing of leaves it unheld with its cut instead of a fault", async () => {
  const answer = await setup(TWO_CLASSES).queries.outline({ repo: "/work/shop", repoId: "shop", revision: "HEAD", focus: [{ file: "src/gone.ts", symbol: "A" }] });
  assert.ok(answer.ok && answer.value.status === "partial");
  assert.deepEqual(answer.value.value, { focus: [], unheld: ["src/gone.ts"] });
  assert.deepEqual(answer.value.cuts.map((cut) => cut.kind), ["not-exported"]);
});

test("a focused fact records its selectors once each in a fixed order, in place of files", async () => {
  const answer = await focusOf([{ file: API, symbol: "m" }, { file: API, line: 16 }, { file: API, symbol: "m" }]);
  assert.ok(answer.ok);
  assert.deepEqual(answer.value.inputs.declaredConfig, { focus: [`${API}:16`, `${API}:m`] });
});

const POINT = "src/Point.java";
const POINT_INDEX = { written: [POINT, "src/Order.java"], nodes: [fakeNode("Order.total", "method", "src/Order.java", 20, 24, "total"), fakeNode("origin", "method", POINT, 4, 6, "origin")], unmodelled: [POINT] };

test("a listed file whose declarations the graph cannot place is cut, so its outline is never complete", async () => {
  const { queries } = setup(POINT_INDEX);

  const answer = await queries.outline({ repo: "/work/shop", repoId: "shop", revision: "HEAD", files: [POINT, "src/Order.java"] });

  assert.ok(answer.ok && answer.value.status === "partial");
  assert.deepEqual(answer.value.cuts.map((cut) => [cut.kind, cut.at]), [["no-extractor", [POINT]]]);
});

test("a focus on a file the graph cannot place is cut, scanning that file alone", async () => {
  const { queries, log } = setup(POINT_INDEX);

  const answer = await queries.outline({ repo: "/work/shop", repoId: "shop", revision: "HEAD", focus: [{ file: POINT, symbol: "origin" }] });

  assert.ok(answer.ok && answer.value.status === "partial");
  assert.deepEqual(answer.value.cuts.map((cut) => [cut.kind, cut.at]), [["no-extractor", [POINT]]]);
  assert.deepEqual(log.scanned, [[POINT]]);
});

test("a focus on a written Java file writes the snapshot before reading it, once, although the index build needs it too", async () => {
  const placed = setup({ ...POINT_INDEX, lazy: {} });
  await placed.queries.outline({ repo: "/work/shop", repoId: "shop", revision: "HEAD", focus: [{ file: "src/Order.java", symbol: "total" }] });
  assert.deepEqual([placed.log.materialized, placed.log.reads], [1, 1]);
  assert.equal(placed.log.readBeforeWrite, false);
});

test("a focus whose file cannot be written answers the export fault, not an unavailable index", async () => {
  const { queries, log } = setup({ ...POINT_INDEX, lazy: { materialize: { kind: "export-write-failed", detail: "disk" } } });

  const answer = await queries.outline({ repo: "/work/shop", repoId: "shop", revision: "HEAD", focus: [{ file: POINT, symbol: "origin" }] });

  assert.ok(!answer.ok && answer.fault.kind === "export-write-failed");
  assert.equal(log.reads, 0);
});

test("a requested-files module read is repeated for every request and never answered from a retained whole-universe output", async () => {
  const snapshotCache = createSnapshotDataCache(1 << 20);
  const written = ["src/Order.java", "src/Cart.java"];
  const { queries, log } = setup({ written, snapshotCache });
  await queries.outline({ repo: "/work/shop", repoId: "shop", revision: "HEAD", files: ["src/Order.java"] });
  await queries.outline({ repo: "/work/shop", repoId: "shop", revision: "HEAD", files: ["src/Cart.java"] });
  assert.deepEqual(log.moduleReads, [["src/Order.java"], ["src/Cart.java"]]);
});

const USE = "src/use.ts";
const LIB = "src/lib.ts";
const USES_INDEX: Options = {
  written: [USE, LIB],
  nodes: [
    fakeNode("useFile", "file", USE, 1, 60),
    fakeNode("top", "constant", USE, 2, 2, "top"),
    fakeNode("run", "function", USE, 10, 20, "run"),
    fakeNode("inner", "function", USE, 12, 14, "inner"),
    fakeNode("Svc", "class", USE, 30, 40, "Svc"),
    fakeNode("Svc.go", "method", USE, 31, 33, "go"),
    fakeNode("Svc.load", "method", USE, 34, 36, "load"),
    fakeNode("Svc.cache", "property", USE, 37, 37, "cache"),
    fakeNode("libFile", "file", LIB, 1, 20),
    fakeNode("helper", "function", LIB, 1, 3, "helper"),
    fakeNode("Other", "class", LIB, 5, 9, "Other"),
    fakeNode("Node", "interface", LIB, 11, 13, "Node"),
  ],
  edges: [
    { from: "useFile", to: "top", kind: "contains" },
    { from: "useFile", to: "run", kind: "contains" },
    { from: "run", to: "inner", kind: "contains" },
    { from: "useFile", to: "Svc", kind: "contains" },
    { from: "Svc", to: "Svc.go", kind: "contains" },
    { from: "Svc", to: "Svc.load", kind: "contains" },
    { from: "Svc", to: "Svc.cache", kind: "contains" },
    { from: "libFile", to: "helper", kind: "contains" },
    { from: "libFile", to: "Other", kind: "contains" },
    { from: "libFile", to: "Node", kind: "contains" },
    { from: "useFile", to: "helper", kind: "imports", line: 1, column: 9 },
    { from: "run", to: "helper", kind: "calls", line: 11, column: 2 },
    { from: "run", to: "helper", kind: "references", line: 15, column: 4 },
    { from: "run", to: "Other", kind: "calls", line: 16, column: 2, synthesizedBy: "interface-impl" },
    { from: "run", to: "Node", kind: "references", line: 17, column: 10 },
    { from: "run", to: "inner", kind: "calls", line: 18, column: 2 },
    { from: "run", to: "Other", kind: "references" },
    { from: "inner", to: "Other", kind: "instantiates", line: 13, column: 4 },
  ],
  unresolved: [
    { from: "run", name: "helper", kind: "calls", file: USE, line: 11, column: 2 },
    { from: "run", name: "z.object", kind: "calls", file: USE, line: 12, column: 4 },
    { from: "run", name: "seen.size", kind: "references", file: USE, line: 13, column: 4 },
    { from: "run", name: "top", kind: "references", file: USE, line: 14, column: 4 },
    { from: "run", name: "inner", kind: "calls", file: USE, line: 14, column: 20 },
    { from: "run", name: "Map.groupBy", kind: "calls", file: USE, line: 15, column: 10 },
    { from: "run", name: "process.exit", kind: "calls", file: USE, line: 16, column: 30 },
    { from: "run", name: "process.cwd", kind: "calls", file: USE, line: 20, column: 2 },
    { from: "run", name: "helperAlias", kind: "calls", file: USE, line: 19, column: 2 },
    { from: "Svc.go", name: "this.load", kind: "calls", file: USE, line: 32, column: 4 },
    { from: "Svc.go", name: "this.cache.get", kind: "calls", file: USE, line: 32, column: 20 },
    { from: "Svc.load", name: "lib.Other", kind: "instantiates", file: USE, line: 35, column: 4 },
    { from: "Svc.go", name: "deps.read", kind: "calls", file: USE, line: 33, column: 4 },
    { from: "top", name: "Other", kind: "references", file: USE, line: 2, column: 13 },
    { from: "Svc.go", name: "orphan", kind: "calls", file: USE, line: 33, column: 20 },
  ],
  roots: { "17:11": { status: "complete", value: { kind: "external", module: "typescript" }, evidence: [] } },
  bindings: {
    "12:5 z": { kind: "import", root: "z", member: "object", origin: { kind: "external", module: "zod" } },
    "13:5 seen": { kind: "declared", root: "seen", lines: [12], topLevel: false },
    "14:5 top": { kind: "declared", root: "top", lines: [2], topLevel: true },
    "14:21 inner": { kind: "declared", root: "inner", lines: [12], topLevel: false },
    "15:11 Map": { kind: "ambient", root: "Map" },
    "19:3 helperAlias": { kind: "import", root: "helperAlias", origin: { kind: "repository", file: LIB } },
    "32:5 this": { kind: "this", member: "load" },
    "32:21 this": { kind: "this", member: "cache" },
    "33:5 deps": { kind: "declared", root: "deps", lines: [30], topLevel: false },
    "33:21 orphan": { kind: "declared", root: "orphan", lines: [3], topLevel: true },
    "2:14 Other": { kind: "located", root: "Other", file: LIB, path: "Other" },
    "35:5 lib": { kind: "import", root: "lib", member: "Other", origin: { kind: "repository", file: LIB } },
  },
  dependencies: [{ file: USE, line: 1, endLine: 1, specifier: "./lib", kind: "import", typeOnly: false, target: { kind: "repository", file: LIB }, bindings: [{ local: "helperAlias", imported: "helper", line: 1, column: 10, typeOnly: false }] }],
};

async function usesAnswer(symbol: string) {
  const answer = await setup(USES_INDEX).queries.outline({ repo: "/work/shop", repoId: "shop", revision: "HEAD", focus: [{ file: USE, symbol }] });
  assert.ok(answer.ok && answer.value.status !== "unknown", JSON.stringify(answer));
  return { uses: answer.value.value.focus?.[0]?.uses ?? [], cuts: answer.value.status === "partial" ? answer.value.cuts : [] };
}

function named(uses: readonly OutlineUse[]): string[] {
  return uses.map((use) => ("declaration" in use ? use.declaration.name : "module" in use ? `module ${use.module}` : `global ${use.global}`));
}

test("a focused declaration lists what its body uses outside itself, in order of first use, a use the index places nowhere last", async () => {
  const { uses } = await usesAnswer("run");
  assert.deepEqual(named(uses), ["helper", "module zod", "top", "global Map", "module typescript", "Other"]);
});

test("a declaration reached by a call, a reference and an import alias is one use with every relation and place", async () => {
  const { uses } = await usesAnswer("run");
  assert.deepEqual(uses[0], { declaration: { file: LIB, name: "helper", kind: "function", line: 1, endLine: 3 }, relations: ["calls", "references"], at: [{ line: 11, column: 3 }, { line: 15, column: 5 }, { line: 19, column: 3 }] });
});

test("an edge whose root a package binds is a use of the package, never of the repository declaration the graph matched", async () => {
  const { uses } = await usesAnswer("run");
  assert.ok(!named(uses).includes("Node"));
  assert.deepEqual(uses.find((use) => "module" in use && use.module === "typescript"), { module: "typescript", relations: ["references"], at: [{ line: 17, column: 11 }] });
});

test("an edge a synthesizer the policy ignores adds no use, and only the matched declaration's own edges count", async () => {
  const { uses } = await usesAnswer("run");
  assert.deepEqual(uses.find((use) => "declaration" in use && use.declaration.name === "Other")?.relations, ["references"]);
});

test("a declaration inside the body and a local value are not uses, and leave no cut", async () => {
  const { uses, cuts } = await usesAnswer("run");
  assert.ok(!named(uses).includes("inner"));
  assert.ok(!cuts.some((cut) => cut.at.some((place) => place.includes("seen"))));
});

test("a value a function around the body declares is a captured local, while a top-level one the index holds no node of is a cut", async () => {
  const { cuts } = await usesAnswer("Svc.go");
  assert.deepEqual(cuts.map((cut) => cut.at), [[`${USE}::Svc.go`, `${USE}:33 orphan`]]);
});

test("a member written on this is a use of the member its class declares, a method or a field", async () => {
  const { uses } = await usesAnswer("Svc.go");
  assert.deepEqual(uses.map((use) => ("declaration" in use ? [use.declaration.name, use.declaration.kind] : [])), [["load", "method"], ["cache", "property"]]);
});

test("a name nothing proves is one unresolved-link cut at the declaration listing every place, and its use is not listed", async () => {
  const { uses, cuts } = await usesAnswer("run");
  assert.ok(!named(uses).some((name) => name.includes("process")));
  assert.deepEqual(cuts.map((cut) => [cut.kind, cut.at]), [["unresolved-link", [`${USE}::run`, `${USE}:16 process.exit`, `${USE}:20 process.cwd`]]]);
});

test("a member of a namespace a repository import binds is a use of the declaration of that name at the top of the imported file", async () => {
  const { uses } = await usesAnswer("Svc.load");
  assert.deepEqual(uses, [{ declaration: { file: LIB, name: "Other", kind: "class", line: 5, endLine: 9 }, relations: ["instantiates"], at: [{ line: 35, column: 5 }] }]);
});

test("a name bound to a declaration of another file by its containment path is a use of that declaration", async () => {
  const { uses } = await usesAnswer("top");
  assert.deepEqual(named(uses), ["Other"]);
});

test("a declaration beside the focused one on the same line is not nested in it, so the focused body's use of it is listed", async () => {
  const SAME = "src/same-line.ts";
  const { queries } = setup({
    written: [SAME],
    nodes: [fakeNode("sameFile", "file", SAME, 1, 1), fakeNode("external", "function", SAME, 1, 1, "external"), fakeNode("limit", "constant", SAME, 1, 1, "limit"), fakeNode("together", "function", SAME, 1, 1, "together")],
    edges: [
      { from: "sameFile", to: "external", kind: "contains" },
      { from: "sameFile", to: "limit", kind: "contains" },
      { from: "sameFile", to: "together", kind: "contains" },
      { from: "together", to: "external", kind: "calls", line: 1, column: 80 },
    ],
    unresolved: [{ from: "together", name: "limit", kind: "references", file: SAME, line: 1, column: 100 }],
    bindings: { "1:101 limit": { kind: "declared", root: "limit", lines: [1], topLevel: true } },
  });

  const answer = await queries.outline({ repo: "/work/shop", repoId: "shop", revision: "HEAD", focus: [{ file: SAME, symbol: "together" }] });

  assert.ok(answer.ok && answer.value.status === "complete", JSON.stringify(answer));
  assert.deepEqual(named(answer.value.value.focus?.[0]?.uses ?? []), ["external", "limit"]);
});

test("a focus reads the head's sources without extracting entrypoints", async () => {
  const { queries, log } = setup(USES_INDEX);
  const answer = await queries.outline({ repo: "/work/shop", repoId: "shop", revision: "HEAD", focus: [{ file: USE, symbol: "run" }] });
  assert.ok(answer.ok);
  assert.equal(log.extractions, 0);
});
