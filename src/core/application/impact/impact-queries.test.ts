import { test } from "node:test";
import assert from "node:assert/strict";
import type { FileChange } from "../../domain/change/diff-reader.ts";
import type { ImpactValue } from "../../domain/impact/impact-fact.ts";
import type { FieldOrigin } from "../../domain/relations/field-origin.ts";
import { relation, type Relation } from "../../domain/relations/relation.ts";
import type { Fact, Finding } from "../../domain/shared/fact.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { CodeGraph, CodeGraphFault, CodeGraphReader, IndexSummary } from "../../ports/code-graph.port.ts";
import type { ImpactCallersRequest, ImpactFault, ImpactImportersRequest, ImpactOfChangeRequest, OfChangeFault } from "../../ports/impact-queries.port.ts";
import type { AtRevision } from "../../ports/live-queries.port.ts";
import type { ImportersValue } from "../../domain/impact/importers-fact.ts";
import type { CommitExport, Vcs, VcsChanges, VcsFault } from "../../ports/vcs.port.ts";
import type { AngularDeclaration } from "../../ports/angular-declarations.port.ts";
import { fakeCodeGraph, fakeNode, type FakeEdge, type FakeNode, type FakeUnresolved } from "./fake-code-graph.testing.ts";
import type { TrustRecordReader } from "../../ports/trust-record.port.ts";
import { fakeLive, type FakeLive } from "../live/fake-live.testing.ts";
import type { LiveStaleNotice } from "../../ports/live-queries.port.ts";
import { createImpactQueries, type ImpactQueriesDeps } from "./impact-queries.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const FORK = "c".repeat(40);
const SUMMARY: IndexSummary = { filesIndexed: 1, filesSkipped: 0, filesErrored: 0, filesNotIndexed: [], versions: { codegraph: "x", schema: 0, extraction: 0 } };

function change(path: string, overrides: Partial<FileChange> = {}): FileChange {
  return { path, deleted: false, binary: false, added: [{ start: 1, end: 1 }], removals: [], removedNames: [], ...overrides };
}

interface Options {
  changes?: Result<readonly FileChange[], VcsFault>;
  index?: Result<IndexSummary, CodeGraphFault>;
  open?: Result<CodeGraphReader, CodeGraphFault>;
  nodes?: FakeNode[];
  edges?: FakeEdge[];
  unresolved?: FakeUnresolved[];
  declarations?: AngularDeclaration[];
  relations?: Finding<Relation>[];
  fields?: FieldOrigin[];
  loads?: { file: string; line: number; specifier?: string }[];
  exportBudget?: { maxEntries: number; maxBytes: number };
  exports?: Partial<Record<string, CommitExport>>;
  mergeBase?: string;
  signal?: AbortSignal;
  /** Gives the queries an index cache that answers with the fault, or with the fake store when `true`. */
  cache?: true | CodeGraphFault;
  trust?: TrustRecordReader;
  live?: FakeLive;
  /** What `diffDirectories` answers. */
  directoryChanges?: Result<readonly FileChange[], VcsFault>;
  onDiffDirectories?: () => void;
}

function setup(options: Options = {}) {
  const log = { exported: [] as string[], plans: [] as { sha: string; destination: string; wanted: string[] }[], compared: [] as [string, string][], created: [] as string[], removed: [] as string[], indexed: 0, closed: 0, obtained: [] as string[] };
  const nodes = options.nodes ?? [];
  const reader: CodeGraphReader = { ...fakeCodeGraph(nodes, options.edges ?? [], options.unresolved ?? []), close: () => void log.closed++ };
  const vcs: Vcs & VcsChanges = {
    resolveCommit: async (_repo, revision) => ({ ok: true, value: revision.toLowerCase() === "head" ? HEAD : BASE }),
    mergeBase: async () => ({ ok: true, value: options.mergeBase ?? FORK }),
    diffCommits: async () => options.changes ?? { ok: true, value: [] },
    diffDirectories: async (before, after) => {
      log.compared.push([before, after]);
      options.onDiffDirectories?.();
      return options.directoryChanges ?? { ok: true, value: [] };
    },
    remotes: async () => ({ ok: true, value: [] }),
    exportCommit: async (_repo, sha, destination, plan) => {
      log.exported.push(sha);
      const listed = options.exports?.[sha] ?? { files: [{ path: "src/A.java", blob: "1", written: true }], skipped: [] };
      log.plans.push({ sha, destination, wanted: listed.files.filter((file) => plan.write(file.path)).map((file) => file.path) });
      return { ok: true, value: listed };
    },
  };
  const graph: CodeGraph = {
    buildMirror: async () => ({ ok: false, fault: { kind: "index-failed", detail: "not used" } }),
    syncMirror: async () => ({ ok: false, fault: { kind: "index-failed", detail: "not used" } }),
    index: async () => {
      log.indexed++;
      return options.index ?? { ok: true, value: SUMMARY };
    },
    open: () => options.open ?? { ok: true, value: reader },
  };
  const deps: ImpactQueriesDeps = {
    vcs,
    scratch: {
      create: async () => {
        log.created.push(`dir${log.created.length}`);
        return log.created.at(-1)!;
      },
      remove: async (path) => void log.removed.push(path),
    },
    reader: { read: async () => [] },
    extractor: { extract: async () => [] },
    angular: { read: async () => options.declarations ?? [] },
    relations: { extract: async () => ({ relations: options.relations ?? [], fields: options.fields ?? [] }) },
    dynamicLoads: { extract: async () => options.loads ?? [] },
    graph,
    ...(options.cache && {
      indexes: {
        obtain: async ({ content }) => {
          log.obtained.push(content);
          return options.cache === true ? { ok: true, value: { store: reader, summary: SUMMARY } } : { ok: false, fault: options.cache! };
        },
      },
    }),
    digest: { of: (text) => text },
    matcher: { matches: (path, glob) => path.startsWith(glob.replace(/\*\*$/, "")) },
    producer: { name: "ye-ast", version: "0" },
    engines: {},
    angularEngines: {},
    ...(options.exportBudget && { budget: options.exportBudget }),
    ...(options.trust && { trust: options.trust }),
    ...(options.live && { live: options.live.deps }),
  };
  const request: AtRevision<ImpactOfChangeRequest> = { repo: "/repo", repoId: "repo", base: "base", head: "head", ...(options.signal && { signal: options.signal }) };
  const queries = createImpactQueries(deps);
  const callersRequest: AtRevision<ImpactCallersRequest> = { repo: "/repo", repoId: "repo", revision: "head", targets: [], ...(options.signal && { signal: options.signal }) };
  const importersRequest: AtRevision<ImpactImportersRequest> = { repo: "/repo", repoId: "repo", revision: "head", files: [], ...(options.signal && { signal: options.signal }) };
  return {
    log,
    queries,
    ask: (overrides: Partial<AtRevision<ImpactOfChangeRequest>> = {}) => queries.ofChange({ ...request, ...overrides }),
    callers: (overrides: Partial<AtRevision<ImpactCallersRequest>>) => queries.callers({ ...callersRequest, ...overrides }),
    importers: (overrides: Partial<AtRevision<ImpactImportersRequest>>) => queries.importers({ ...importersRequest, ...overrides }),
  };
}

function fact(answer: Result<Fact<ImpactValue>, OfChangeFault>): Fact<ImpactValue> {
  assert.ok(answer.ok, JSON.stringify(answer));
  return answer.value;
}

const SOURCE_NODES = [fakeNode("f", "function", "src/A.java", 1, 3), fakeNode("g", "function", "src/B.java", 1, 3)];
const SOURCE_EDGES: FakeEdge[] = [{ from: "g", to: "f", kind: "calls", confidence: 0.9 }];

test("a diff git cannot produce is an unknown fact that names the unreadable source, not a fault", async () => {
  const answer = fact(await setup({ changes: { ok: false, fault: { kind: "git-failed", detail: "bad diff" } } }).ask());
  assert.equal(answer.status, "unknown");
  assert.equal(answer.status === "unknown" && answer.reason, "source-unreadable");
});

test("a fault of any other kind from the diff is returned as the fault", async () => {
  const answer = await setup({ changes: { ok: false, fault: { kind: "aborted", detail: "stop" } } }).ask();
  assert.equal(!answer.ok && answer.fault.kind, "aborted");
});

test("an index that cannot be built or opened is an unknown fact, and an aborted one an aborted fault", async () => {
  const changes: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change("src/A.java")] };
  const built = fact(await setup({ changes, index: { ok: false, fault: { kind: "index-failed", detail: "x" } } }).ask());
  assert.equal(built.status === "unknown" && built.reason, "index-unavailable");
  const opened = fact(await setup({ changes, open: { ok: false, fault: { kind: "store-unreadable", detail: "x" } } }).ask());
  assert.equal(opened.status === "unknown" && opened.reason, "index-unavailable");
  const aborted = await setup({ changes, index: { ok: false, fault: { kind: "aborted", detail: "x" } } }).ask();
  assert.equal(!aborted.ok && aborted.fault.kind, "aborted");
});

test("an unknown answered after the export carries the content of the successful answer for the same snapshot", async () => {
  const changes: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change("src/A.java")] };
  const failed = { index: { ok: false, fault: { kind: "index-failed", detail: "x" } } } as const;
  const served = { nodes: SOURCE_NODES, edges: SOURCE_EDGES };
  const contentOf = (answer: Fact<unknown>): string => answer.inputs.content;

  const ofChange = [setup({ changes, ...failed }), setup({ changes, ...served })];
  const [unknownChange, knownChange] = await Promise.all(ofChange.map(async ({ ask }) => fact(await ask())));
  assert.equal(unknownChange!.status, "unknown");
  assert.equal(contentOf(unknownChange!), contentOf(knownChange!));

  const targets = { targets: [{ file: "src/A.java", symbol: "f" }] };
  const unknownCallers = callersFact(await setup(failed).callers(targets));
  const knownCallers = callersFact(await setup(served).callers(targets));
  assert.equal(unknownCallers.status, "unknown");
  assert.equal(contentOf(unknownCallers), contentOf(knownCallers));

  const unknownImporters = importersFact(await setup(failed).importers({ files: ["src/A.java"] }));
  const knownImporters = importersFact(await setup(served).importers({ files: ["src/A.java"] }));
  assert.equal(unknownImporters.status, "unknown");
  assert.equal(contentOf(unknownImporters), contentOf(knownImporters));
});

test("a change with no source and no resource builds no index and is a complete empty answer", async () => {
  const { log, ask } = setup({ changes: { ok: true, value: [change("README.md"), change("src/Gone.java", { deleted: true, added: [], removals: [{ after: 0 }] })] } });
  const answer = fact(await ask());
  assert.equal(log.indexed, 0);
  assert.equal(answer.status, "complete");
  assert.deepEqual(answer.status === "complete" && answer.value, { mergeBase: FORK, seeds: [], changedEntrypoints: [], symbols: [], entrypoints: [], cost: { expansionsUsed: 0 } });
});

test("every temporary directory is removed and the store closed, whether the answer is a fact or a fault", async () => {
  const changes: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change("src/A.java")] };
  const answered = setup({ changes, nodes: SOURCE_NODES, edges: SOURCE_EDGES });
  await answered.ask();
  assert.deepEqual(answered.log.removed.toSorted(), answered.log.created.toSorted());
  assert.equal(answered.log.created.length, 3);
  assert.equal(answered.log.closed, 1);
  const failed = setup({ changes, index: { ok: false, fault: { kind: "index-failed", detail: "x" } } });
  await failed.ask();
  assert.deepEqual(failed.log.removed.toSorted(), failed.log.created.toSorted());
});

test("the merge base is extracted once more only when it is not the head itself", async () => {
  const same = setup({ mergeBase: HEAD });
  await same.ask();
  assert.deepEqual(same.log.exported, [HEAD]);
  const forked = setup();
  await forked.ask();
  assert.deepEqual(forked.log.exported, [HEAD, FORK]);
});

test("the walk is seeded from the change and its depth bound reaches the fact as a cut", async () => {
  const changes: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change("src/A.java", { added: [{ start: 2, end: 2 }] })] };
  const { ask } = setup({ changes, nodes: SOURCE_NODES, edges: SOURCE_EDGES });
  const unbounded = fact(await ask());
  assert.equal(unbounded.status, "complete");
  assert.deepEqual(unbounded.status === "complete" && unbounded.value.symbols.map((symbol) => [symbol.symbol, symbol.depth]), [["f", 0], ["g", 1]]);
  const bounded = fact(await ask({ budget: { depth: 0 } }));
  assert.equal(bounded.status, "partial");
  assert.deepEqual(bounded.status === "partial" && bounded.cuts, [{ kind: "depth", at: ["src/A.java::f"], limit: 0 }]);
});

test("a file the index did not hold, and a file the export left out, cut the answer", async () => {
  const changes: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change("src/A.java")] };
  const skipped: CommitExport = { files: [{ path: "src/A.java", blob: "1", written: true }], skipped: [{ path: "src/Link.java", reason: "symlink" }] };
  const { ask } = setup({
    changes,
    nodes: SOURCE_NODES,
    index: { ok: true, value: { ...SUMMARY, filesNotIndexed: ["src/out/X.java"] } },
    exports: { [FORK]: skipped },
  });
  const answer = fact(await ask());
  assert.deepEqual(answer.status === "partial" && answer.cuts, [
    { kind: "no-extractor", at: ["src/out/X.java"] },
    { kind: "not-exported", at: ["src/Link.java"] },
  ]);
});

test("the config digest covers the walk budget, and the same request gives the same fact", async () => {
  const { ask } = setup();
  const config = async (budget?: ImpactOfChangeRequest["budget"]): Promise<string> => fact(await ask(budget && { budget })).inputs.config;
  assert.notEqual(await config({ depth: 2 }), await config());
  assert.notEqual(await config({ depth: 2 }), await config({ depth: 3 }));
  assert.equal(await config({ depth: 2 }), await config({ depth: 2 }));
});

test("an abort that arrives while the diff is read stops the query before any export", async () => {
  const controller = new AbortController();
  const { log, ask } = setup({ changes: (controller.abort(), { ok: true, value: [] }), signal: controller.signal });
  const answer = await ask();
  assert.equal(!answer.ok && answer.fault.kind, "aborted");
  assert.deepEqual(log.created, []);
});

test("a changed template or style builds the index, since it may seed a component", async () => {
  const declarations: AngularDeclaration[] = [{ file: "src/0page.ts", name: "Page", line: 2, decorator: "Component", resources: ["src/page.html"] }];
  const nodes = [fakeNode("Page", "class", "src/0page.ts", 1, 5), fakeNode("A.f", "function", "src/A.java", 1, 3)];
  const { log, ask } = setup({ changes: { ok: true, value: [change("src/page.html"), change("src/A.java")] }, declarations, nodes });
  const answer = fact(await ask());
  assert.equal(log.indexed, 1);
  assert.deepEqual(answer.status !== "unknown" && answer.value.seeds.map((seed) => [seed.symbol, seed.basis]), [["Page", "resource"], ["A.f", "lines"]]);
  const resourceOnly = setup({ changes: { ok: true, value: [change("src/page.html")] }, declarations, nodes });
  await resourceOnly.ask();
  assert.equal(resourceOnly.log.indexed, 1);
});

test("a changed source file the index holds no symbol of cuts the answer at that file", async () => {
  const answer = fact(await setup({ changes: { ok: true, value: [change("src/Money.java")] }, nodes: SOURCE_NODES }).ask());
  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "no-extractor", at: ["src/Money.java"] }]);
});

test("a call that never resolved to a walked name cuts the answer, and the head's own export cuts are in the fact", async () => {
  const changes: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change("src/A.java", { added: [{ start: 2, end: 2 }] })] };
  const unresolved = [{ from: "g", name: "x.f", kind: "calls", file: "src/B.java", line: 7 }];
  const left: CommitExport = {
    files: [{ path: "src/A.java", blob: "1", written: true }, { path: "src/B.java", blob: "2", written: true }],
    skipped: [{ path: "src/Link.java", reason: "symlink" }],
  };
  const answer = fact(await setup({ changes, nodes: SOURCE_NODES, edges: SOURCE_EDGES, unresolved, exports: { [HEAD]: left } }).ask());
  assert.deepEqual(answer.status === "partial" && answer.cuts, [
    { kind: "unresolved-link", at: ["src/A.java::f", "src/B.java:7"] },
    { kind: "not-exported", at: ["src/Link.java"] },
  ]);
});

test("the fact's inputs cover the content of both trees and the export budget", async () => {
  const content = async (exports: Options["exports"], exportBudget?: Options["exportBudget"]): Promise<[string, string]> => {
    const answer = fact(await setup({ ...(exports && { exports }), ...(exportBudget && { exportBudget }) }).ask());
    return [answer.inputs.content, answer.inputs.config];
  };
  const other: CommitExport = { files: [{ path: "src/A.java", blob: "2", written: true }], skipped: [] };
  const [plain, config] = await content(undefined);
  assert.notEqual((await content({ [FORK]: other }))[0], plain);
  assert.notEqual((await content({ [HEAD]: other }))[0], plain);
  assert.notEqual((await content(undefined, { maxEntries: 10, maxBytes: 10 }))[1], config);
});

test("an unresolved call in a test file does not cut the answer", async () => {
  const changes: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change("src/A.java", { added: [{ start: 2, end: 2 }] })] };
  const unresolved = [{ from: "t", name: "x.f", kind: "calls", file: "src/test/java/ATest.java", line: 7 }];
  const tree: CommitExport = { files: [{ path: "src/A.java", blob: "1", written: true }, { path: "src/test/java/ATest.java", blob: "2", written: true }], skipped: [] };
  const answer = fact(await setup({ changes, nodes: SOURCE_NODES, unresolved, exports: { [HEAD]: tree } }).ask());
  assert.equal(answer.status, "complete");
});

test("a dynamic load whose specifier is a literal names its module, so only a computed load cuts the answer", async () => {
  const changes: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change("src/A.java", { added: [{ start: 2, end: 2 }] })] };
  const unresolved = [
    { from: "g", name: "import", kind: "calls", file: "src/App.ts", line: 3 },
    { from: "g", name: "import", kind: "calls", file: "src/Routes.ts", line: 8 },
  ];
  const tree: CommitExport = {
    files: [
      { path: "src/A.java", blob: "1", written: true },
      { path: "src/App.ts", blob: "2", written: true },
      { path: "src/Routes.ts", blob: "3", written: true },
    ],
    skipped: [],
  };
  const loads = [
    { file: "src/App.ts", line: 3, specifier: "./app.component" },
    { file: "src/Routes.ts", line: 8 },
  ];
  const answer = fact(await setup({ changes, nodes: SOURCE_NODES, edges: SOURCE_EDGES, unresolved, loads, exports: { [HEAD]: tree } }).ask());
  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "unresolved-link", at: ["src/Routes.ts", "src/Routes.ts:8"] }]);
});

test("a source file deleted whole that declared a name needs the index, and an unresolved reference to the name cuts the answer", async () => {
  const gone = change("src/Gone.java", { deleted: true, added: [], removals: [{ after: 0 }], removedNames: ["Gone"] });
  const unresolved = [{ from: "g", name: "Gone", kind: "instantiates", file: "src/B.java", line: 7 }];
  const exports = { [HEAD]: { files: [{ path: "src/B.java", blob: "2", written: true }], skipped: [] } };
  const { log, ask } = setup({ changes: { ok: true, value: [gone] }, unresolved, exports });
  const answer = fact(await ask());
  assert.equal(log.indexed, 1);
  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "unresolved-link", at: ["src/Gone.java::Gone", "src/B.java:7"] }]);
});

test("lines removed between symbols that declared a name cut the answer at the references that still name it, and a removed import does not", async () => {
  const nodes = [fakeNode("f", "function", "src/A.java", 1, 5), fakeNode("g", "function", "src/A.java", 20, 25)];
  const removed = change("src/A.java", { added: [], removals: [{ after: 10 }, { after: 12 }], removedNames: ["helper"] });
  const unresolved = [
    { from: "g", name: "this.helper", kind: "calls", file: "src/A.java", line: 22 },
    { from: "g", name: "Other", kind: "calls", file: "src/A.java", line: 23 },
  ];
  const answer = fact(await setup({ changes: { ok: true, value: [removed] }, nodes, unresolved }).ask());
  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "unresolved-link", at: ["src/A.java::helper", "src/A.java:22"] }]);
});

const SVC_FILE = "src/app/svc.ts";
const CMP_FILE = "src/app/cmp.ts";
const ANGULAR_NODES = [fakeNode("Svc", "class", SVC_FILE, 2, 9), fakeNode("Cmp", "class", CMP_FILE, 2, 9), fakeNode("Far", "class", "src/app/far.ts", 2, 9)];
const SVC_CHANGE: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change(SVC_FILE, { added: [{ start: 4, end: 4 }] })] };
const INJECTION = relation("injects", { path: CMP_FILE, symbol: "Cmp", line: 3 }, { path: SVC_FILE, symbol: "Svc", line: 3 });
const complete = (value: Relation): Finding<Relation> => ({ status: "complete", value, evidence: [{ path: value.from.path, line: value.from.line }] });
const unread = (path: string, line: number): Finding<Relation> => ({ status: "unknown", reason: "unresolved", evidence: [{ path, line }] });

test("a class that injects a changed class is reached, and a walk whose Angular relations were all read has no cut for them", async () => {
  const answer = fact(await setup({ changes: SVC_CHANGE, nodes: ANGULAR_NODES, relations: [complete(INJECTION)] }).ask());
  assert.equal(answer.status, "complete");
  assert.deepEqual(answer.status === "complete" && answer.value.symbols.map((symbol) => [symbol.symbol, symbol.depth, symbol.confidence]), [["Svc", 0, 1], ["Cmp", 1, 1]]);
});

test("a reference through a field of known origin is a caller when the field holds the owner, and leaves the cut when it holds an unrelated type", async () => {
  const SUB_FILE = "src/app/sub.ts";
  const nodes = [
    fakeNode("Svc", "class", SVC_FILE, 2, 9),
    fakeNode("get", "method", SVC_FILE, 4, 6),
    fakeNode("Sub", "class", SUB_FILE, 2, 9),
    fakeNode("Cmp", "class", CMP_FILE, 2, 30),
    fakeNode("viaSvc", "method", CMP_FILE, 5, 6),
    fakeNode("viaHttp", "method", CMP_FILE, 8, 9),
    fakeNode("viaMap", "method", CMP_FILE, 11, 12),
    fakeNode("viaOther", "method", CMP_FILE, 14, 15),
    fakeNode("viaSub", "method", CMP_FILE, 17, 18),
    fakeNode("viaLocal", "method", CMP_FILE, 20, 21),
    fakeNode("viaUnknown", "method", CMP_FILE, 23, 24),
  ];
  const members = ["viaSvc", "viaHttp", "viaMap", "viaOther", "viaSub", "viaLocal", "viaUnknown"];
  const edges = [{ from: "Svc", to: "get", kind: "contains" }, { from: "Sub", to: "Svc", kind: "extends" }, ...members.map((to) => ({ from: "Cmp", to, kind: "contains" }))];
  const unresolved = [
    { from: "viaSvc", name: "this.svc.get", kind: "calls", file: CMP_FILE, line: 6 },
    { from: "viaHttp", name: "this.http.get", kind: "calls", file: CMP_FILE, line: 9 },
    { from: "viaMap", name: "this.cache.get", kind: "calls", file: CMP_FILE, line: 12 },
    { from: "viaOther", name: "this.other.get", kind: "calls", file: CMP_FILE, line: 15 },
    { from: "viaSub", name: "this.sub.get", kind: "calls", file: CMP_FILE, line: 18 },
    { from: "viaLocal", name: "params.get", kind: "calls", file: CMP_FILE, line: 21 },
    { from: "viaUnknown", name: "this.store.get", kind: "calls", file: CMP_FILE, line: 24 },
  ];
  const owner = { path: CMP_FILE, symbol: "Cmp", line: 3 };
  const fields: FieldOrigin[] = [
    { owner, field: "svc", holds: { class: { path: SVC_FILE, symbol: "Svc", line: 3 } } },
    { owner, field: "http", holds: { external: "@angular/common/http#HttpClient" } },
    { owner, field: "cache", holds: { external: "global#Map" } },
    { owner, field: "other", holds: { class: { path: CMP_FILE, symbol: "Cmp", line: 3 } } },
    { owner, field: "sub", holds: { class: { path: SUB_FILE, symbol: "Sub", line: 3 } } },
  ];
  const changes: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change(SVC_FILE, { added: [{ start: 5, end: 5 }] })] };
  const exports = { [HEAD]: { files: [SVC_FILE, CMP_FILE, SUB_FILE].map((path, index) => ({ path, blob: `${index}`, written: true })), skipped: [] } };

  const answer = fact(await setup({ changes, nodes, edges, unresolved, exports, fields }).ask());
  assert.ok(answer.status === "partial");
  assert.deepEqual(answer.value.symbols.filter((symbol) => symbol.file === CMP_FILE).map((symbol) => symbol.symbol), ["Cmp", "viaSvc"]);
  assert.deepEqual(answer.cuts.find((cut) => cut.kind === "unresolved-link"), { kind: "unresolved-link", at: [`${SVC_FILE}::get`, `${CMP_FILE}:18`, `${CMP_FILE}:21`, `${CMP_FILE}:24`] });
});

test("a relation the reader could not place cuts the answer only in a file the walk reached", async () => {
  const reached = fact(await setup({ changes: SVC_CHANGE, nodes: ANGULAR_NODES, relations: [complete(INJECTION), unread(CMP_FILE, 5)] }).ask());
  assert.deepEqual(reached.status === "partial" && reached.cuts, [{ kind: "unresolved-link", at: [CMP_FILE, `${CMP_FILE}:5 unresolved`] }]);
  const elsewhere = fact(await setup({ changes: SVC_CHANGE, nodes: ANGULAR_NODES, relations: [complete(INJECTION), unread("src/app/far.ts", 5)] }).ask());
  assert.equal(elsewhere.status, "complete");
});

test("a changed template no component names through templateUrl is a cut at that file, and one a component claims is not", async () => {
  const declarations: AngularDeclaration[] = [{ file: "src/app/cmp.ts", name: "Cmp", line: 2, decorator: "Component", resources: ["src/app/cmp.html"] }];
  const nodes = [fakeNode("Cmp", "class", "src/app/cmp.ts", 1, 5)];
  const changes: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change("src/app/cmp.html"), change("src/app/lost.html"), change("src/app/old.htm")] };
  const answer = fact(await setup({ changes, declarations, nodes }).ask());
  assert.deepEqual(answer.status === "partial" && answer.cuts, [
    { kind: "no-extractor", at: ["src/app/lost.html"] },
    { kind: "no-extractor", at: ["src/app/old.htm"] },
  ]);
});

function callersFact(answer: Result<Fact<ImpactValue>, ImpactFault>): Fact<ImpactValue> {
  assert.ok(answer.ok, JSON.stringify(answer));
  return answer.value;
}

test("a requested symbol seeds the walk with the basis requested, and the value carries no merge base nor changed entrypoints", async () => {
  const { callers } = setup({ nodes: SOURCE_NODES, edges: SOURCE_EDGES });
  const answer = callersFact(await callers({ targets: [{ file: "src/A.java", symbol: "f" }] }));
  assert.equal(answer.status, "complete");
  const value = answer.status === "complete" ? answer.value : undefined;
  assert.deepEqual(value?.seeds, [{ file: "src/A.java", symbol: "f", line: 1, basis: "requested" }]);
  assert.deepEqual(value?.symbols.map((symbol) => [symbol.symbol, symbol.depth]), [["f", 0], ["g", 1]]);
  assert.equal(value !== undefined && ("mergeBase" in value || "changedEntrypoints" in value), false);
  assert.deepEqual(answer.snapshot, { repo: "repo", kind: "sha", sha: HEAD });
});

test("a requested line range seeds like changed lines do: the innermost symbol it touches, by lines", async () => {
  const nodes = [fakeNode("f", "function", "src/A.java", 1, 3), fakeNode("h", "function", "src/A.java", 10, 14)];
  const { callers } = setup({ nodes });
  const answer = callersFact(await callers({ targets: [{ file: "src/A.java", start: 11, end: 12 }] }));
  assert.deepEqual(answer.status === "complete" && answer.value.seeds.map((seed) => [seed.symbol, seed.basis]), [["h", "lines"]]);
});

test("a symbol that is both requested and inside a requested range seeds once, as requested", async () => {
  const { callers } = setup({ nodes: SOURCE_NODES, edges: SOURCE_EDGES });
  const answer = callersFact(await callers({ targets: [{ file: "src/A.java", start: 1, end: 2 }, { file: "src/A.java", symbol: "f" }] }));
  assert.deepEqual(answer.status === "complete" && answer.value.seeds, [{ file: "src/A.java", symbol: "f", line: 1, basis: "requested" }]);
});

test("a requested symbol that names no node at the revision is a typed failure naming the entries, even beside one that exists", async () => {
  const { callers } = setup({ nodes: SOURCE_NODES });
  const answer = await callers({ targets: [{ file: "src/A.java", symbol: "f" }, { file: "src/A.java", symbol: "gone" }, { file: "src/B.java", symbol: "f" }] });
  assert.ok(!answer.ok);
  assert.equal(answer.fault.kind, "unknown-symbol");
  assert.deepEqual(answer.fault.kind === "unknown-symbol" && answer.fault.entries, [
    { file: "src/A.java", symbol: "gone", candidates: ["f"] },
    { file: "src/B.java", symbol: "f", candidates: ["g"] },
  ]);
});

test("a missing entry names the seedable declarations of its file, sorted and once each, and none for a file the index does not hold", async () => {
  const nodes = [fakeNode("z", "function", "src/A.java", 1), fakeNode("a1", "method", "src/A.java", 5, 5, "a"), fakeNode("a2", "method", "src/A.java", 9, 9, "a"), fakeNode("d", "field", "src/A.java", 12)];
  const { callers } = setup({ nodes });
  const answer = await callers({ targets: [{ file: "src/A.java", symbol: "gone" }, { file: "src/Elsewhere.java", symbol: "x" }] });
  assert.ok(!answer.ok);
  assert.deepEqual(answer.fault.kind === "unknown-symbol" && answer.fault.entries, [
    { file: "src/A.java", symbol: "gone", candidates: ["a", "z"] },
    { file: "src/Elsewhere.java", symbol: "x", candidates: [] },
  ]);
});

test("the walk budget reaches the callers fact as a cut, and the config digest covers the targets", async () => {
  const { callers } = setup({ nodes: SOURCE_NODES, edges: SOURCE_EDGES });
  const bounded = callersFact(await callers({ targets: [{ file: "src/A.java", symbol: "f" }], budget: { depth: 0 } }));
  assert.deepEqual(bounded.status === "partial" && bounded.cuts, [{ kind: "depth", at: ["src/A.java::f"], limit: 0 }]);
  const config = async (targets: ImpactCallersRequest["targets"]): Promise<string> => callersFact(await callers({ targets })).inputs.config;
  assert.notEqual(await config([{ file: "src/A.java", symbol: "f" }]), await config([{ file: "src/B.java", symbol: "g" }]));
  assert.equal(await config([{ file: "src/A.java", symbol: "f" }, { file: "src/B.java", symbol: "g" }]), await config([{ file: "src/B.java", symbol: "g" }, { file: "src/A.java", symbol: "f" }]));
});

test("a requested range in a file no extractor covers, and one in a file without symbols, cut the answer instead of answering empty", async () => {
  const { callers } = setup({ nodes: SOURCE_NODES });
  const answer = callersFact(await callers({ targets: [{ file: "README.md", start: 1, end: 2 }, { file: "src/test/java/ATest.java", start: 1, end: 2 }, { file: "src/Money.java", start: 1, end: 2 }] }));
  assert.deepEqual(answer.status === "partial" && answer.cuts, [
    { kind: "no-extractor", at: ["README.md"] },
    { kind: "no-extractor", at: ["src/Money.java"] },
    { kind: "no-extractor", at: ["src/test/java/ATest.java"] },
  ]);
});

test("callers removes every temporary directory and closes the store, also when it answers a fault", async () => {
  const answered = setup({ nodes: SOURCE_NODES });
  await answered.callers({ targets: [{ file: "src/A.java", symbol: "f" }] });
  const failed = setup({ nodes: SOURCE_NODES });
  await failed.callers({ targets: [{ file: "src/A.java", symbol: "gone" }] });
  for (const { log } of [answered, failed]) {
    assert.deepEqual(log.removed.toSorted(), log.created.toSorted());
    assert.equal(log.closed, 1);
  }
  assert.equal(answered.log.created.length, 2);
});

function importersFact(answer: Result<Fact<ImportersValue>, OfChangeFault>): Fact<ImportersValue> {
  assert.ok(answer.ok, JSON.stringify(answer));
  return answer.value;
}

const SHOP_NODES = [
  fakeNode("file:Order", "file", "src/Order.java", 1, 20),
  fakeNode("import:Order", "import", "src/Order.java", 2, 2, "Money"),
  fakeNode("Order", "class", "src/Order.java", 3, 20),
  fakeNode("file:Cart", "file", "src/Cart.java", 1, 20),
  fakeNode("Cart", "class", "src/Cart.java", 3, 20),
  fakeNode("file:CartTest", "file", "src/test/java/CartTest.java", 1, 20),
  fakeNode("Svc", "class", "src/Svc.java", 3, 20),
  fakeNode("Beta", "class", "src/Beta.java", 3, 20),
  fakeNode("Gamma", "class", "src/Gamma.java", 3, 20),
];
const SHOP_EXPORT: CommitExport = {
  files: ["src/Order.java", "src/Cart.java", "src/test/java/CartTest.java", "src/Svc.java", "src/Beta.java", "src/Late.java", "src/Quiet.java", "src/Own.java"].map((path) => ({ path, blob: path, written: true })),
  skipped: [],
};

test("importers tells importing files from using files from files that only name it, each sorted, other files only, tests included", async () => {
  const { importers } = setup({
    nodes: SHOP_NODES,
    edges: [
      { from: "file:Cart", to: "Order", kind: "imports" },
      { from: "file:CartTest", to: "Order", kind: "imports" },
      { from: "Svc", to: "Order", kind: "calls" },
      { from: "Beta", to: "Order", kind: "references" },
      { from: "Order", to: "Order", kind: "references" },
      { from: "Gamma", to: "Order", kind: "contains" },
      { from: "Cart", to: "Cart", kind: "calls" },
    ],
    unresolved: [
      { from: "x", name: "pricing.Order", kind: "references", file: "src/Late.java", line: 4 },
      { from: "x", name: "./pricing/Order", kind: "imports", file: "src/Quiet.java", line: 5 },
      { from: "x", name: "Money", kind: "references", file: "src/Own.java", line: 5 },
      { from: "x", name: "Unrelated", kind: "calls", file: "src/Svc.java", line: 6 },
      { from: "x", name: "Order", kind: "references", file: "src/Order.java", line: 9 },
    ],
    exports: { [HEAD]: SHOP_EXPORT },
  });
  const answer = importersFact(await importers({ files: ["src/Order.java"] }));
  assert.deepEqual(answer.status !== "unknown" && answer.value.files, [
    {
      file: "src/Order.java",
      importers: ["src/Cart.java", "src/test/java/CartTest.java"],
      users: ["src/Beta.java", "src/Cart.java", "src/Svc.java", "src/test/java/CartTest.java"],
      unresolvedNamers: ["src/Late.java", "src/Quiet.java"],
    },
  ]);
});

test("importers answers the files in path order whatever order they were asked in", async () => {
  const { importers } = setup({ nodes: SHOP_NODES, exports: { [HEAD]: SHOP_EXPORT } });
  const answer = importersFact(await importers({ files: ["src/Order.java", "src/Cart.java"] }));
  assert.deepEqual(answer.status !== "unknown" && answer.value.files.map((entry) => entry.file), ["src/Cart.java", "src/Order.java"]);
});

test("a requested file outside the declared scope, or that the index holds nothing of, is a cut and has no entry", async () => {
  const { importers } = setup({ nodes: SHOP_NODES, exports: { [HEAD]: SHOP_EXPORT } });
  const answer = importersFact(await importers({ files: ["README.md", "src/Order.java", "src/Late.java"] }));
  assert.equal(answer.status, "partial");
  assert.deepEqual(answer.status === "partial" && answer.value.files.map((entry) => entry.file), ["src/Order.java"]);
  assert.deepEqual(answer.status === "partial" && answer.cuts, [
    { kind: "no-extractor", at: ["README.md"] },
    { kind: "no-extractor", at: ["src/Late.java"] },
  ]);
});

test("a file that loads modules by a computed name may import anything, so it cuts the importers answer", async () => {
  const { importers } = setup({ nodes: SHOP_NODES, unresolved: [{ from: "x", name: "require", kind: "calls", file: "src/Late.java", line: 3 }], exports: { [HEAD]: SHOP_EXPORT } });
  const answer = importersFact(await importers({ files: ["src/Order.java"] }));
  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "unresolved-link", at: ["src/Late.java", "src/Late.java:3"] }]);
});

test("a load whose specifier the reader read as a literal does not cut the importers answer", async () => {
  const unresolved = [{ from: "x", name: "require", kind: "calls", file: "src/Late.java", line: 3 }];
  const loads = [{ file: "src/Late.java", line: 3, specifier: "./late.js" }];
  const { importers } = setup({ nodes: SHOP_NODES, unresolved, loads, exports: { [HEAD]: SHOP_EXPORT } });
  assert.equal(importersFact(await importers({ files: ["src/Order.java"] })).status, "complete");
});

test("a computed-name load in a test file does not cut the importers answer", async () => {
  const unresolved = [{ from: "x", name: "require", kind: "calls", file: "src/test/java/CartTest.java", line: 3 }];
  const { importers } = setup({ nodes: SHOP_NODES, unresolved, exports: { [HEAD]: SHOP_EXPORT } });
  assert.equal(importersFact(await importers({ files: ["src/Order.java"] })).status, "complete");
});

test("importers answers unknown when the index cannot be built, and releases its directories and store otherwise", async () => {
  const unavailable = setup({ index: { ok: false, fault: { kind: "index-failed", detail: "x" } } });
  const answer = importersFact(await unavailable.importers({ files: ["src/Order.java"] }));
  assert.equal(answer.status === "unknown" && answer.reason, "index-unavailable");
  assert.deepEqual(unavailable.log.removed.toSorted(), unavailable.log.created.toSorted());
  const served = setup({ nodes: SHOP_NODES, exports: { [HEAD]: SHOP_EXPORT } });
  await served.importers({ files: ["src/Order.java"] });
  assert.deepEqual(served.log.removed.toSorted(), served.log.created.toSorted());
  assert.equal(served.log.closed, 1);
});

test("the importers config digest covers the requested files", async () => {
  const { importers } = setup({ nodes: SHOP_NODES, exports: { [HEAD]: SHOP_EXPORT } });
  const config = async (files: string[]): Promise<string> => importersFact(await importers({ files })).inputs.config;
  assert.notEqual(await config(["src/Order.java"]), await config(["src/Cart.java"]));
  assert.equal(await config(["src/Order.java", "src/Cart.java"]), await config(["src/Cart.java", "src/Order.java"]));
});

const CHANGES: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change("src/A.java")] };

test("with an index cache the head's staged content picks the index and no index is built here", async () => {
  const { log, ask, callers, importers } = setup({ changes: CHANGES, nodes: SOURCE_NODES, edges: SOURCE_EDGES, cache: true });
  await ask();
  await callers({ targets: [{ file: "src/A.java", symbol: "f" }] });
  await importers({ files: ["src/A.java"] });
  assert.equal(log.indexed, 0);
  assert.equal(log.obtained.length, 3);
  assert.equal(new Set(log.obtained).size, 1);
  assert.equal(log.closed, 3);
});

test("the cache is asked for the head's content, not the base's", async () => {
  const head: CommitExport = { files: [{ path: "src/A.java", blob: "head-blob", written: true }], skipped: [] };
  const base: CommitExport = { files: [{ path: "src/A.java", blob: "base-blob", written: true }], skipped: [] };
  const { log, ask } = setup({ changes: CHANGES, cache: true, exports: { [HEAD]: head, [FORK]: base } });
  await ask();
  assert.equal(log.obtained.length, 1);
  assert.ok(log.obtained[0]!.includes("head-blob") && !log.obtained[0]!.includes("base-blob"));
});

test("a cache that cannot be used is passed over and the index is built as without it, while any other fault is an unknown fact", async () => {
  const passed = setup({ changes: CHANGES, nodes: SOURCE_NODES, edges: SOURCE_EDGES, cache: { kind: "cache-unavailable", detail: "x" } });
  const answer = fact(await passed.ask());
  assert.equal(passed.log.indexed, 1);
  assert.equal(answer.status === "unknown", false);
  const failed = setup({ changes: CHANGES, cache: { kind: "index-failed", detail: "x" } });
  const unknown = fact(await failed.ask());
  assert.equal(failed.log.indexed, 0);
  assert.equal(unknown.status === "unknown" && unknown.reason, "index-unavailable");
  const aborted = await setup({ changes: CHANGES, cache: { kind: "aborted", detail: "x" } }).ask();
  assert.equal(!aborted.ok && aborted.fault.kind, "aborted");
});

test("a changed path outside the requested scope seeds nothing, cuts nothing and needs no index", async () => {
  const changes: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change("gen/Z.java"), change("gen/legacy.py")] };
  const exports = { [HEAD]: { files: [{ path: "gen/legacy.py", blob: "1", written: false }], skipped: [{ path: "gen/Link.java", reason: "symlink" }] } satisfies CommitExport };
  const open = setup({ changes, exports, nodes: SOURCE_NODES });
  const scoped = setup({ changes, exports, nodes: SOURCE_NODES });

  const unscoped = fact(await open.ask());
  const answer = fact(await scoped.ask({ scope: { exclude: ["gen/"] } }));

  assert.equal(unscoped.status, "partial");
  assert.equal(open.log.indexed, 1);
  assert.equal(answer.status, "complete");
  assert.equal(scoped.log.indexed, 0);
  assert.notEqual(answer.inputs.content, unscoped.inputs.content);
});

test("every impact fact declares the requested scope sorted, and the digest of the scope covers it", async () => {
  const scope = { include: ["src/", "lib/"], exclude: ["src/gen/"] };
  const { ask, callers, importers } = setup({ nodes: SOURCE_NODES });
  const open = await Promise.all([ask(), callers({ targets: [{ file: "src/A.java", symbol: "f" }] }), importers({ files: ["src/A.java"] })]);
  const scoped = await Promise.all([ask({ scope }), callers({ scope, targets: [{ file: "src/A.java", symbol: "f" }] }), importers({ scope, files: ["src/A.java"] })]);

  for (const [index, answer] of scoped.entries()) {
    assert.ok(answer.ok);
    assert.deepEqual([answer.value.inputs.declaredScope.include, answer.value.inputs.declaredScope.exclude], [["lib/", "src/"], ["src/gen/"]]);
    const unscoped = open[index]!;
    assert.ok(unscoped.ok);
    assert.notEqual(answer.value.inputs.scope, unscoped.value.inputs.scope);
  }
});

test("a callers request naming a target outside the scope is unknown out-of-scope with evidence naming each such target, even beside targets in scope", async () => {
  const { log, callers } = setup({ nodes: SOURCE_NODES, edges: SOURCE_EDGES });
  const targets = [{ file: "src/A.java", symbol: "f" }, { file: "gen/Z.java", symbol: "z" }, { file: "gen/Y.java", start: 4, end: 9 }];

  const answer = callersFact(await callers({ targets, scope: { exclude: ["gen/"] } }));

  assert.equal(answer.status, "unknown");
  assert.equal(answer.status === "unknown" && answer.reason, "out-of-scope");
  assert.deepEqual(answer.evidence, [{ path: "gen/Y.java", line: 4, endLine: 9 }, { path: "gen/Z.java", line: 1 }]);
  assert.equal(log.indexed, 0);
  const served = callersFact(await callers({ targets: [{ file: "src/A.java", symbol: "f" }], scope: { exclude: ["gen/"] } }));
  assert.equal(answer.inputs.content, served.inputs.content);
});

test("an include leaves a callers target it does not match out of scope, and a file with no extractor inside the scope stays a no-extractor cut", async () => {
  const { callers } = setup({ nodes: SOURCE_NODES });

  const outside = callersFact(await callers({ targets: [{ file: "src/A.java", symbol: "f" }], scope: { include: ["lib/"] } }));
  const noExtractor = callersFact(await callers({ targets: [{ file: "README.md", start: 1, end: 2 }], scope: { exclude: ["gen/"] } }));

  assert.equal(outside.status === "unknown" && outside.reason, "out-of-scope");
  assert.deepEqual(noExtractor.status === "partial" && noExtractor.cuts, [{ kind: "no-extractor", at: ["README.md"] }]);
});

test("an importers request naming a file outside the scope is unknown out-of-scope with evidence naming each such file, even beside files in scope", async () => {
  const { log, importers } = setup({ nodes: SHOP_NODES, exports: { [HEAD]: SHOP_EXPORT } });

  const answer = importersFact(await importers({ files: ["src/Order.java", "gen/Z.java", "gen/Y.java"], scope: { exclude: ["gen/"] } }));

  assert.equal(answer.status, "unknown");
  assert.equal(answer.status === "unknown" && answer.reason, "out-of-scope");
  assert.deepEqual(answer.evidence, [{ path: "gen/Y.java", line: 1 }, { path: "gen/Z.java", line: 1 }]);
  assert.equal(log.indexed, 0);
  const served = importersFact(await importers({ files: ["src/Order.java"], scope: { exclude: ["gen/"] } }));
  assert.equal(answer.inputs.content, served.inputs.content);
});

test("every impact operation records the mode the trust record declares for the repository", async () => {
  const { ask, callers, importers } = setup({ trust: { read: async () => ({ ok: true, value: "trusted" }) } });

  const answers = [await ask(), await callers({}), await importers({})];

  assert.deepEqual(answers.map((answer) => fact(answer as Result<Fact<ImpactValue>, VcsFault>).inputs.trust), ["trusted", "trusted", "trusted"]);
});

const TRUSTED: TrustRecordReader = { read: async () => ({ ok: true, value: "trusted" }) };
const LIVE_BASE = { repo: "/repo", repoId: "repo" } as const;

test("every live impact operation under untrusted is refused as a typed fault before anything is resolved, listed, locked or exported", async () => {
  const live = fakeLive({ "src/A.java": "1" });
  const { log, queries } = setup({ live });

  const answers = [
    await queries.ofChange({ ...LIVE_BASE, base: "base", live: true }),
    await queries.callers({ ...LIVE_BASE, targets: [{ file: "src/A.java", symbol: "f" }], live: true }),
    await queries.importers({ ...LIVE_BASE, files: ["src/A.java"], live: true }),
  ];

  assert.deepEqual(answers.map((answer) => !answer.ok && answer.fault.kind), ["live-requires-trusted", "live-requires-trusted", "live-requires-trusted"]);
  assert.deepEqual([live.calls, log.exported, log.created, log.indexed], [[], [], [], 0]);
});

const LIVE_NODES = [fakeNode("f", "function", "src/A.java", 1, 3), fakeNode("g", "function", "src/B.java", 1, 3)];

test("a live callers query reads the store the mirror holds, records where it came from, and turns the files it does not hold into no-extractor cuts", async () => {
  const live = fakeLive({ "src/A.java": "1", "src/B.java": "1" });
  live.engine.build = { ok: true, value: { ...SUMMARY, filesNotIndexed: ["src/Odd.java"] } };
  const { log, queries } = setup({ trust: TRUSTED, live, nodes: LIVE_NODES, edges: SOURCE_EDGES });

  const answer = callersFact(await queries.callers({ ...LIVE_BASE, targets: [{ file: "src/A.java", symbol: "f" }], live: true }));

  assert.equal(answer.status, "partial");
  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "no-extractor", at: ["src/Odd.java"] }]);
  assert.deepEqual(answer.status === "partial" && answer.value.symbols.map((symbol) => symbol.symbol), ["f", "g"]);
  assert.deepEqual(answer.snapshot, { repo: "repo", kind: "live", head: HEAD, stateId: answer.inputs.content });
  assert.deepEqual(answer.inputs.origin, { kind: "full" });
  assert.deepEqual(answer.inputs.declaredScope.ignored, "git");
  assert.equal(log.indexed, 0);
  assert.equal(log.closed, 1);
  assert.deepEqual(live.held, { locks: 1, released: 1 });
});

test("a live fact that read no store carries no index origin", async () => {
  const live = fakeLive({ "README.md": "1" });
  const { queries } = setup({ trust: TRUSTED, live, exports: { [HEAD]: { files: [], skipped: [] } } });

  const answer = callersFact(await queries.callers({ ...LIVE_BASE, targets: [{ file: "README.md", start: 1, end: 2 }], live: true }));

  assert.equal("index" in answer.inputs, false);
});

test("after an edit a live importers query says the index came from a sync of the last full build", async () => {
  const live = fakeLive({ "src/Order.java": "1" });
  const { queries } = setup({ trust: TRUSTED, live, nodes: SHOP_NODES });
  const request = { ...LIVE_BASE, files: ["src/Order.java"], live: true } as const;
  const first = importersFact(await queries.importers(request));
  live.tree.set("src/Order.java", "2");

  const second = importersFact(await queries.importers(request));

  assert.deepEqual(first.inputs.origin, { kind: "full" });
  assert.deepEqual(second.inputs.origin, { kind: "sync", base: first.snapshot.kind === "live" ? first.snapshot.stateId : "" });
  assert.deepEqual(live.syncs, [["src/Order.java"]]);
});

test("a live query whose lock is still held at the deadline is unknown index-unavailable, never an empty answer", async () => {
  const live = fakeLive({ "src/A.java": "1" });
  live.engine.lock = { ok: false, fault: { kind: "aborted", detail: "waiting" } };
  const { queries } = setup({ trust: TRUSTED, live, nodes: LIVE_NODES });

  const answers = [
    await queries.ofChange({ ...LIVE_BASE, base: "base", live: true }),
    await queries.callers({ ...LIVE_BASE, targets: [{ file: "src/A.java", symbol: "f" }], live: true }),
    await queries.importers({ ...LIVE_BASE, files: ["src/A.java"], live: true }),
  ];

  for (const answer of answers) {
    assert.ok(answer.ok);
    assert.equal(answer.value.status === "unknown" && answer.value.reason, "index-unavailable");
    assert.equal(answer.value.snapshot.kind, "live");
  }
});

test("a live ofChange seeds from the paths whose blob differs from the merge base, exports their merge-base version and copies their mirror version", async () => {
  const live = fakeLive({ "src/A.java": "2", "src/C.java": "1", "src/Same.java": "1", "README.md": "1" });
  const exports = {
    [FORK]: { files: [{ path: "src/A.java", blob: "1", written: true }, { path: "src/B.java", blob: "1", written: true }, { path: "src/Same.java", blob: "1", written: true }, { path: "README.md", blob: "1", written: false }], skipped: [] },
  };
  const directoryChanges: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change("src/A.java"), change("src/B.java", { deleted: true, added: [], removals: [{ after: 0 }] }), change("src/C.java")] };
  const { log, queries } = setup({ trust: TRUSTED, live, exports, directoryChanges, nodes: LIVE_NODES, edges: SOURCE_EDGES });

  const answer = fact(await queries.ofChange({ ...LIVE_BASE, base: "base", live: true }));

  const changed = ["src/A.java", "src/B.java", "src/C.java"];
  assert.deepEqual(log.plans.filter((plan) => plan.sha === FORK).map((plan) => plan.wanted), [["src/A.java", "src/B.java", "src/Same.java"], changed.filter((path) => path !== "src/C.java")]);
  assert.deepEqual(live.materialized, [changed]);
  assert.equal(log.compared.length, 1);
  assert.notEqual(log.compared[0]![0], log.compared[0]![1]);
  assert.equal(answer.snapshot.kind, "live");
  assert.equal(answer.status !== "unknown" && answer.value.mergeBase, FORK);
  assert.deepEqual(answer.status !== "unknown" && answer.value.seeds.map((seed) => seed.file), ["src/A.java"]);
});

test("a live ofChange on a clean tree compares nothing and reads as the same tree on both sides", async () => {
  const live = fakeLive({ "src/A.java": "1" });
  const { log, queries } = setup({ trust: TRUSTED, live, exports: { [FORK]: { files: [{ path: "src/A.java", blob: "1", written: true }], skipped: [] } } });

  const answer = fact(await queries.ofChange({ ...LIVE_BASE, base: "base", live: true }));

  assert.deepEqual(live.materialized, [[]]);
  assert.equal(log.compared.length, 1);
  assert.equal(answer.status, "complete");
  assert.deepEqual(answer.status === "complete" && answer.value.changedEntrypoints, []);
});

test("a live ofChange whose directories cannot be diffed is unknown source-unreadable, and every scratch directory is removed", async () => {
  const live = fakeLive({ "src/A.java": "2" });
  const { log, queries } = setup({ trust: TRUSTED, live, directoryChanges: { ok: false, fault: { kind: "git-failed", detail: "bad" } } });

  const answer = fact(await queries.ofChange({ ...LIVE_BASE, base: "base", live: true }));

  assert.equal(answer.status === "unknown" && answer.reason, "source-unreadable");
  assert.deepEqual(log.removed.toSorted(), log.created.toSorted());
  assert.deepEqual(live.held, { locks: 1, released: 1 });
});

test("a live ofChange reports an edit made while it answered", async () => {
  const live = fakeLive({ "src/A.java": "1" });
  const notices: LiveStaleNotice[] = [];
  const { queries } = setup({ trust: TRUSTED, live, onDiffDirectories: () => void live.tree.set("src/Z.java", "1") });

  await queries.ofChange({ ...LIVE_BASE, base: "base", live: true, onStale: (notice) => notices.push(notice) });

  assert.deepEqual(notices.map((notice) => notice.changed), [["src/Z.java"]]);
});

test("a callers fact declares the targets it was asked about, in a fixed order", async () => {
  const { callers } = setup({ nodes: SOURCE_NODES, edges: SOURCE_EDGES });
  const answer = await callers({ targets: [{ file: "src/B.java", start: 1, end: 3 }, { file: "src/A.java", symbol: "f" }] });
  assert.ok(answer.ok, JSON.stringify(answer));
  assert.deepEqual(answer.value.inputs.declaredConfig, { targets: ["src/A.java:f", "src/B.java:1-3"] });
  assert.equal(answer.value.inputs.config, canonicalJson(answer.value.inputs.declaredConfig));
});

test("an importers fact declares the files it was asked about", async () => {
  const { importers } = setup({ nodes: SOURCE_NODES });
  const answer = await importers({ files: ["src/A.java"] });
  assert.ok(answer.ok);
  assert.deepEqual(answer.ok && answer.value.inputs.declaredConfig, { files: ["src/A.java"] });
});

test("a fact that read an index records where that index came from", async () => {
  const { ask } = setup({ changes: { ok: true, value: [change("src/A.java")] }, nodes: SOURCE_NODES, edges: SOURCE_EDGES });
  const answer = fact(await ask());
  assert.deepEqual(answer.inputs.origin, { kind: "full" });
});

test("a fact that read no index records no origin", async () => {
  const { ask } = setup({ changes: { ok: true, value: [change("README.md")] } });
  const answer = fact(await ask());
  assert.equal(answer.inputs.origin, undefined);
});

test("an export budget travels in clear beside the config digest", async () => {
  const { ask } = setup({ changes: { ok: true, value: [change("src/A.java")] }, nodes: SOURCE_NODES, exportBudget: { maxEntries: 10, maxBytes: 100 } });
  const answer = fact(await ask());
  assert.deepEqual(answer.inputs.declaredConfig.exportBudget, { maxEntries: 10, maxBytes: 100 });
  assert.equal(answer.inputs.config, canonicalJson(answer.inputs.declaredConfig));
});
