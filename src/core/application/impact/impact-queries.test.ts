import { TYPESCRIPT_PROFILE } from "../../domain/languages/profiles.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FileChange } from "../../domain/change/diff-reader.ts";
import type { ImpactValue } from "../../domain/impact/impact-fact.ts";
import type { FieldOrigin } from "../../domain/relations/field-origin.ts";
import { relation, type Relation } from "../../domain/relations/relation.ts";
import { sameIdentity, type Fact, type Finding } from "../../domain/shared/fact.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { CodeGraph, CodeGraphFault, CodeGraphReader, IndexSummary } from "../../ports/code-graph.port.ts";
import type { ImpactCallersRequest, ImpactFault, ImpactImportersRequest, ImpactOfChangeRequest, OfChangeFault } from "../../ports/impact-queries.port.ts";
import type { AtRevision } from "../../ports/live-queries.port.ts";
import type { ImportersValue } from "../../domain/impact/importers-fact.ts";
import type { CommitExport, Vcs, VcsChanges, VcsFault } from "../../ports/vcs.port.ts";
import type { AngularDeclaration } from "../../ports/angular-declarations.port.ts";
import { fakeCodeGraph, fakeNode, type FakeEdge, type FakeNode, type FakeUnresolved } from "../navigation/fake-code-graph.testing.ts";
import type { TrustRecordReader } from "../../ports/trust-record.port.ts";
import { fakeLive, type FakeLive } from "../live/fake-live.testing.ts";
import type { LiveStaleNotice } from "../../ports/live-queries.port.ts";
import { createImpactQueries, type ImpactQueriesDeps } from "./impact-queries.ts";
import type { ImportOrigins, ImportOriginsReader, ImportOriginSite, ResolvedNameSite } from "../../ports/import-origins.port.ts";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { NOTHING_DECLARED } from "../navigation/edge-targets.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import type { ModuleDependency } from "../../domain/impact/module-dependency.ts";
import { createSnapshotDataCache } from "../snapshot/snapshot-data-cache.ts";
import type { SnapshotDataCache } from "../snapshot/read-snapshot.ts";
import type { TypeBindings, TypeBindingsAnswer, TypeTarget } from "../../ports/type-bindings.port.ts";
import type { DeclaredBuildOutput } from "../../domain/shared/build-outputs.ts";

/** The checker and the build outputs the host declared for every repository. */
interface TypedOption {
  bindings: TypeBindings;
  outputs: readonly DeclaredBuildOutput[];
}

const NOTHING_REPLACED = { paths: [], globalObjects: new Set<string>(), packages: new Set<string>() };

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const FORK = "c".repeat(40);
const SUMMARY: IndexSummary = { filesIndexed: 1, filesSkipped: 0, filesErrored: 0, filesNotIndexed: [], versions: { codegraph: "x", schema: 0, extraction: 0 } };

function change(path: string, overrides: Partial<FileChange> = {}): FileChange {
  const change: FileChange = { path, deleted: false, binary: false, added: [{ start: 1, end: 1 }], removals: [], removedNames: [], hunks: [], ...overrides };
  return { ...change, hunks: change.hunks.length === 0 ? change.added.map((range) => ({ head: range, removedNames: [] })) : change.hunks };
}

/** The head's snapshot listing, holding exactly `paths`, so a target names a file the snapshot has. */
function listingOf(paths: readonly string[]): NonNullable<Options["exports"]> {
  return { [HEAD]: { files: paths.map((path) => ({ path, blob: "1", written: true })), skipped: [] } };
}

interface Options {
  declarationEvidence?: ImpactQueriesDeps["declarationEvidence"];
  changes?: Result<readonly FileChange[], VcsFault>;
  index?: Result<IndexSummary, CodeGraphFault>;
  open?: Result<CodeGraphReader, CodeGraphFault>;
  nodes?: FakeNode[];
  edges?: FakeEdge[];
  unresolved?: FakeUnresolved[];
  declarations?: AngularDeclaration[];
  relations?: Finding<Relation>[];
  relationReader?: ImpactQueriesDeps["relations"];
  fields?: FieldOrigin[];
  loads?: { file: string; line: number; specifier?: string }[];
  exportBudget?: { maxEntries: number; maxBytes: number };
  exports?: Partial<Record<string, CommitExport>>;
  mergeBase?: string;
  signal?: AbortSignal;
  /** Gives the queries an index cache that answers with the fault, or with the fake store when `true`. */
  cache?: true | CodeGraphFault;
  /** With `cache`, the kept index is absent: the cache asks the caller to prepare the snapshot, as it does before a build. */
  buildIndex?: true;
  /** The Vcs lists and writes apart; `materialize` answers the fault when given. */
  lazy?: { list?: VcsFault; materialize?: VcsFault };
  trust?: TrustRecordReader;
  live?: FakeLive;
  /** What `diffDirectories` answers. */
  directoryChanges?: Result<readonly FileChange[], VcsFault>;
  onDiffDirectories?: () => void;
  /** The head's sources, as the export reader hands them over. */
  sources?: SourceFile[];
  /** The trivia lines a tokenizer reads in each source, by path. */
  trivia?: Readonly<Record<string, readonly number[]>>;
  /** Reads the imports of those sources, as composition wires it. */
  importOrigins?: ImportOriginsReader;
  moduleDependencies?: ModuleDependenciesReader;
  snapshotCache?: SnapshotDataCache;
  snapshotSources?: Partial<Record<string, SourceFile[]>>;
  /** The files the unmodelled-constructs reader marks among the sources it receives. */
  unmodelled?: readonly string[];
  typeBindings?: TypedOption;
  /** The source reader hands over only the files the export plan wrote, as the confined reader does. */
  readsPlanned?: true;
  /** A syntax reader that states, in each source, the calls `unresolved` places there. */
  syntax?: true;
}

function setup(options: Options = {}) {
  const log = { exported: [] as string[], plans: [] as { sha: string; destination: string; wanted: string[] }[], compared: [] as [string, string][], created: [] as string[], removed: [] as string[], indexed: 0, closed: 0, reads: 0, extractions: 0, obtained: [] as string[], listed: [] as string[], materialized: [] as string[] };
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
    headBranch: async () => ({ ok: true, value: undefined }),
    canonicalRoot: async (repo) => ({ ok: true, value: repo }),
    repositoryName: async () => ({ ok: true, value: "shop" }),
    exportCommit: async (_repo, sha, destination, plan) => {
      log.exported.push(sha);
      const listed = options.exports?.[sha] ?? { files: [{ path: "src/A.java", blob: "1", written: true }], skipped: [] };
      log.plans.push({ sha, destination, wanted: listed.files.filter((file) => plan.write(file.path)).map((file) => file.path) });
      return { ok: true, value: listed };
    },
  };
  if (options.lazy) {
    const lazy = options.lazy;
    vcs.listCommit = async (_repo, sha) => {
      log.listed.push(sha);
      return lazy.list ? { ok: false, fault: lazy.list } : { ok: true, value: options.exports?.[sha] ?? { files: [{ path: "src/A.java", blob: "1", written: true }], skipped: [] } };
    };
    vcs.materializeCommit = async (_repo, _files, destination) => {
      log.materialized.push(destination);
      return lazy.materialize ? { ok: false, fault: lazy.materialize } : { ok: true, value: undefined };
    };
  }
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
    reader: {
      read: async (root) => {
        log.reads++;
        const plan = log.plans.findLast((candidate) => candidate.destination === root);
        const read = options.snapshotSources?.[plan?.sha ?? ""] ?? options.sources ?? [];
        return options.readsPlanned ? read.filter(({ path }) => plan?.wanted.includes(path)) : read;
      },
    },
    extractor: { extract: async () => { log.extractions++; return []; } },
    angular: { read: async () => options.declarations ?? [] },
    relations: options.relationReader ?? { language: TYPESCRIPT_PROFILE, extract: async () => ({ relations: options.relations ?? [], fields: options.fields ?? [], locals: [] }) },
    dynamicLoads: { extract: async () => options.loads ?? [] },
    contracts: { operations: () => [] },
    graph,
    ...(options.cache && {
      indexes: {
        obtain: async ({ content, prepare }) => {
          log.obtained.push(content);
          const ready = options.buildIndex ? await prepare?.() : undefined;
          if (ready && !ready.ok) return ready;
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
    ...(options.declarationEvidence && { declarationEvidence: options.declarationEvidence }),
    ...(options.importOrigins && { importOrigins: options.importOrigins }),
    ...(options.trivia && { sourceTrivia: { triviaLines: async (file: SourceFile) => new Set(options.trivia?.[file.path] ?? []) } }),
    ...(options.moduleDependencies && { moduleDependencies: options.moduleDependencies }),
    ...(options.snapshotCache && { snapshotCache: options.snapshotCache }),
    ...(options.typeBindings && { typeBindings: options.typeBindings.bindings, declaredOutputs: () => options.typeBindings!.outputs }),
    ...(options.syntax && { memberNames: { memberNames: async (file: SourceFile) => ({ ...NOTHING_DECLARED, calls: (options.unresolved ?? []).filter((use) => use.file === file.path).map(({ line, column, name }) => ({ kind: "calls" as const, line, column: (column ?? 0) + 1, name, owners: [] })) }) } }),
    ...(options.unmodelled && { unmodelled: { extract: async (sources) => sources.map(({ path }) => path).filter((path) => options.unmodelled!.includes(path)) } }),
  };
  const request: AtRevision<ImpactOfChangeRequest> = { repo: "/repo", repoId: "repo", base: "base", head: "head", ...(options.signal && { signal: options.signal }) };
  const queries = createImpactQueries(deps);
  const callersRequest: AtRevision<ImpactCallersRequest> = { repo: "/repo", repoId: "repo", revision: "head", targets: [], ...(options.signal && { signal: options.signal }) };
  const importersRequest: AtRevision<ImpactImportersRequest> = { repo: "/repo", repoId: "repo", revision: "head", files: [], ...(options.signal && { signal: options.signal }) };
  return {
    log,
    deps,
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

test("a base module omitted by export is not classified as a newly added module", async () => {
  const path = "src/index.ts";
  const { ask } = setup({
    changes: { ok: true, value: [change(path)] },
    exports: {
      [HEAD]: { files: [{ path, blob: "head", written: true }], skipped: [] },
      [FORK]: { files: [{ path, blob: "base", written: false }], skipped: [] },
    },
    snapshotSources: { [HEAD]: [{ path, content: "export * from './service';" }], [FORK]: [] },
    moduleDependencies: { extract: async (sources) => ({ files: sources.map((source) => ({ file: source.path, statements: [source.content], moduleOnly: true })), dependencies: [], unread: [] }) },
  });
  const answer = fact(await ask());
  assert.equal(answer.status, "partial");
  assert.equal(answer.value.modules?.origins.some((origin) => origin.change === "added") ?? false, false);
});

test("cancellation after the base module read prevents another parse and indexing", async () => {
  const controller = new AbortController();
  let reads = 0;
  const { ask, log } = setup({
    signal: controller.signal,
    changes: { ok: true, value: [change("src/index.ts")] },
    moduleDependencies: { extract: async () => { reads++; controller.abort(); return { files: [], dependencies: [], unread: [] }; } },
  });
  const answer = await ask();
  assert.ok(!answer.ok && answer.fault.kind === "aborted");
  assert.equal(reads, 1);
  assert.equal(log.indexed, 0);
  assert.deepEqual(log.removed, log.created.toReversed());
});

/** An import reader that proves exactly `names` external and answers `unknown` for every other site. */
function externalImports(names: readonly string[]): ImportOriginsReader {
  return origins((site) => (names.includes(site.name) ? { kind: "external", module: "rxjs" } : undefined));
}

/** An import reader that proves exactly `names` ambient — declared by the language's own libraries. */
function ambientImports(names: readonly string[]): ImportOriginsReader {
  return origins((site) => (names.includes(site.name) ? { kind: "ambient", name: site.name } : undefined));
}

function origins(answer: (site: ImportOriginSite) => ImportOrigin | undefined, root: (site: ResolvedNameSite) => ImportOrigin | undefined = () => undefined): ImportOriginsReader {
  return () => ({
    origins: async (sites) =>
      sites.map((site): Finding<ImportOrigin> & { occurrence: true } => {
        const value = answer(site);
        return value === undefined
          ? { status: "unknown", reason: "unresolved", evidence: [{ path: site.file, line: site.line }], occurrence: true }
          : { status: "complete", value, evidence: [{ path: site.file, line: site.line }], occurrence: true };
      }),
    rootOrigins: async (sites) => sites.map((site) => originFinding(site, root(site))),
    replacedRoots: async () => NOTHING_REPLACED,
    rootBindings: NO_BINDINGS, declaredTypes: NO_DECLARED_TYPES, dispatchTargets: NO_DISPATCH_TARGETS, receiverMethods: NO_RECEIVER_METHODS,
  });
}

function originFinding(site: { file: string; line: number }, value: ImportOrigin | undefined): Finding<ImportOrigin> {
  const evidence = [{ path: site.file, line: site.line }];
  return value === undefined ? { status: "unknown", reason: "unresolved", evidence } : { status: "complete", value, evidence };
}

const NO_ROOTS: ImportOrigins["rootOrigins"] = async (sites) => sites.map((site) => originFinding(site, undefined));
const NO_BINDINGS: ImportOrigins["rootBindings"] = async (sites) => sites.map(() => ({ kind: "unknown" }));
const NO_DECLARED_TYPES: ImportOrigins["declaredTypes"] = async (sites) => sites.map(() => ({ kind: "unknown" }));
const NO_DISPATCH_TARGETS: ImportOrigins["dispatchTargets"] = async (sites) => sites.map(() => ({ kind: "unknown" }));
const NO_RECEIVER_METHODS = async (sites: readonly unknown[]) => sites.map(() => ({ kind: "unknown" as const }));

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

test("ofChange identities distinguish resolved merge bases even when their exported trees match", async () => {
  const otherFork = "d".repeat(40);
  const changes = { ok: true, value: [change("src/A.java")] } as const;
  for (const options of [{}, { changes, cache: true as const }, { changes, index: { ok: false, fault: { kind: "index-failed", detail: "x" } } as const }]) {
    const first = setup({ ...options, mergeBase: FORK });
    const second = setup({ ...options, mergeBase: otherFork });
    const original = fact(await first.ask());
    const different = fact(await second.ask());
    const alias = fact(await first.ask({ base: "another-alias" }));
    assert.equal(sameIdentity(original, different), false);
    assert.equal(sameIdentity(original, alias), true);
    if (original.status !== "unknown" && different.status !== "unknown") {
      assert.equal(original.value.mergeBase, FORK);
      assert.equal(different.value.mergeBase, otherFork);
    }
    if (options.cache) assert.deepEqual(first.log.obtained, second.log.obtained.concat(second.log.obtained));
  }
});

test("live ofChange identities distinguish resolved merge bases for matching trees and unavailable indexes", async () => {
  const otherFork = "d".repeat(40);
  for (const unavailable of [false, true]) {
    const live = fakeLive({ "src/A.java": "1" });
    if (unavailable) live.engine.lock = { ok: false, fault: { kind: "aborted", detail: "waiting" } };
    const first = setup({ trust: TRUSTED, live, mergeBase: FORK });
    const second = setup({ trust: TRUSTED, live, mergeBase: otherFork });
    const request = { ...LIVE_BASE, base: "base", live: true } as const;
    const original = fact(await first.queries.ofChange(request));
    const different = fact(await second.queries.ofChange(request));
    assert.equal(sameIdentity(original, different), false);
    if (!unavailable && original.status !== "unknown" && different.status !== "unknown") {
      assert.equal(original.value.mergeBase, FORK);
      assert.equal(different.value.mergeBase, otherFork);
      assert.deepEqual(original.snapshot, different.snapshot);
    }
  }
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
  assert.deepEqual(bounded.status === "partial" && bounded.cuts, [{ kind: "depth", at: ["src/A.java::f"], limit: 0, reason: "depth", reach: { kind: "anything" } }]);
});

test("a file the export left out cuts the answer, and one the index did not hold outside what the export staged does not", async () => {
  const changes: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change("src/A.java")] };
  const skipped: CommitExport = { files: [{ path: "src/A.java", blob: "1", written: true }], skipped: [{ path: "src/Link.java", reason: "symlink" }] };
  const { ask } = setup({
    changes,
    nodes: SOURCE_NODES,
    index: { ok: true, value: { ...SUMMARY, filesNotIndexed: ["src/out/X.java"] } },
    exports: { [FORK]: skipped },
  });
  const answer = fact(await ask());
  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "not-exported", at: ["src/Link.java"], reason: "symlink", reach: { kind: "anything" } }]);
});

test("a staged file the index does not hold still cuts the answer at that file", async () => {
  const changes: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change("src/A.java")] };
  const staged: CommitExport = {
    files: [
      { path: "src/A.java", blob: "1", written: true },
      { path: "src/out/X.java", blob: "2", written: true },
    ],
    skipped: [],
  };
  const { ask } = setup({
    changes,
    nodes: SOURCE_NODES,
    index: { ok: true, value: { ...SUMMARY, filesNotIndexed: ["src/out/X.java"] } },
    exports: { [HEAD]: staged },
  });
  const answer = fact(await ask());
  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "no-extractor", at: ["src/out/X.java"], reason: "not-indexed", reach: { kind: "anything", runtime: "java" } }]);
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
  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "no-extractor", at: ["src/Money.java"], reason: "no-symbols", reach: { kind: "anything", runtime: "java" } }]);
});

test("a call that never resolved to a walked name cuts the answer, and the head's own export cuts are in the fact", async () => {
  const changes: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change("src/A.java", { added: [{ start: 2, end: 2 }] })] };
  const unresolved = [{ from: "g", name: "f", kind: "calls", file: "src/A.java", line: 7 }];
  const left: CommitExport = {
    files: [{ path: "src/A.java", blob: "1", written: true }, { path: "src/B.java", blob: "2", written: true }],
    skipped: [{ path: "src/Link.java", reason: "symlink" }],
  };
  const answer = fact(await setup({ changes, nodes: SOURCE_NODES, edges: SOURCE_EDGES, unresolved, exports: { [HEAD]: left } }).ask());
  assert.deepEqual(answer.status === "partial" && answer.cuts, [
    { kind: "unresolved-link", at: ["src/A.java::f", "src/A.java:7"], reason: "hidden-caller", reach: { kind: "callers-of", declarations: ["src/A.java::f"] } },
    { kind: "not-exported", at: ["src/Link.java"], reason: "symlink", reach: { kind: "anything" } },
  ]);
});

test("a declaration in a configuration file the runtime never runs is no candidate of an unresolved call", async () => {
  const nodes = [fakeNode("routes", "function", "src/app/routes.ts", 1, 3), fakeNode("generate", "function", "build.gradle.kts", 1, 3)];
  const unresolved = [{ from: "routes", name: "steps.generate", kind: "calls", file: "src/app/routes.ts", line: 7, column: 0, candidates: ["build.gradle.kts::generate"] }];
  const exports: Options["exports"] = {
    [HEAD]: { files: [{ path: "src/app/routes.ts", blob: "1", written: true }, { path: "build.gradle.kts", blob: "2", written: true }], skipped: [] },
  };

  const answer = callersFact(await setup({ nodes, unresolved, exports }).callers({ targets: [{ file: "build.gradle.kts", symbol: "generate" }] }));

  assert.equal(answer.status, "complete");
});

test("a reference whose rooted name the file imports from outside the repository stops being a cut, without any type root", async () => {
  const changes: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change("src/A.ts", { added: [{ start: 2, end: 2 }] })] };
  const nodes = [fakeNode("tap", "function", "src/A.ts", 1, 3)];
  const unresolved = [{ from: "f", name: "tap", kind: "calls", file: "src/A.ts", line: 7, column: 0 }];
  const exports: Options["exports"] = {
    [HEAD]: { files: [{ path: "src/A.ts", blob: "1", written: true }, { path: "src/B.ts", blob: "2", written: true }], skipped: [] },
  };

  const withoutImports = fact(await setup({ changes, nodes, unresolved, exports }).ask());
  const withImports = fact(await setup({ changes, nodes, unresolved, exports, importOrigins: externalImports(["tap"]) }).ask());

  assert.deepEqual(withoutImports.status === "partial" && withoutImports.cuts, [{ kind: "unresolved-link", at: ["src/A.ts::tap", "src/A.ts:7"], reason: "hidden-caller", reach: { kind: "callers-of", declarations: ["src/A.ts::tap"] } }]);
  assert.equal(withImports.status, "complete");
});

test("the head's unresolved references are read from the store once per request, for the proofs and for the walk alike", async () => {
  const nodes = [fakeNode("tap", "function", "src/A.ts", 1, 3)];
  const unresolved = [{ from: "f", name: "tap", kind: "calls", file: "src/A.ts", line: 7, column: 0 }];
  const exports: Options["exports"] = { [HEAD]: { files: [{ path: "src/A.ts", blob: "1", written: true }], skipped: [] } };
  const changes: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change("src/A.ts", { added: [{ start: 2, end: 2 }] })] };
  const reads = async (ask: (queries: ReturnType<typeof setup>) => Promise<unknown>, withOrigins: boolean): Promise<number> => {
    const store = fakeCodeGraph(nodes, [], unresolved);
    const counted: string[][] = [];
    const queries = setup({ changes, nodes, unresolved, exports, ...(withOrigins && { importOrigins: externalImports(["tap"]) }), open: { ok: true, value: { ...store, unresolvedReferences: (files) => { counted.push([...files]); return store.unresolvedReferences(files); } } } });
    await ask(queries);
    return counted.length;
  };
  for (const withOrigins of [true, false]) {
    assert.equal(await reads((queries) => queries.ask(), withOrigins), 1);
    assert.equal(await reads((queries) => queries.callers({ targets: [{ file: "src/A.ts", symbol: "tap" }] }), withOrigins), 1);
  }
});

test("an external proof retires its own reference, never another one that shares its line", async () => {
  const changes: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change("src/A.ts", { added: [{ start: 2, end: 2 }] })] };
  const nodes = [fakeNode("tap", "function", "src/A.ts", 1, 3), fakeNode("save", "function", "src/A.ts", 1, 3)];
  const unresolved = [
    { from: "f", name: "tap", kind: "calls", file: "src/A.ts", line: 7, column: 0 },
    { from: "f", name: "save", kind: "calls", file: "src/A.ts", line: 7, column: 0 },
  ];
  const exports: Options["exports"] = {
    [HEAD]: { files: [{ path: "src/A.ts", blob: "1", written: true }, { path: "src/B.ts", blob: "2", written: true }], skipped: [] },
  };

  const answer = fact(await setup({ changes, nodes, unresolved, exports, importOrigins: externalImports(["tap"]) }).ask());

  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "unresolved-link", at: ["src/A.ts::save", "src/A.ts:7"], reason: "hidden-caller", reach: { kind: "callers-of", declarations: ["src/A.ts::save"] } }]);
});

test("a reference rooted at a name the language's own libraries declare stops being a cut", async () => {
  const changes: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change("src/B.ts", { added: [{ start: 2, end: 2 }] })] };
  const nodes = [fakeNode("log", "function", "src/B.ts", 1, 3)];
  const unresolved = [{ from: "f", name: "console.log", kind: "calls", file: "src/A.ts", line: 7, column: 0 }];
  const exports: Options["exports"] = {
    [HEAD]: { files: [{ path: "src/A.ts", blob: "1", written: true }, { path: "src/B.ts", blob: "2", written: true }], skipped: [] },
  };

  const withoutProof = fact(await setup({ changes, nodes, unresolved, exports }).ask());
  const withProof = fact(await setup({ changes, nodes, unresolved, exports, importOrigins: ambientImports(["console"]) }).ask());

  assert.deepEqual(withoutProof.status === "partial" && withoutProof.cuts, [{ kind: "unresolved-link", at: ["src/A.ts", "src/A.ts:7 console.log"], reason: "name-only", reach: { kind: "callers-of", declarations: ["src/B.ts::log"] } }]);
  assert.equal(withProof.status, "complete");
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
  const changes: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change("src/A.java", { added: [{ start: 2, end: 2 }] }), change("src/app.component.ts", { added: [{ start: 1, end: 1 }] })] };
  const unresolved = [
    { from: "g", name: "import", kind: "calls", file: "src/App.ts", line: 3 },
    { from: "g", name: "import", kind: "calls", file: "src/Routes.ts", line: 8 },
  ];
  const tree: CommitExport = {
    files: [
      { path: "src/A.java", blob: "1", written: true },
      { path: "src/App.ts", blob: "2", written: true },
      { path: "src/Routes.ts", blob: "3", written: true },
      { path: "src/app.component.ts", blob: "4", written: true },
    ],
    skipped: [],
  };
  const loads = [
    { file: "src/App.ts", line: 3, specifier: "./app.component" },
    { file: "src/Routes.ts", line: 8 },
  ];
  const answer = fact(await setup({ changes, nodes: SOURCE_NODES, edges: SOURCE_EDGES, unresolved, loads, exports: { [HEAD]: tree } }).ask());
  assert.deepEqual(answer.status === "partial" && answer.cuts.filter(({ reason }) => reason === "dynamic-load"), [{ kind: "unresolved-link", at: ["src/Routes.ts", "src/Routes.ts:8 import"], reason: "dynamic-load", reach: { kind: "anything", runtime: "typescript" } }]);
});

test("a source file deleted whole that declared a name needs the index, and an unresolved reference to the name cuts the answer", async () => {
  const gone = change("src/Gone.java", { deleted: true, added: [], removals: [{ after: 0 }], removedNames: ["Gone"] });
  const unresolved = [{ from: "g", name: "Gone", kind: "instantiates", file: "src/B.java", line: 7 }];
  const exports = { [HEAD]: { files: [{ path: "src/B.java", blob: "2", written: true }], skipped: [] } };
  const { log, ask } = setup({ changes: { ok: true, value: [gone] }, unresolved, exports });
  const answer = fact(await ask());
  assert.equal(log.indexed, 1);
  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "unresolved-link", at: ["src/Gone.java::Gone", "src/B.java:7"], reason: "removed-declaration", reach: { kind: "callers-of", declarations: ["src/Gone.java::Gone"] } }]);
});

test("lines removed between symbols that declared a name cut the answer at the references that still name it, and a removed import does not", async () => {
  const nodes = [fakeNode("f", "function", "src/A.java", 1, 5), fakeNode("g", "function", "src/A.java", 20, 25)];
  const removed = change("src/A.java", { added: [], removals: [{ after: 10 }, { after: 12 }], removedNames: ["helper"] });
  const unresolved = [
    { from: "g", name: "this.helper", kind: "calls", file: "src/A.java", line: 22 },
    { from: "g", name: "Other", kind: "calls", file: "src/A.java", line: 23 },
  ];
  const answer = fact(await setup({ changes: { ok: true, value: [removed] }, nodes, unresolved }).ask());
  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "unresolved-link", at: ["src/A.java::helper", "src/A.java:22"], reason: "removed-declaration", reach: { kind: "callers-of", declarations: ["src/A.java::helper"] } }]);
});

test("removed-declaration cuts receive the head's exact import proofs without hiding unknown candidates", async () => {
  const useFile = "src/use.ts";
  const unresolved = [
    { from: "use", name: "Promise.resolve", kind: "calls", file: useFile, line: 2, column: 0 },
    { from: "use", name: "save", kind: "calls", file: useFile, line: 3, column: 0 },
    { from: "use", name: "service.resolve", kind: "calls", file: useFile, line: 4, column: 0 },
  ];
  const changes = { ok: true, value: [change("src/gone.ts", { deleted: true, added: [], removedNames: ["resolve", "save"] })] } as const;
  const exports = { [HEAD]: { files: [{ path: useFile, blob: "1", written: true }], skipped: [] } };
  const answer = fact(await setup({
    changes, exports, unresolved,
    nodes: [fakeNode("use", "function", useFile, 1, 5)],
    importOrigins: origins((site) => site.name === "Promise" ? { kind: "ambient", name: "Promise" } : site.name === "save" ? { kind: "repository", file: "src/other.ts" } : undefined),
  }).ask());
  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "unresolved-link", at: ["src/gone.ts::resolve", `${useFile}:4`], reason: "removed-declaration", reach: { kind: "callers-of", declarations: ["src/gone.ts::resolve"] } }]);
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

test("a reference through a field of known origin is a caller when the field holds the owner or a class below it that inherits the member, and every such use of a walked name stays a cut at the caller's file", async () => {
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
    { from: "viaSvc", name: "this.svc.get", kind: "calls", file: CMP_FILE, line: 6, column: 0 },
    { from: "viaHttp", name: "this.http.get", kind: "calls", file: CMP_FILE, line: 9, column: 0 },
    { from: "viaMap", name: "this.cache.get", kind: "calls", file: CMP_FILE, line: 12, column: 0 },
    { from: "viaOther", name: "this.other.get", kind: "calls", file: CMP_FILE, line: 15, column: 0 },
    { from: "viaSub", name: "this.sub.get", kind: "calls", file: CMP_FILE, line: 18, column: 0 },
    { from: "viaLocal", name: "params.get", kind: "calls", file: CMP_FILE, line: 21, column: 0 },
    { from: "viaUnknown", name: "this.store.get", kind: "calls", file: CMP_FILE, line: 24, column: 0 },
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

  const sources = [SVC_FILE, CMP_FILE, SUB_FILE].map((path) => ({ path, content: "" }));
  const answer = fact(await setup({ changes, nodes, edges, unresolved, exports, sources, fields, importOrigins: origins(() => undefined), syntax: true }).ask());
  assert.ok(answer.status === "partial");
  assert.deepEqual(answer.value.symbols.filter((symbol) => symbol.file === CMP_FILE).map((symbol) => symbol.symbol), ["Cmp", "viaSvc", "viaSub"]);
  assert.deepEqual(answer.cuts.find((cut) => cut.kind === "unresolved-link"), { kind: "unresolved-link", at: [CMP_FILE, ...[12, 15, 18, 21, 24, 6, 9].map((line) => `${CMP_FILE}:${line} ${unresolved.find((use) => use.line === line)!.name}`)], reason: "name-only", reach: { kind: "callers-of", declarations: ["src/app/svc.ts::get"] } });
});

test("a relation the reader could not place cuts the answer only in a file the walk reached", async () => {
  const reached = fact(await setup({ changes: SVC_CHANGE, nodes: ANGULAR_NODES, relations: [complete(INJECTION), unread(CMP_FILE, 5)] }).ask());
  assert.deepEqual(reached.status === "partial" && reached.cuts, [{ kind: "unresolved-link", at: [CMP_FILE, `${CMP_FILE}:5 unresolved`], reason: "relation-unread", reach: { kind: "anything", runtime: "typescript" } }]);
  const elsewhere = fact(await setup({ changes: SVC_CHANGE, nodes: ANGULAR_NODES, relations: [complete(INJECTION), unread("src/app/far.ts", 5)] }).ask());
  assert.equal(elsewhere.status, "complete");
});

test("a changed template no component names through templateUrl is a cut at that file, and one a component claims is not", async () => {
  const declarations: AngularDeclaration[] = [{ file: "src/app/cmp.ts", name: "Cmp", line: 2, decorator: "Component", resources: ["src/app/cmp.html"] }];
  const nodes = [fakeNode("Cmp", "class", "src/app/cmp.ts", 1, 5)];
  const changes: Result<readonly FileChange[], VcsFault> = { ok: true, value: [change("src/app/cmp.html"), change("src/app/lost.html"), change("src/app/old.htm")] };
  const answer = fact(await setup({ changes, declarations, nodes }).ask());
  assert.deepEqual(answer.status === "partial" && answer.cuts, [
    { kind: "no-extractor", at: ["src/app/lost.html"], reason: "template-uncovered", reach: { kind: "anything", runtime: "typescript" } },
    { kind: "no-extractor", at: ["src/app/old.htm"], reason: "template-uncovered", reach: { kind: "anything", runtime: "typescript" } },
  ]);
});

test("a changed source no declared framework reads cuts nothing, and one in a repository with no declared source cuts", async () => {
  const foreign: Result<readonly FileChange[], VcsFault> = { ok: true, value: ["ios/App/AppDelegate.swift", "scripts/inject-env.mjs", "eslint.config.js"].map((path) => change(path)) };
  assert.equal(fact(await setup({ changes: foreign }).ask()).status, "complete");

  const python = { files: [{ path: "app.py", blob: "1", written: true }], skipped: [] };
  const outside = fact(await setup({ changes: { ok: true, value: [change("app.py")] }, exports: { [BASE]: python, [HEAD]: python } }).ask());
  assert.deepEqual(outside.status === "partial" && outside.cuts, [{ kind: "no-extractor", at: ["app.py"], reason: "language", reach: { kind: "anything" } }]);
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
  assert.deepEqual(value?.seeds, [{ file: "src/A.java", symbol: "f", line: 1, endLine: 3, basis: "requested" }]);
  assert.deepEqual(value?.symbols.map((symbol) => [symbol.symbol, symbol.depth]), [["f", 0], ["g", 1]]);
  assert.equal(value !== undefined && ("mergeBase" in value || "changedEntrypoints" in value), false);
  assert.deepEqual(answer.snapshot, { repo: "repo", kind: "sha", sha: HEAD });
});

test("a call the index resolved into an edge of another kind is still a reference whose name tail a reached declaration matches", async () => {
  const nodes = [fakeNode("navigate", "method", "src/B.ts", 1, 3, "navigate"), fakeNode("open", "method", "src/A.ts", 5, 9, "open"), fakeNode("route", "route", "src/routes.ts", 1, 1, "route")];
  const edges: FakeEdge[] = [{ from: "open", to: "route", kind: "navigates", line: 7, column: 4, resolvedFrom: { name: "this.router.navigate", kind: "calls" } }];
  const exports: Options["exports"] = { [HEAD]: { files: [{ path: "src/A.ts", blob: "1", written: true }, { path: "src/B.ts", blob: "2", written: true }], skipped: [] } };

  const answer = callersFact(await setup({ nodes, edges, exports }).callers({ targets: [{ file: "src/B.ts", symbol: "navigate" }] }));

  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "unresolved-link", at: ["src/A.ts", "src/A.ts:7 this.router.navigate"], reason: "name-only", reach: { kind: "callers-of", declarations: ["src/B.ts::navigate"] } }]);
});

test("a reached symbol names locations of the selected evidence category", async () => {
  const nodes = [fakeNode("f", "function", "src/A.java", 1, 3), fakeNode("g", "function", "src/B.java", 10, 40)];
  const edges = [
    { from: "g", to: "f", kind: "calls", confidence: 0.9, line: 14 },
    { from: "g", to: "f", kind: "calls", confidence: 0.9, line: 21 },
    { from: "g", to: "f", kind: "references", confidence: 0.9, line: 33 },
  ];
  const answer = callersFact(await setup({ nodes, edges }).callers({ targets: [{ file: "src/A.java", symbol: "f" }] }));
  const reached = answer.status === "complete" ? answer.value.symbols.find((symbol) => symbol.symbol === "g") : undefined;
  assert.deepEqual(reached?.via, { file: "src/A.java", symbol: "f", lines: [14, 21], basis: "call", derivation: "resolved" });
  assert.equal(reached?.endLine, 40);
});

test("selected constructor evidence excludes type-reference locations", async () => {
  const nodes = [fakeNode("f", "class", "src/A.java", 1, 3), fakeNode("g", "method", "src/B.java", 10, 40)];
  const edges = [{ from: "g", to: "f", kind: "references", confidence: 0.8, line: 11 }, { from: "g", to: "f", kind: "instantiates", confidence: 0.9, line: 13 }];
  const answer = fact(await setup({ nodes, edges, changes: { ok: true, value: [change("src/A.java")] } }).ask());
  const reached = answer.status !== "unknown" ? answer.value.symbols.find((symbol) => symbol.symbol === "g") : undefined;
  assert.deepEqual(reached?.via, { file: "src/A.java", symbol: "f", lines: [13], basis: "call", derivation: "resolved" });
});

test("a dependence that is a use and not a call says so, so a reference is never read as a signature to change", async () => {
  const nodes = [fakeNode("f", "function", "src/A.java", 1, 3), fakeNode("g", "function", "src/B.java", 10, 20)];
  const edges = [{ from: "g", to: "f", kind: "references", confidence: 0.9, line: 7 }];
  const answer = callersFact(await setup({ nodes, edges }).callers({ targets: [{ file: "src/A.java", symbol: "f" }] }));
  const reached = answer.status === "complete" ? answer.value.symbols.find((symbol) => symbol.symbol === "g") : undefined;
  assert.deepEqual(reached?.via, { file: "src/A.java", symbol: "f", lines: [7], basis: "reference", derivation: "resolved" });
});

test("a dependence the walk never places names its reason instead of leaving the line silent", async () => {
  const nodes = [fakeNode("C", "class", "src/A.java", 1, 40), fakeNode("C.m", "method", "src/A.java", 5, 9, "m")];
  const edges = [{ from: "C", to: "C.m", kind: "contains" }];
  const answer = callersFact(await setup({ nodes, edges }).callers({ targets: [{ file: "src/A.java", symbol: "m" }] }));
  const owner = answer.status === "complete" ? answer.value.symbols.find((symbol) => symbol.symbol === "C") : undefined;
  assert.deepEqual(owner?.via, { file: "src/A.java", symbol: "m", basis: "contains", derivation: "resolved" });
});

const TWO_CLASSES = {
  nodes: [fakeNode("A", "class", "src/A.ts", 1, 9), fakeNode("A.m", "method", "src/A.ts", 2, 4, "m"), fakeNode("B", "class", "src/A.ts", 11, 19), fakeNode("B.m", "method", "src/A.ts", 12, 14, "m")],
  edges: [{ from: "A", to: "A.m", kind: "contains" }, { from: "B", to: "B.m", kind: "contains" }],
};

test("a dotted symbol seeds only the member its container holds, not a same-named member of another container", async () => {
  const answer = callersFact(await setup(TWO_CLASSES).callers({ targets: [{ file: "src/A.ts", symbol: "A.m" }] }));
  assert.deepEqual(answer.status === "complete" && answer.value.seeds.map((seed) => seed.line), [2]);
});

test("a missing symbol lists the dotted containment paths of its file, so a candidate selects one declaration", async () => {
  const answer = await setup({ ...TWO_CLASSES, exports: listingOf(["src/A.ts"]) }).callers({ targets: [{ file: "src/A.ts", symbol: "gone" }] });
  assert.ok(!answer.ok);
  assert.deepEqual(answer.fault.kind === "unknown-symbol" && answer.fault.entries.flatMap((entry) => entry.candidates), ["A", "A.m", "B", "B.m"]);
});

test("a symbol target on a path the snapshot does not hold is absent, with the snapshot files that declare that name", async () => {
  const answer = await setup(TWO_CLASSES).callers({ targets: [{ file: "src/pkg/A.ts", symbol: "m" }] });
  assert.ok(!answer.ok);
  assert.deepEqual(answer.fault.kind === "unknown-symbol" && answer.fault.entries, [{ file: "src/pkg/A.ts", symbol: "m", absent: true, candidates: ["src/A.ts"] }]);
});

test("a dotted symbol target on a path the snapshot does not hold looks its candidates up by the member's own name", async () => {
  const answer = await setup(TWO_CLASSES).callers({ targets: [{ file: "src/pkg/A.ts", symbol: "B.m" }] });
  assert.ok(!answer.ok);
  assert.deepEqual(answer.fault.kind === "unknown-symbol" && answer.fault.entries, [{ file: "src/pkg/A.ts", symbol: "B.m", absent: true, candidates: ["src/A.ts"] }]);
});

test("a requested range on a file the snapshot does not hold is a fault, never a partial answer with a no-extractor cut", async () => {
  const files = [{ path: "src/A.ts", blob: "1", written: true }];
  const { callers } = setup({ nodes: [fakeNode("f", "function", "src/A.ts", 1, 3)], exports: { [HEAD]: { files, skipped: [] } } });
  const answer = await callers({ targets: [{ file: "src/pkg/A.ts", start: 4, end: 6 }] });
  assert.ok(!answer.ok);
  assert.deepEqual(answer.fault.kind === "unknown-symbol" && answer.fault.entries, [{ file: "src/pkg/A.ts", start: 4, end: 6, absent: true, candidates: ["src/A.ts"] }]);
});

test("a declaration carries its last line only when it spans more than one line", async () => {
  const nodes = [fakeNode("f", "function", "src/A.java", 1, 3), fakeNode("one", "function", "src/B.java", 7, 7)];
  const answer = callersFact(await setup({ nodes }).callers({ targets: [{ file: "src/A.java", symbol: "f" }, { file: "src/B.java", symbol: "one" }] }));
  const value = answer.status === "complete" ? answer.value : undefined;
  assert.deepEqual(value?.seeds, [
    { file: "src/A.java", symbol: "f", line: 1, endLine: 3, basis: "requested" },
    { file: "src/B.java", symbol: "one", line: 7, basis: "requested" },
  ]);
});

test("a requested line range seeds like changed lines do: the innermost symbol it touches, by lines", async () => {
  const nodes = [fakeNode("f", "function", "src/A.java", 1, 3), fakeNode("h", "function", "src/A.java", 10, 14)];
  const { callers } = setup({ nodes });
  const answer = callersFact(await callers({ targets: [{ file: "src/A.java", start: 11, end: 12 }] }));
  assert.deepEqual(answer.status === "complete" && answer.value.seeds.map((seed) => [seed.symbol, seed.basis]), [["h", "lines"]]);
});

/** `f` at 1-3 and `h` at 10-14, with blank and comment lines between them; `g` at 20 lies outside every range below. */
function rangeFile(between: readonly string[]): SourceFile {
  return { path: "src/A.ts", content: ["export function f() {", "  return 1;", "}", ...between, "export function h() {", "  return 2;", "", "", "}", "", "", "", "", "", "export function g() {}", ""].join("\n") };
}
const RANGE_NODES = [fakeNode("f", "function", "src/A.ts", 1, 3), fakeNode("h", "function", "src/A.ts", 10, 14), fakeNode("g", "function", "src/A.ts", 20, 20)];

test("a requested range selects the declarations it intersects, and its blank and comment lines between them select nothing", async () => {
  const { callers } = setup({ nodes: RANGE_NODES, sources: [rangeFile(["", "// note", "/* block", "   still */", "", ""])], trivia: { "src/A.ts": [4, 5, 6, 7, 8, 9, 12, 13, 15, 16, 17, 18, 19, 21] } });
  const seeds = async (start: number, end: number) => {
    const answer = callersFact(await callers({ targets: [{ file: "src/A.ts", start, end }] }));
    return answer.status === "unknown" ? [] : answer.value.seeds.map((seed) => [seed.symbol, seed.basis]);
  };
  assert.deepEqual(await seeds(2, 11), [["f", "lines"], ["h", "lines"]]);
  assert.deepEqual(await seeds(12, 13), [["h", "lines"]]);
});

test("a requested range that selects no declaration, past the end of its file or only over trivia between declarations, is an unknown-symbol fault with what the file declares", async () => {
  const { callers } = setup({ nodes: RANGE_NODES, sources: [rangeFile(["", "// note", "/* block", "   still */", "", ""])], trivia: { "src/A.ts": [4, 5, 6, 7, 8, 9, 12, 13, 15, 16, 17, 18, 19, 21] }, exports: listingOf(["src/A.ts"]) });
  for (const [start, end] of [[30, 35], [5, 7]] as const) {
    const answer = await callers({ targets: [{ file: "src/A.ts", start, end }, { file: "src/A.ts", start: 2, end: 2 }] });
    assert.ok(!answer.ok, `${start}-${end}`);
    assert.equal(answer.fault.kind, "unknown-symbol");
    assert.deepEqual(answer.fault.kind === "unknown-symbol" && answer.fault.entries, [{ file: "src/A.ts", start, end, absent: false, candidates: ["f", "g", "h"] }]);
  }
});

test("a requested range over a top-level statement still selects every top-level declaration of its file", async () => {
  const { callers } = setup({ nodes: RANGE_NODES, sources: [rangeFile(["", "register(f);", "", "", "", ""])], trivia: { "src/A.ts": [4, 6, 7, 8, 9] } });
  const answer = callersFact(await callers({ targets: [{ file: "src/A.ts", start: 4, end: 5 }] }));
  assert.deepEqual(answer.status !== "unknown" && answer.value.seeds.map((seed) => [seed.symbol, seed.basis]), [["f", "top-level"], ["h", "top-level"], ["g", "top-level"]]);
});

test("a symbol that is both requested and inside a requested range seeds once, as requested", async () => {
  const { callers } = setup({ nodes: SOURCE_NODES, edges: SOURCE_EDGES });
  const answer = callersFact(await callers({ targets: [{ file: "src/A.java", start: 1, end: 2 }, { file: "src/A.java", symbol: "f" }] }));
  assert.deepEqual(answer.status === "complete" && answer.value.seeds, [{ file: "src/A.java", symbol: "f", line: 1, endLine: 3, basis: "requested" }]);
});

test("a requested symbol that names no node at the revision is a typed failure naming the entries, even beside one that exists", async () => {
  const { callers } = setup({ nodes: SOURCE_NODES, exports: listingOf(["src/A.java", "src/B.java"]) });
  const answer = await callers({ targets: [{ file: "src/A.java", symbol: "f" }, { file: "src/A.java", symbol: "gone" }, { file: "src/B.java", symbol: "f" }] });
  assert.ok(!answer.ok);
  assert.equal(answer.fault.kind, "unknown-symbol");
  assert.deepEqual(answer.fault.kind === "unknown-symbol" && answer.fault.entries, [
    { file: "src/A.java", symbol: "gone", absent: false, candidates: ["f"] },
    { file: "src/B.java", symbol: "f", absent: false, candidates: ["g"] },
  ]);
});

test("a missing entry names the seedable declarations of its file, sorted and once each, and none for a file the index does not hold", async () => {
  const nodes = [fakeNode("z", "function", "src/A.java", 1), fakeNode("a1", "method", "src/A.java", 5, 5, "a"), fakeNode("a2", "method", "src/A.java", 9, 9, "a"), fakeNode("d", "field", "src/A.java", 12)];
  const { callers } = setup({ nodes });
  const answer = await callers({ targets: [{ file: "src/A.java", symbol: "gone" }, { file: "src/Elsewhere.java", symbol: "x" }] });
  assert.ok(!answer.ok);
  assert.deepEqual(answer.fault.kind === "unknown-symbol" && answer.fault.entries, [
    { file: "src/A.java", symbol: "gone", absent: false, candidates: ["a", "z"] },
    { file: "src/Elsewhere.java", symbol: "x", absent: true, candidates: [] },
  ]);
});

test("the walk budget reaches the callers fact as a cut, and the config digest covers the targets", async () => {
  const { callers } = setup({ nodes: SOURCE_NODES, edges: SOURCE_EDGES });
  const bounded = callersFact(await callers({ targets: [{ file: "src/A.java", symbol: "f" }], budget: { depth: 0 } }));
  assert.deepEqual(bounded.status === "partial" && bounded.cuts, [{ kind: "depth", at: ["src/A.java::f"], limit: 0, reason: "depth", reach: { kind: "anything" } }]);
  const config = async (targets: ImpactCallersRequest["targets"]): Promise<string> => callersFact(await callers({ targets })).inputs.config;
  assert.notEqual(await config([{ file: "src/A.java", symbol: "f" }]), await config([{ file: "src/B.java", symbol: "g" }]));
  assert.equal(await config([{ file: "src/A.java", symbol: "f" }, { file: "src/B.java", symbol: "g" }]), await config([{ file: "src/B.java", symbol: "g" }, { file: "src/A.java", symbol: "f" }]));
});

test("a requested range in a file no extractor covers, and one in a file without symbols, cut the answer instead of answering empty", async () => {
  const { callers } = setup({ nodes: SOURCE_NODES, exports: listingOf(["README.md", "src/test/java/ATest.java", "src/Money.java"]) });
  const answer = callersFact(await callers({ targets: [{ file: "README.md", start: 1, end: 2 }, { file: "src/test/java/ATest.java", start: 1, end: 2 }, { file: "src/Money.java", start: 1, end: 2 }] }));
  assert.deepEqual(answer.status === "partial" && answer.cuts, [
    { kind: "no-extractor", at: ["README.md"], reason: "not-source", reach: { kind: "anything" } },
    { kind: "no-extractor", at: ["src/Money.java"], reason: "no-symbols", reach: { kind: "anything", runtime: "java" } },
    { kind: "no-extractor", at: ["src/test/java/ATest.java"], reason: "not-source", reach: { kind: "anything", runtime: "java" } },
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

test("importers reads a call the index resolved into an edge of another kind as an unresolved reference that can name the file", async () => {
  const nodes = [fakeNode("router", "file", "src/router.ts", 1, 9, "router"), fakeNode("open", "method", "src/A.ts", 5, 9, "open"), fakeNode("route", "route", "src/routes.ts", 1, 1, "route")];
  const edges: FakeEdge[] = [{ from: "open", to: "route", kind: "navigates", line: 7, column: 4, resolvedFrom: { name: "this.router.navigate", kind: "calls" } }];
  const exports: Options["exports"] = { [HEAD]: { files: ["src/A.ts", "src/router.ts", "src/routes.ts"].map((path) => ({ path, blob: path, written: true })), skipped: [] } };

  const answer = importersFact(await setup({ nodes, edges, exports }).importers({ files: ["src/router.ts"] }));

  assert.deepEqual(answer.status !== "unknown" && answer.value.files.map((entry) => entry.unresolvedNamers), [["src/A.ts"]]);
});

test("a file the index did not hold cuts the importers of an asked file only when it shares the file's runtime (ADR-0042 fixtures 1, 4)", async () => {
  const exports: Options["exports"] = { [HEAD]: { files: ["src/A.ts", "src/B.ts", "src/X.java"].map((path) => ({ path, blob: path, written: true })), skipped: [] } };
  const nodes = [fakeNode("A.ts", "file", "src/A.ts", 1, 9), fakeNode("Order.java", "file", "src/Order.java", 1, 9)];
  const { importers } = setup({ nodes, exports, index: { ok: true, value: { ...SUMMARY, filesNotIndexed: ["src/B.ts"] } } });

  const typescript = importersFact(await importers({ files: ["src/A.ts"] }));
  const java = importersFact(await importers({ files: ["src/Order.java"] }));

  assert.deepEqual(typescript.status === "partial" && typescript.cuts.map(({ at, reason }) => `${at[0]} ${reason}`), ["src/B.ts not-indexed"]);
  assert.equal(java.status, "complete");
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
    { kind: "no-extractor", at: ["README.md"], reason: "language", reach: { kind: "anything" } },
    { kind: "no-extractor", at: ["src/Late.java"], reason: "not-indexed", reach: { kind: "anything", runtime: "java" } },
  ]);
});

test("a requested file the snapshot does not hold is cut as not-exported, never as no-extractor", async () => {
  const { importers } = setup({ nodes: SHOP_NODES, exports: { [HEAD]: SHOP_EXPORT } });
  const answer = importersFact(await importers({ files: ["src/Order.java", "src/Ghost.java"] }));
  assert.equal(answer.status, "partial");
  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "not-exported", at: ["src/Ghost.java"], reason: "unwritten", reach: { kind: "anything", runtime: "java" } }]);
});

test("a file that loads modules by a computed name may import anything, so it cuts the importers answer", async () => {
  const { importers } = setup({ nodes: SHOP_NODES, unresolved: [{ from: "x", name: "require", kind: "calls", file: "src/Late.java", line: 3 }], exports: { [HEAD]: SHOP_EXPORT } });
  const answer = importersFact(await importers({ files: ["src/Order.java"] }));
  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "unresolved-link", at: ["src/Late.java", "src/Late.java:3 require"], reason: "dynamic-load", reach: { kind: "anything", runtime: "java" } }]);
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
  const { callers } = setup({ nodes: SOURCE_NODES, exports: listingOf(["src/A.java", "README.md"]) });

  const outside = callersFact(await callers({ targets: [{ file: "src/A.java", symbol: "f" }], scope: { include: ["lib/"] } }));
  const noExtractor = callersFact(await callers({ targets: [{ file: "README.md", start: 1, end: 2 }], scope: { exclude: ["gen/"] } }));

  assert.equal(outside.status === "unknown" && outside.reason, "out-of-scope");
  assert.deepEqual(noExtractor.status === "partial" && noExtractor.cuts, [{ kind: "no-extractor", at: ["README.md"], reason: "not-source", reach: { kind: "anything" } }]);
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

test("a request for the configuration the export read outside the include is still out of scope", async () => {
  const manifest = "package.json";
  const exports = { [HEAD]: { files: [...SHOP_EXPORT.files, { path: manifest, blob: manifest, written: true }], skipped: [] } satisfies CommitExport };
  const { log, importers } = setup({ nodes: SHOP_NODES, exports });

  const answer = importersFact(await importers({ files: [manifest], scope: { include: ["src/"] } }));

  assert.equal(answer.status, "unknown");
  assert.equal(answer.status === "unknown" && answer.reason, "out-of-scope");
  assert.deepEqual(log.plans[0]?.wanted, [...SHOP_EXPORT.files.map((file) => file.path), manifest]);
});

test("an impact answer reads the configuration that interprets the change, even when the include leaves it out", async () => {
  const manifest = "package.json";
  const head: CommitExport = { files: [{ path: "src/A.java", blob: "1", written: true }, { path: manifest, blob: "2", written: true }], skipped: [] };
  const { log, ask } = setup({ changes: CHANGES, exports: { [HEAD]: head, [FORK]: head } });

  await ask({ scope: { include: ["src/"] } });

  assert.deepEqual(log.plans.map((plan) => plan.wanted), [
    ["src/A.java", manifest],
    ["src/A.java", manifest],
  ]);
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

test("a live callers query reads the store the mirror holds, records where it came from, and cuts nothing for a file the mirror holds outside what the export staged", async () => {
  const live = fakeLive({ "src/A.java": "1", "src/B.java": "1" });
  live.engine.build = { ok: true, value: { ...SUMMARY, filesNotIndexed: ["src/Odd.java"] } };
  const { log, queries } = setup({ trust: TRUSTED, live, nodes: LIVE_NODES, edges: SOURCE_EDGES });

  const answer = callersFact(await queries.callers({ ...LIVE_BASE, targets: [{ file: "src/A.java", symbol: "f" }], live: true }));

  assert.equal(answer.status, "complete");
  assert.deepEqual(answer.status === "complete" && answer.value.symbols.map((symbol) => symbol.symbol), ["f", "g"]);
  assert.deepEqual(answer.snapshot, { repo: "repo", kind: "live", head: HEAD, stateId: answer.inputs.content });
  assert.deepEqual(answer.inputs.origin, { kind: "full" });
  assert.deepEqual(answer.inputs.declaredScope.ignored, "git");
  assert.equal(log.indexed, 0);
  assert.equal(log.closed, 1);
  assert.deepEqual(live.held, { locks: 1, released: 1 });
});

test("a live callers query cuts a file the mirror and the export hold but the store does not", async () => {
  const live = fakeLive({ "src/A.java": "1", "src/B.java": "1", "src/Odd.java": "1" });
  live.engine.build = { ok: true, value: { ...SUMMARY, filesNotIndexed: ["src/Odd.java"] } };
  const { queries } = setup({ trust: TRUSTED, live, nodes: LIVE_NODES, edges: SOURCE_EDGES });

  const answer = callersFact(await queries.callers({ ...LIVE_BASE, targets: [{ file: "src/A.java", symbol: "f" }], live: true }));

  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "no-extractor", at: ["src/Odd.java"], reason: "not-indexed", reach: { kind: "anything", runtime: "java" } }]);
});

test("a live importers query cuts nothing for a file the mirror holds outside what the export staged", async () => {
  const live = fakeLive({ "src/Order.java": "1" });
  live.engine.build = { ok: true, value: { ...SUMMARY, filesNotIndexed: ["src/Odd.java"] } };
  const { queries } = setup({ trust: TRUSTED, live, nodes: SHOP_NODES });

  const answer = importersFact(await queries.importers({ ...LIVE_BASE, files: ["src/Order.java"], live: true }));

  assert.equal(answer.status, "complete");
});

test("a live importers query cuts a file the mirror and the export hold but the store does not", async () => {
  const live = fakeLive({ "src/Order.java": "1", "src/Odd.java": "1" });
  live.engine.build = { ok: true, value: { ...SUMMARY, filesNotIndexed: ["src/Odd.java"] } };
  const { queries } = setup({ trust: TRUSTED, live, nodes: SHOP_NODES });

  const answer = importersFact(await queries.importers({ ...LIVE_BASE, files: ["src/Order.java"], live: true }));

  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "no-extractor", at: ["src/Odd.java"], reason: "not-indexed", reach: { kind: "anything", runtime: "java" } }]);
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
  const { callers } = setup({ nodes: SOURCE_NODES, edges: SOURCE_EDGES, exports: listingOf(["src/A.java", "src/B.java"]) });
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

test("certified module coverage does not add legacy dynamic load cuts", async () => {
  const path = "src/index.ts";
  const { ask } = setup({
    changes: { ok: true, value: [change(path)] },
    exports: { [HEAD]: { files: [{ path, blob: "head", written: true }], skipped: [] }, [FORK]: { files: [{ path, blob: "base", written: true }], skipped: [] } },
    snapshotSources: { [HEAD]: [{ path, content: "new" }], [FORK]: [{ path, content: "old" }] },
    loads: [{ file: path, line: 1 }],
    moduleDependencies: { extract: async (sources) => ({ files: sources.map((source) => ({ file: source.path, statements: [source.content], moduleOnly: true })), dependencies: [], unread: [], untraversed: [] }) },
  });
  const answer = fact(await ask());
  assert.equal(answer.status, "complete");
});

test("JSON changes are staged and contribute to the content fingerprint", async () => {
  const path = "src/data.json";
  const make = (blob: string) => setup({
    changes: { ok: true, value: [change(path)] },
    exports: { [HEAD]: { files: [{ path, blob, written: true }], skipped: [] }, [FORK]: { files: [{ path, blob: "base", written: true }], skipped: [] } },
    moduleDependencies: { extract: async () => ({ files: [], dependencies: [], unread: [], untraversed: [] }) },
  });
  const a = make("one");
  const b = make("two");
  const first = fact(await a.ask());
  const second = fact(await b.ask());
  assert.ok(a.log.plans.every((plan) => plan.wanted.includes(path)));
  assert.notEqual(first.inputs.content, second.inputs.content);
});

test("local callback proof excludes only its own removed-declaration occurrence and creates no edge", async () => {
  const source = "src/promise.ts";
  const removed = change("src/address.ts", { deleted: true, added: [], removedNames: ["resolve"] });
  const unresolved = [
    { from: "use", file: source, line: 2, column: 20, name: "resolve", kind: "calls" },
    { from: "use", file: source, line: 2, column: 40, name: "resolve", kind: "calls" },
  ];
  const common: Options = { changes: { ok: true, value: [removed] }, nodes: [fakeNode("use", "function", source, 1, 3)], unresolved,
    exports: { [HEAD]: { files: [{ path: source, blob: "1", written: true }], skipped: [] } },
    importOrigins: origins((site) => site.column === 21 ? { kind: "local-parameter", name: "resolve" } : undefined) };
  const answer = fact(await setup(common).ask());
  assert.ok(answer.status === "partial");
  assert.deepEqual(answer.cuts, [{ kind: "unresolved-link", at: ["src/address.ts::resolve", "src/promise.ts:2"], reason: "removed-declaration", reach: { kind: "callers-of", declarations: ["src/address.ts::resolve"] } }]);
  assert.deepEqual(answer.value.symbols, []);
  const onlyLocal = fact(await setup({ ...common, unresolved: [unresolved[0]!] }).ask());
  assert.equal(onlyLocal.status, "complete");
  assert.deepEqual(onlyLocal.value.symbols, []);
});

test("a bare call the import reader places on this, inside the class that declares the member, is its caller and no cut", async () => {
  const file = "src/svc.ts";
  const unresolved = [{ from: "load", file, line: 3, column: 22, name: "fetch", kind: "calls" }];
  const common: Options = {
    nodes: [fakeNode("Svc", "class", file, 1, 9), fakeNode("fetch", "method", file, 2, 2), fakeNode("load", "method", file, 3, 3)],
    edges: [{ from: "Svc", to: "fetch", kind: "contains" }, { from: "Svc", to: "load", kind: "contains" }],
    unresolved,
    exports: { [HEAD]: { files: [{ path: file, blob: "1", written: true }], skipped: [] } },
  };
  const ask = async (reader: ImportOriginsReader) => callersFact(await setup({ ...common, importOrigins: reader }).callers({ targets: [{ file, symbol: "fetch" }] }));
  const proven = await ask(origins((site) => (site.column === 23 ? { kind: "this-member", name: "fetch" } : undefined)));
  assert.equal(proven.status, "complete");
  assert.deepEqual(proven.status === "complete" && proven.value.symbols.find((symbol) => symbol.symbol === "load")?.via, { file, symbol: "fetch", lines: [3], basis: "call", derivation: "proven" });
  const unproven = await ask(origins(() => undefined));
  assert.equal(unproven.status, "partial");
  assert.equal(unproven.status === "partial" && unproven.value.symbols.some((symbol) => symbol.symbol === "load"), false);
});

test("cancellation during origin batch stops before the walk", async () => {
  const controller = new AbortController();
  const source = "src/use.ts";
  const reader: ImportOriginsReader = () => ({ origins: async () => { controller.abort(); return []; }, rootOrigins: NO_ROOTS, replacedRoots: async () => NOTHING_REPLACED, rootBindings: NO_BINDINGS, declaredTypes: NO_DECLARED_TYPES, dispatchTargets: NO_DISPATCH_TARGETS, receiverMethods: NO_RECEIVER_METHODS });
  const result = await setup({ signal: controller.signal, changes: { ok: true, value: [change("src/target.ts")] }, nodes: [fakeNode("target", "function", "src/target.ts", 1)], unresolved: [{ from: "use", file: source, line: 1, column: 0, name: "target", kind: "calls" }], exports: { [HEAD]: { files: [source, "src/target.ts"].map((path) => ({ path, blob: path, written: true })), skipped: [] } }, importOrigins: reader }).ask();
  assert.ok(!result.ok && result.fault.kind === "aborted");
});

test("field settlement does not hide a same-line unverified use", async () => {
  const target = "src/svc.ts", source = "src/cmp.ts";
  const refs = [0, 12].map((column) => ({ from: "caller", file: source, line: 2, column, name: "this.svc.hit", kind: "calls" }));
  const validateFirst: ImportOriginsReader = () => ({ origins: async (sites) => sites.map((site) => ({ status: "unknown" as const, reason: "unresolved" as const, evidence: [], ...(site.column === 1 ? { occurrence: true as const } : {}) })), rootOrigins: NO_ROOTS, replacedRoots: async () => NOTHING_REPLACED, rootBindings: NO_BINDINGS, declaredTypes: NO_DECLARED_TYPES, dispatchTargets: NO_DISPATCH_TARGETS, receiverMethods: NO_RECEIVER_METHODS });
  const answer = fact(await setup({ changes: { ok: true, value: [change(target, { added: [{ start: 3, end: 3 }] })] }, nodes: [fakeNode("Svc", "class", target, 1, 5), fakeNode("hit", "method", target, 3, 3), fakeNode("Cmp", "class", source, 1, 5), fakeNode("caller", "method", source, 2, 2)], edges: [{ from: "Svc", to: "hit", kind: "contains" }, { from: "Cmp", to: "caller", kind: "contains" }], unresolved: refs, fields: [{ owner: { path: source, symbol: "Cmp", line: 1 }, field: "svc", holds: { class: { path: target, symbol: "Svc", line: 1 } } }], exports: { [HEAD]: { files: [target, source].map((path) => ({ path, blob: path, written: true })), skipped: [] } }, sources: [target, source].map((path) => ({ path, content: "" })), importOrigins: validateFirst, syntax: true }).ask());
  assert.ok(answer.status === "partial");
  assert.ok(answer.value.symbols.some((symbol) => symbol.symbol === "caller"));
  assert.ok(answer.cuts.some((cut) => cut.at.includes("src/cmp.ts:2 this.svc.hit")));
});

test("member proof context gates exact contrary-target exclusions without reaching the actual caller", async () => {
  const free = "src/free.ts", store = "src/store.ts", owner = "src/owner.ts";
  const sources = [free, store, owner].map((path) => ({ path, content: "" }));
  const exported = { files: sources.map(({ path }) => ({ path, blob: "1", written: true })), skipped: [] };
  const proof = { owner: { path: owner, symbol: "Owner", line: 1 }, receiver: { path: store, symbol: "Store", line: 1 }, member: { path: store, symbol: "write", line: 3 }, reference: { file: owner, line: 7, column: 1, symbol: "write", name: "this.store.write", kind: "calls" as const } };
  const contexts: boolean[] = [];
  const make = (overrides: Partial<Options> = {}) => setup({
    sources, exports: { [HEAD]: exported },
    nodes: [fakeNode("free", "function", free, 1, 3, "write"), fakeNode("Store", "class", store, 1, 10), fakeNode("member", "method", store, 3, 4, "write"), fakeNode("Owner", "class", owner, 1, 20), fakeNode("caller", "method", owner, 5, 9)],
    edges: [{ from: "Store", to: "member", kind: "contains" }, { from: "Owner", to: "caller", kind: "contains" }],
    unresolved: [{ from: "caller", file: owner, line: 7, column: 0, name: "this.store.write", kind: "calls" }],
    importOrigins: origins(() => undefined),
    relationReader: { language: TYPESCRIPT_PROFILE, extract: async (_sources, options) => {
      contexts.push(options?.memberProofs?.completeSource === true);
      return { relations: [], fields: [], locals: [], memberUses: options?.memberProofs?.completeSource ? [proof] : [] };
    } },
    ...overrides,
  });
  const { callers } = make();
  const answer = callersFact(await callers({ targets: [{ file: free, symbol: "write" }] }));
  assert.equal(answer.status, "complete");
  assert.deepEqual(answer.value.symbols.map(({ file, symbol }) => [file, symbol]), [[free, "write"]]);
  const scoped = callersFact(await callers({ targets: [{ file: free, symbol: "write" }], scope: { include: ["src/**"] } }));
  assert.equal(scoped.status, "partial");
  assert.deepEqual(contexts, [true, false]);
  const incomplete: Options[] = [
    { exports: { [HEAD]: { ...exported, skipped: [{ path: "elsewhere", reason: "symlink" }] } } },
    { exports: { [HEAD]: { ...exported, stopped: { at: "z.ts", limit: 0 } } } },
    { exports: { [HEAD]: { ...exported, files: exported.files.map((file) => file.path === store ? { ...file, written: false } : file) } } },
    { sources: sources.filter(({ path }) => path !== store) },
  ];
  for (const options of incomplete) {
    const partial = callersFact(await make(options).callers({ targets: [{ file: free, symbol: "write" }] }));
    assert.equal(partial.status, "partial");
    assert.equal(contexts.at(-1), false);
  }
});


test("cancellation after member metadata stops the query and closes the graph", async () => {
  const controller = new AbortController();
  const { callers, log } = setup({
    signal: controller.signal,
    nodes: [fakeNode("f", "function", "src/A.java", 1, 3)],
    relationReader: { language: TYPESCRIPT_PROFILE, extract: async () => { controller.abort(); return { relations: [], fields: [], locals: [], memberUses: [] }; } },
  });
  const result = await callers({ targets: [{ file: "src/A.java", symbol: "f" }] });
  assert.ok(!result.ok && result.fault.kind === "aborted");
  assert.equal(log.closed, 1);
});
for (const live of [false, true]) {
  test(`a ${live ? "live" : "revisioned"} importers query loads dynamic sources without extracting entrypoints`, async () => {
    const mirror = live ? fakeLive({ "src/A.java": "1" }) : undefined;
    const { queries, log } = setup({ ...(mirror && { live: mirror, trust: TRUSTED }), loads: [{ file: "src/B.java", line: 9, specifier: "./A" }] });
    const answer = await queries.importers({ repo: "/repo", repoId: "repo", files: ["src/A.java"], ...(live ? { live: true } : { revision: "HEAD" }) });
    assert.ok(answer.ok);
    assert.equal(log.reads, 1);
    assert.equal(log.extractions, 0);
    assert.equal(log.closed, 1);
    if (mirror) assert.deepEqual(mirror.held, { locks: 1, released: 1 });
  });
}


test("change query uses declaration evidence only for removed candidates without changing seeds", async () => {
  const path = "src/a.ts";
  const changes = { ok: true, value: [change(path, { removedNames: ["effect", "save"], added: [] })] } as const;
  const unresolved = ["effect", "save"].map((name, index) => ({ from: "use", name, kind: "calls", file: "src/use.ts", line: index + 1 }));
  const setupOptions = { changes, unresolved, exports: { [HEAD]: { files: [{ path: "src/use.ts", blob: "1", written: true }], skipped: [] } }, nodes: [fakeNode("use", "function", "src/use.ts", 1, 3)], snapshotSources: { [FORK]: [{ path, content: "before" }], [HEAD]: [{ path, content: "after" }] } };
  const baseline = fact(await setup(setupOptions).ask());
  const answer = fact(await setup({ ...setupOptions, declarationEvidence: { validate: (input) => {
    assert.deepEqual(input, { path, base: "before", head: "after", deleted: false, names: ["effect", "save"] });
    return ["save", "not-a-candidate"];
  } } }).ask());
  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "unresolved-link", at: ["src/a.ts::save", "src/use.ts:2"], reason: "removed-declaration", reach: { kind: "callers-of", declarations: ["src/a.ts::save"] } }]);
  assert.equal(baseline.status === "partial" && baseline.cuts.length, 2);
  assert.notEqual(answer.status, "unknown");
  assert.notEqual(baseline.status, "unknown");
  if (answer.status !== "unknown" && baseline.status !== "unknown") assert.deepEqual(answer.value, baseline.value);
});


test("cancellation during declaration validation stops the query and closes the graph", async () => {
  const controller = new AbortController();
  const query = setup({
    changes: { ok: true, value: [change("src/a.ts", { removedNames: ["save"] })] },
    signal: controller.signal,
    declarationEvidence: { validate: ({ names }) => { controller.abort(); return names; } },
  });
  const answer = await query.ask();
  assert.equal(answer.ok, false);
  if (!answer.ok) assert.equal(answer.fault.kind, "aborted");
  assert.equal(query.log.closed, 1);
});

test("multiple change records for one path are validated together once", async () => {
  let calls = 0;
  const query = setup({
    changes: { ok: true, value: [change("src/a.ts", { removedNames: ["first"] }), change("src/a.ts", { removedNames: ["second"] })] },
    declarationEvidence: { validate: ({ names }) => { calls++; assert.deepEqual(names, ["first", "second"]); return names; } },
  });
  await query.ask();
  assert.equal(calls, 1);
});

test("a live callers query cancelled during its postlude returns an aborted fault", async () => {
  const live = fakeLive({ "src/A.java": "1" });
  const controller = new AbortController();
  const usage = live.deps.mirror.usage;
  live.deps.mirror.usage = async (...args) => { const result = await usage(...args); controller.abort(); return result; };
  const { queries } = setup({ trust: TRUSTED, live, nodes: LIVE_NODES });
  const result = await queries.callers({ ...LIVE_BASE, targets: [{ file: "src/A.java", symbol: "f" }], live: true, signal: controller.signal });
  assert.equal(!result.ok && result.fault.kind, "aborted");
  assert.equal(live.held.locks, live.held.released);
});

test("public via follows the confidence witness while shortest depth remains independent", async () => {
  const nodes = [fakeNode("seed", "function", "src/A.java", 1), fakeNode("mid", "function", "src/B.java", 2), fakeNode("target", "function", "src/C.java", 3)];
  const edges = [
    { from: "target", to: "seed", kind: "calls", confidence: 0.2, line: 3 },
    { from: "mid", to: "seed", kind: "calls", confidence: 0.9, line: 2 },
    { from: "target", to: "mid", kind: "references", confidence: 0.8, line: 3 },
  ];
  const answer = callersFact(await setup({ nodes, edges }).callers({ targets: [{ file: "src/A.java", symbol: "seed" }] }));
  assert.equal(answer.status, "complete");
  if (answer.status !== "complete") return;
  const reached = answer.value.symbols.find((symbol) => symbol.symbol === "target");
  assert.equal(reached?.depth, 1);
  assert.equal(reached?.confidence, 0.8);
  assert.deepEqual(reached?.via, { file: "src/B.java", symbol: "mid", lines: [3], basis: "reference", derivation: "resolved" });
});

test("public strongest reference keeps its locations and the observed call still counts", async () => {
  const nodes = [fakeNode("seed", "function", "src/A.java", 1), fakeNode("caller", "function", "src/B.java", 2, 8)];
  const edges = [
    { from: "caller", to: "seed", kind: "calls", confidence: 0.2, line: 3 },
    { from: "caller", to: "seed", kind: "references", confidence: 0.9, line: 5 },
  ];
  const answer = callersFact(await setup({ nodes, edges }).callers({ targets: [{ file: "src/A.java", symbol: "seed" }] }));
  assert.equal(answer.status, "complete");
  if (answer.status !== "complete") return;
  assert.equal(answer.value.symbols.find((symbol) => symbol.symbol === "seed")?.fanIn, 1);
  const reached = answer.value.symbols.find((symbol) => symbol.symbol === "caller");
  assert.equal(reached?.confidence, 0.9);
  assert.deepEqual(reached?.via, { file: "src/A.java", symbol: "seed", lines: [5], basis: "reference", derivation: "resolved" });
});

const RECORDS = {
  nodes: [fakeNode("origin", "function", "src/Point.java", 4, 6, "origin"), fakeNode("width", "function", "src/Size.java", 2, 2, "width")],
  sources: [{ path: "src/Point.java", content: "" }, { path: "src/Size.java", content: "" }],
  unmodelled: ["src/Point.java", "src/Size.java"],
};

test("a changed file whose declarations the graph cannot place keeps its seeds and cuts the answer there, and an unchanged one is not cut", async () => {
  const answer = fact(await setup({ ...RECORDS, changes: { ok: true, value: [change("src/Point.java", { added: [{ start: 5, end: 5 }] })] } }).ask());

  assert.deepEqual(answer.status === "partial" && answer.value.seeds.map((seed) => seed.symbol), ["origin"]);
  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "no-extractor", at: ["src/Point.java"], reason: "unmodelled", reach: { kind: "anything", runtime: "java" } }]);
});

test("callers of a symbol in a file the graph cannot place cut the answer at that file", async () => {
  const answer = callersFact(await setup(RECORDS).callers({ targets: [{ file: "src/Point.java", symbol: "origin" }] }));

  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "no-extractor", at: ["src/Point.java"], reason: "unmodelled", reach: { kind: "anything", runtime: "java" } }]);
});

test("importers cut each file's unresolved module statements once, anchored at the file with its places after it", async () => {
  const unresolved = (file: string, line: number, specifier: string): ModuleDependency => ({ file, line, endLine: line, specifier, kind: "import", typeOnly: false, target: { kind: "unresolved", reason: "not found" }, bindings: [] });
  const moduleDependencies: ModuleDependenciesReader = {
    extract: async () => ({ files: [], dependencies: [unresolved("src/b.ts", 9, "geojson"), unresolved("src/a.ts", 4, "@/env"), unresolved("src/b.ts", 2, "@/env")], unread: [] }),
  };
  const { importers } = setup({ nodes: SHOP_NODES, exports: { [HEAD]: SHOP_EXPORT }, moduleDependencies });

  const answer = importersFact(await importers({ files: ["src/c.ts"] }));

  assert.deepEqual(answer.status === "partial" && answer.cuts.filter((cut) => cut.kind === "unresolved-link"), [
    { kind: "unresolved-link", at: ["src/a.ts", "src/a.ts:4 @/env"], reason: "specifier", reach: { kind: "module", importer: "src/a.ts", specifiers: [{ specifier: "@/env" }] } },
    { kind: "unresolved-link", at: ["src/b.ts", "src/b.ts:2 @/env", "src/b.ts:9 geojson"], reason: "specifier", reach: { kind: "module", importer: "src/b.ts", specifiers: [{ specifier: "@/env" }, { specifier: "geojson" }] } },
  ]);
});

test("a callers target that names no declaration faults before the relations reader reads the snapshot", async () => {
  let reads = 0;
  const relationReader: ImpactQueriesDeps["relations"] = { language: TYPESCRIPT_PROFILE, extract: async () => { reads++; return { relations: [], fields: [], locals: [] }; } };

  const answer = await setup({ ...TWO_CLASSES, relationReader }).callers({ targets: [{ file: "src/A.ts", symbol: "gone" }] });

  assert.equal(!answer.ok && answer.fault.kind, "unknown-symbol");
  assert.equal(reads, 0);
});

/** A reader whose roots are external at the edge lines in `outside`, repository at those in `inside`, and unknown elsewhere. */
function rootsAtLines(outside: readonly number[], inside: readonly number[] = []): ImportOriginsReader {
  return origins(() => undefined, (site) => (outside.includes(site.line) ? { kind: "external", module: "typescript" } : inside.includes(site.line) ? { kind: "repository", file: "src/model.ts" } : undefined));
}

const MODEL = [fakeNode("Expression", "interface", "src/model.ts", 1, 3), fakeNode("show", "function", "src/show.ts", 10, 12), fakeNode("top", "function", "src/top.ts", 20, 22), fakeNode("real", "function", "src/real.ts", 30, 32)];
const MODEL_EDGES: FakeEdge[] = [
  { from: "show", to: "Expression", kind: "references", line: 10, column: 30, confidence: 0.9 },
  { from: "top", to: "show", kind: "calls", line: 21, column: 2, confidence: 0.9 },
  { from: "real", to: "Expression", kind: "references", line: 30, column: 20, confidence: 0.9 },
];
const reachedNames = (answer: Fact<ImpactValue>): string[] => (answer.status === "unknown" ? [] : answer.value.symbols.map((symbol) => symbol.symbol));

test("a name the graph resolved whose root is bound outside the repository is no caller, nor are the callers it alone reaches", async () => {
  const answer = callersFact(await setup({ nodes: MODEL, edges: MODEL_EDGES, importOrigins: rootsAtLines([10], [30]) }).callers({ targets: [{ file: "src/model.ts", symbol: "Expression" }] }));

  assert.equal(answer.status, "complete");
  assert.deepEqual(reachedNames(answer), ["Expression", "real"]);
});

test("a change answers without the dependents a name rooted outside the repository would add", async () => {
  const answer = fact(await setup({ nodes: MODEL, edges: MODEL_EDGES, changes: { ok: true, value: [change("src/model.ts")] }, importOrigins: rootsAtLines([10], [30]) }).ask());

  assert.deepEqual(reachedNames(answer), ["Expression", "real"]);
});

test("a file whose own top-level use of a declaration is rooted outside the repository does not reach its top-level code", async () => {
  const nodes = [MODEL[0]!, fakeNode("use.ts", "file", "src/use.ts", 1, 9), fakeNode("main", "function", "src/use.ts", 2, 4)];
  const edges: FakeEdge[] = [{ from: "use.ts", to: "Expression", kind: "references", line: 6, column: 4, confidence: 0.8 }];

  const kept = callersFact(await setup({ nodes, edges, importOrigins: rootsAtLines([]) }).callers({ targets: [{ file: "src/model.ts", symbol: "Expression" }] }));
  const dropped = callersFact(await setup({ nodes, edges, importOrigins: rootsAtLines([6]) }).callers({ targets: [{ file: "src/model.ts", symbol: "Expression" }] }));

  assert.deepEqual(reachedNames(kept), ["Expression", "main"]);
  assert.deepEqual(reachedNames(dropped), ["Expression"]);
});

test("an edge the walk reads only once a dropped one frees a bound is checked as well", async () => {
  const nodes = [fakeNode("T", "function", "src/t.ts", 1, 2), fakeNode("X", "function", "src/x.ts", 10, 11), fakeNode("O", "function", "src/o.ts", 20, 21), fakeNode("P", "function", "src/p.ts", 30, 31), fakeNode("Q", "function", "src/q.ts", 40, 41)];
  const edges: FakeEdge[] = [
    { from: "X", to: "T", kind: "calls", line: 10, column: 2 },
    { from: "O", to: "X", kind: "calls", line: 20, column: 2 },
    { from: "P", to: "X", kind: "calls", line: 30, column: 2 },
    { from: "Q", to: "P", kind: "calls", line: 40, column: 2 },
  ];
  const answer = callersFact(await setup({ nodes, edges, importOrigins: rootsAtLines([20, 40]) }).callers({ targets: [{ file: "src/t.ts", symbol: "T" }], budget: { hubFanIn: 1 } }));

  assert.deepEqual(reachedNames(answer), ["T", "X", "P"]);
});

const RETAINED_BYTES = 1 << 20;

function relationsCounted(counter: { calls: number }, relations: Finding<Relation>[] = []): ImpactQueriesDeps["relations"] {
  return { language: TYPESCRIPT_PROFILE, extract: async () => { counter.calls++; return { relations, fields: [], locals: [] }; } };
}

test("a second callers request at the same snapshot and inputs reads the relations once and answers what a miss answers", async () => {
  const snapshotCache = createSnapshotDataCache(RETAINED_BYTES);
  const counter = { calls: 0 };
  const targets = { targets: [{ file: "src/A.java", symbol: "f" }] };
  const shared = { nodes: SOURCE_NODES, edges: SOURCE_EDGES, snapshotCache, relationReader: relationsCounted(counter) };
  const miss = callersFact(await setup(shared).callers(targets));
  const hit = callersFact(await setup(shared).callers(targets));
  assert.equal(counter.calls, 1);
  assert.deepEqual(hit, miss);
  const uncached = callersFact(await setup({ nodes: SOURCE_NODES, edges: SOURCE_EDGES, relationReader: relationsCounted({ calls: 0 }) }).callers(targets));
  assert.equal(canonicalJson(hit), canonicalJson(uncached));
});

test("each input the relations depend on, scope, written sources and the listing's unwritten and skipped entries, gets its own retained output, and a revision with the same listing shares it", async () => {
  const snapshotCache = createSnapshotDataCache(RETAINED_BYTES);
  const counter = { calls: 0 };
  const targets = { targets: [{ file: "src/A.java", symbol: "f" }] };
  const base = { nodes: SOURCE_NODES, edges: SOURCE_EDGES, snapshotCache, relationReader: relationsCounted(counter) };
  const listed = (blob: string, skipped: CommitExport["skipped"] = []): CommitExport => ({ files: [{ path: "src/A.java", blob, written: true }], skipped });
  await setup(base).callers(targets);
  assert.equal(counter.calls, 1);
  await setup(base).callers({ ...targets, scope: { exclude: ["docs/**"] } });
  assert.equal(counter.calls, 2);
  await setup({ ...base, exports: { [HEAD]: listed("1", [{ path: "src/link.ts", reason: "symlink" }]) } }).callers(targets);
  assert.equal(counter.calls, 3);
  await setup({ ...base, exports: { [HEAD]: listed("2") } }).callers(targets);
  assert.equal(counter.calls, 4);
  await setup(base).callers({ ...targets, revision: "other" });
  assert.equal(counter.calls, 4);
  await setup({ ...base, exports: { [HEAD]: listed("2") } }).callers(targets);
  assert.equal(counter.calls, 4);
});

test("a cancelled relations extraction publishes no output", async () => {
  const snapshotCache = createSnapshotDataCache(RETAINED_BYTES);
  const counter = { calls: 0 };
  const controller = new AbortController();
  const targets = { targets: [{ file: "src/A.java", symbol: "f" }] };
  const cancelling: ImpactQueriesDeps["relations"] = { language: TYPESCRIPT_PROFILE, extract: async () => { counter.calls++; controller.abort(); return { relations: [], fields: [], locals: [] }; } };
  const base = { nodes: SOURCE_NODES, edges: SOURCE_EDGES, snapshotCache };
  const cancelled = await setup({ ...base, relationReader: cancelling, signal: controller.signal }).callers(targets);
  assert.ok(!cancelled.ok && cancelled.fault.kind === "aborted");
  assert.equal(counter.calls, 1);
  assert.ok((await setup({ ...base, relationReader: relationsCounted(counter) }).callers(targets)).ok);
  assert.equal(counter.calls, 2);
  assert.ok((await setup({ ...base, relationReader: relationsCounted(counter) }).callers(targets)).ok);
  assert.equal(counter.calls, 2);
});

test("a retained output larger than the whole budget is skipped and the answer is unchanged", async () => {
  const counter = { calls: 0 };
  const targets = { targets: [{ file: "src/A.java", symbol: "f" }] };
  const shared = { nodes: SOURCE_NODES, edges: SOURCE_EDGES, relationReader: relationsCounted(counter) };
  const retained = callersFact(await setup({ ...shared, snapshotCache: createSnapshotDataCache(RETAINED_BYTES) }).callers(targets));
  const tinyCache = createSnapshotDataCache(8);
  const skipped = callersFact(await setup({ ...shared, snapshotCache: tinyCache }).callers(targets));
  await setup({ ...shared, snapshotCache: tinyCache }).callers(targets);
  assert.equal(counter.calls, 3);
  assert.deepEqual(skipped, retained);
});

function liveRun(live: FakeLive, snapshotCache: SnapshotDataCache, options: Partial<Parameters<typeof setup>[0]> = {}) {
  return setup({ trust: TRUSTED, live, nodes: LIVE_NODES, edges: SOURCE_EDGES, snapshotCache, ...options });
}

const LIVE_CALLERS = { ...LIVE_BASE, targets: [{ file: "src/A.java", symbol: "f" }], live: true } as const;

test("a live callers query over an unchanged capture reads sources and relations once, an edit misses, and a hit answers what a miss answers", async () => {
  const live = fakeLive({ "src/A.java": "1", "src/B.java": "1" });
  const snapshotCache = createSnapshotDataCache(RETAINED_BYTES);
  const counter = { calls: 0 };
  const run = () => liveRun(live, snapshotCache, { relationReader: relationsCounted(counter) });

  const first = run();
  const miss = callersFact(await first.queries.callers(LIVE_CALLERS));
  const second = run();
  const hit = callersFact(await second.queries.callers(LIVE_CALLERS));
  assert.deepEqual([counter.calls, first.log.reads, second.log.reads], [1, 1, 0]);
  assert.equal(canonicalJson(hit), canonicalJson(miss));
  const uncached = callersFact(await setup({ trust: TRUSTED, live, nodes: LIVE_NODES, edges: SOURCE_EDGES, relationReader: relationsCounted({ calls: 0 }) }).queries.callers(LIVE_CALLERS));
  assert.equal(canonicalJson(hit), canonicalJson(uncached));

  live.tree.set("src/A.java", "2");
  const third = run();
  const edited = callersFact(await third.queries.callers(LIVE_CALLERS));
  assert.deepEqual([counter.calls, third.log.reads], [2, 1]);
  assert.notEqual(edited.snapshot.kind === "live" && edited.snapshot.stateId, hit.snapshot.kind === "live" && hit.snapshot.stateId);
  const fourth = run();
  assert.ok((await fourth.queries.callers(LIVE_CALLERS)).ok);
  assert.deepEqual([counter.calls, fourth.log.reads], [2, 0]);
});

test("a live query answered from retained data still reports the paths that changed while it ran", async () => {
  const live = fakeLive({ "src/A.java": "1", "src/B.java": "1" });
  const snapshotCache = createSnapshotDataCache(RETAINED_BYTES);
  const counter = { calls: 0 };
  const run = () => liveRun(live, snapshotCache, { relationReader: relationsCounted(counter) });
  assert.ok((await run().queries.callers(LIVE_CALLERS)).ok);

  const list = live.deps.workingTree.list;
  let listings = 0;
  live.deps.workingTree.list = async (...args) => {
    if (++listings === 2) live.tree.set("src/B.java", "edited during the query");
    return list(...args);
  };
  const notices: LiveStaleNotice[] = [];
  const stale = run();
  assert.ok((await stale.queries.callers({ ...LIVE_CALLERS, onStale: (notice) => notices.push(notice) })).ok);
  assert.deepEqual([counter.calls, stale.log.reads, listings], [1, 0, 2]);
  assert.deepEqual(notices.map((notice) => notice.changed), [["src/B.java"]]);

  const next = run();
  assert.ok((await next.queries.callers(LIVE_CALLERS)).ok);
  assert.deepEqual([counter.calls, next.log.reads], [2, 1]);
});

test("a live change query over an unchanged capture reads the head relations and module dependencies once, and the merge base's module dependencies once across head edits", async () => {
  const path = "src/index.ts";
  const live = fakeLive({ [path]: "2", "src/A.java": "2" });
  const snapshotCache = createSnapshotDataCache(RETAINED_BYTES);
  const counter = { calls: 0 };
  const modules = { calls: 0 };
  const moduleDependencies: ModuleDependenciesReader = { extract: async () => { modules.calls++; return { files: [], dependencies: [], unread: [] }; } };
  const run = () => liveRun(live, snapshotCache, {
    relationReader: relationsCounted(counter),
    moduleDependencies,
    directoryChanges: { ok: true, value: [change(path), change("src/A.java")] },
    exports: { [FORK]: { files: [{ path, blob: "1", written: true }, { path: "src/A.java", blob: "1", written: true }], skipped: [] } },
  });
  const ask = () => run().queries.ofChange({ ...LIVE_BASE, base: "base", live: true });

  const miss = fact(await ask());
  const missed = { relations: counter.calls, modules: modules.calls };
  assert.ok(missed.relations >= 1 && missed.modules >= 1);
  const hit = fact(await ask());
  assert.equal(canonicalJson(hit), canonicalJson(miss));
  assert.equal(counter.calls - missed.relations, 0);
  assert.equal(modules.calls - missed.modules, 0);

  live.tree.set(path, "9");
  const before = { relations: counter.calls, modules: modules.calls };
  assert.ok((await ask()).ok);
  assert.deepEqual([counter.calls - before.relations, modules.calls - before.modules], [missed.relations, missed.modules - 1]);
});

test("a live change query reads and extracts the merge base once, misses on another merge base or scope, keeps hitting it when the live head changes, and answers the same as uncached", async () => {
  const live = fakeLive({ "src/A.java": "1" });
  const snapshotCache = createSnapshotDataCache(RETAINED_BYTES);
  const run = (options: Partial<Parameters<typeof setup>[0]> = {}) => liveRun(live, snapshotCache, options);
  const ask = async (options: Partial<Parameters<typeof setup>[0]> = {}, overrides: { scope?: { exclude: string[] } } = {}) => {
    const current = run(options);
    const answer = fact(await current.queries.ofChange({ ...LIVE_BASE, base: "base", live: true, ...overrides }));
    return { answer, reads: current.log.reads, extractions: current.log.extractions };
  };

  const miss = await ask();
  assert.deepEqual([miss.reads, miss.extractions], [2, 2]);
  const hit = await ask();
  assert.deepEqual([hit.reads, hit.extractions], [0, 0]);
  assert.equal(canonicalJson(hit.answer), canonicalJson(miss.answer));
  const uncached = fact(await setup({ trust: TRUSTED, live, nodes: LIVE_NODES, edges: SOURCE_EDGES }).queries.ofChange({ ...LIVE_BASE, base: "base", live: true }));
  assert.equal(canonicalJson(hit.answer), canonicalJson(uncached));

  const otherFork = "d".repeat(40);
  const sameListing = await ask({ mergeBase: otherFork });
  assert.deepEqual([sameListing.reads, sameListing.extractions], [0, 0]);
  const moved = await ask({ mergeBase: otherFork, exports: { [otherFork]: { files: [{ path: "src/A.java", blob: "7", written: true }], skipped: [] } } });
  assert.deepEqual([moved.reads, moved.extractions], [1, 1]);
  const scoped = await ask({}, { scope: { exclude: ["docs/**"] } });
  assert.deepEqual([scoped.reads, scoped.extractions], [2, 2]);

  live.tree.set("src/A.java", "2");
  const edited = await ask();
  assert.deepEqual([edited.reads, edited.extractions], [1, 1]);
});

test("a merge base a live change query kept answers a change query between commits, and the other way round", async () => {
  const live = fakeLive({ "src/A.java": "1" });
  const snapshotCache = createSnapshotDataCache(RETAINED_BYTES);
  const liveAsk = liveRun(live, snapshotCache);
  assert.ok((await liveAsk.queries.ofChange({ ...LIVE_BASE, base: "base", live: true })).ok);
  const headListing = { [HEAD]: { files: [{ path: "src/A.java", blob: "2", written: true }], skipped: [] } };
  const sha = liveRun(live, snapshotCache, { exports: headListing });
  const between = fact(await sha.ask());
  assert.deepEqual([sha.log.reads, sha.log.extractions], [1, 1]);
  const fresh = fact(await setup({ trust: TRUSTED, nodes: LIVE_NODES, edges: SOURCE_EDGES, exports: headListing }).ask());
  assert.equal(canonicalJson(between), canonicalJson(fresh));
});

test("a live importers query, which reads sources only, reuses them for an unchanged capture", async () => {
  const live = fakeLive({ "src/A.java": "1", "src/B.java": "1" });
  const snapshotCache = createSnapshotDataCache(RETAINED_BYTES);
  const ask = () => { const run = liveRun(live, snapshotCache); return run.queries.importers({ ...LIVE_BASE, files: ["src/A.java"], live: true }).then((answer) => ({ answer, reads: run.log.reads })); };
  const miss = await ask();
  const hit = await ask();
  assert.ok(miss.answer.ok && hit.answer.ok);
  assert.deepEqual([miss.reads, hit.reads], [1, 0]);
  live.tree.set("src/B.java", "2");
  assert.equal((await ask()).reads, 1);
});

test("a cancelled live relations extraction publishes no output", async () => {
  const live = fakeLive({ "src/A.java": "1", "src/B.java": "1" });
  const snapshotCache = createSnapshotDataCache(RETAINED_BYTES);
  const counter = { calls: 0 };
  const controller = new AbortController();
  const cancelling: ImpactQueriesDeps["relations"] = { language: TYPESCRIPT_PROFILE, extract: async () => { counter.calls++; controller.abort(); return { relations: [], fields: [], locals: [] }; } };
  const cancelled = await liveRun(live, snapshotCache, { relationReader: cancelling, signal: controller.signal }).queries.callers({ ...LIVE_CALLERS, signal: controller.signal });
  assert.ok(!cancelled.ok && cancelled.fault.kind === "aborted");
  assert.ok((await liveRun(live, snapshotCache, { relationReader: relationsCounted(counter) }).queries.callers(LIVE_CALLERS)).ok);
  assert.equal(counter.calls, 2);
  assert.ok((await liveRun(live, snapshotCache, { relationReader: relationsCounted(counter) }).queries.callers(LIVE_CALLERS)).ok);
  assert.equal(counter.calls, 2);
});

test("a live callers query and a callers query at a revision over the same listing do not share retained output, and a scope keeps its own", async () => {
  const live = fakeLive({ "src/A.java": "1" });
  const snapshotCache = createSnapshotDataCache(RETAINED_BYTES);
  const counter = { calls: 0 };
  const shared = { relationReader: relationsCounted(counter), exports: { [HEAD]: { files: [{ path: "src/A.java", blob: "1", written: true }], skipped: [] } } };
  await liveRun(live, snapshotCache, shared).queries.callers(LIVE_CALLERS);
  await liveRun(live, snapshotCache, shared).callers({ revision: "head", targets: LIVE_CALLERS.targets });
  assert.equal(counter.calls, 2);
  await liveRun(live, snapshotCache, shared).queries.callers({ ...LIVE_CALLERS, scope: { exclude: ["docs/**"] } });
  assert.equal(counter.calls, 3);
});

const LAZY_TARGETS = { targets: [{ file: "src/A.java", symbol: "f" }] };

test("a kept index and retained snapshot data need no file written, and a snapshot that needs both writes once", async () => {
  const snapshotCache = createSnapshotDataCache(RETAINED_BYTES);
  const shared = { nodes: SOURCE_NODES, edges: SOURCE_EDGES, snapshotCache, cache: true as const, lazy: {} };
  const built = setup({ ...shared, buildIndex: true });
  const miss = callersFact(await built.callers(LAZY_TARGETS));
  const kept = setup(shared);
  const hit = callersFact(await kept.callers(LAZY_TARGETS));

  assert.deepEqual(built.log.listed, [HEAD]);
  assert.equal(built.log.materialized.length, 1);
  assert.deepEqual(kept.log.listed, [HEAD]);
  assert.deepEqual(kept.log.materialized, []);
  assert.deepEqual(hit, miss);
});

test("a snapshot written apart answers what one written while it was listed answers", async () => {
  const shared = { nodes: SOURCE_NODES, edges: SOURCE_EDGES, cache: true as const, buildIndex: true as const };
  const apart = callersFact(await setup({ ...shared, lazy: {} }).callers(LAZY_TARGETS));
  const together = callersFact(await setup(shared).callers(LAZY_TARGETS));

  assert.equal(canonicalJson(apart), canonicalJson(together));
});

test("a file that cannot be written is the fault of the source read, and of the index build that needs it, with its own kind", async () => {
  const lazy = { materialize: { kind: "export-write-failed", detail: "disk" } } as const;
  const sources = await setup({ nodes: SOURCE_NODES, edges: SOURCE_EDGES, lazy }).callers(LAZY_TARGETS);
  assert.ok(!sources.ok && sources.fault.kind === "export-write-failed");

  const snapshotCache = createSnapshotDataCache(RETAINED_BYTES);
  const shared = { nodes: SOURCE_NODES, edges: SOURCE_EDGES, snapshotCache, cache: true as const, buildIndex: true as const };
  callersFact(await setup({ ...shared, lazy: {} }).callers(LAZY_TARGETS));
  const build = await setup({ ...shared, lazy }).callers(LAZY_TARGETS);
  assert.ok(!build.ok && build.fault.kind === "export-write-failed");
});

test("a current listing fault wins over retained data and a kept index, and writes nothing", async () => {
  const snapshotCache = createSnapshotDataCache(RETAINED_BYTES);
  const shared = { nodes: SOURCE_NODES, edges: SOURCE_EDGES, snapshotCache, cache: true as const };
  callersFact(await setup({ ...shared, lazy: {} }).callers(LAZY_TARGETS));
  const faulty = setup({ ...shared, lazy: { list: { kind: "object-missing", detail: "gone" } } });
  const answer = await faulty.callers(LAZY_TARGETS);

  assert.ok(!answer.ok && answer.fault.kind === "object-missing");
  assert.deepEqual(faulty.log.materialized, []);
});

function modulesCounted(counter: { calls: number; options: unknown[] }): ModuleDependenciesReader {
  return { extract: async (sources, options) => { counter.calls++; counter.options.push(options); return { files: sources.map((source) => ({ file: source.path, statements: [source.content], moduleOnly: true })), dependencies: [], unread: [], untraversed: [] }; } };
}

test("a second importers request at the same snapshot reads the module dependencies once and answers what a miss answers", async () => {
  const snapshotCache = createSnapshotDataCache(RETAINED_BYTES);
  const counter = { calls: 0, options: [] as unknown[] };
  const files = { files: ["src/A.java"] };
  const shared = { nodes: SOURCE_NODES, edges: SOURCE_EDGES, snapshotCache, moduleDependencies: modulesCounted(counter) };
  const miss = await setup(shared).importers(files);
  const hit = await setup(shared).importers(files);
  assert.ok(miss.ok && hit.ok);
  assert.equal(counter.calls, 1);
  assert.deepEqual(hit, miss);
  const uncached = await setup({ nodes: SOURCE_NODES, edges: SOURCE_EDGES, moduleDependencies: modulesCounted({ calls: 0, options: [] }) }).importers(files);
  assert.equal(canonicalJson(hit), canonicalJson(uncached));
  await setup({ ...shared, exports: { [HEAD]: { files: [{ path: "src/A.java", blob: "2", written: true }], skipped: [] } } }).importers(files);
  assert.equal(counter.calls, 2);
});

test("an impact of change reads each snapshot's module dependencies once across requests", async () => {
  const snapshotCache = createSnapshotDataCache(RETAINED_BYTES);
  const counter = { calls: 0, options: [] as unknown[] };
  const shared = { snapshotCache, changes: { ok: true, value: [change("src/index.ts")] } as Result<readonly FileChange[], VcsFault>, moduleDependencies: modulesCounted(counter) };
  const miss = fact(await setup(shared).ask());
  const afterMiss = counter.calls;
  assert.ok(afterMiss > 0);
  const hit = fact(await setup(shared).ask());
  assert.equal(counter.calls, afterMiss);
  assert.deepEqual(hit, miss);
});

test("a cancelled module dependencies read publishes no output", async () => {
  const snapshotCache = createSnapshotDataCache(RETAINED_BYTES);
  const counter = { calls: 0, options: [] as unknown[] };
  const controller = new AbortController();
  const cancelling: ModuleDependenciesReader = { extract: async () => { counter.calls++; controller.abort(); return { files: [], dependencies: [], unread: [] }; } };
  const files = { files: ["src/A.java"] };
  const base = { nodes: SOURCE_NODES, edges: SOURCE_EDGES, snapshotCache };
  const cancelled = await setup({ ...base, moduleDependencies: cancelling, signal: controller.signal }).importers(files);
  assert.ok(!cancelled.ok);
  assert.equal(counter.calls, 1);
  assert.ok((await setup({ ...base, moduleDependencies: modulesCounted(counter) }).importers(files)).ok);
  assert.equal(counter.calls, 2);
});

test("importers judge only the edges from other files", async () => {
  const judged: string[] = [];
  const importOrigins: ImportOriginsReader = () => ({
    origins: async (sites) => sites.map((site) => originFinding(site, undefined)),
    replacedRoots: async () => NOTHING_REPLACED,
    rootOrigins: async (sites) => {
      judged.push(...sites.map((site) => site.file));
      return sites.map((site) => ({ ...originFinding(site, { kind: "repository", file: "src/Order.java" }), bare: true as const }));
    },
    rootBindings: NO_BINDINGS, declaredTypes: NO_DECLARED_TYPES, dispatchTargets: NO_DISPATCH_TARGETS, receiverMethods: NO_RECEIVER_METHODS,
  });
  const moduleDependencies: ModuleDependenciesReader = { extract: async () => ({ files: [], dependencies: [], unread: [] }) };
  const { importers } = setup({
    nodes: SHOP_NODES,
    edges: [
      { from: "Order", to: "Order", kind: "references", line: 5, column: 2 },
      { from: "file:Order", to: "Order", kind: "references", line: 6, column: 2 },
      { from: "Svc", to: "Order", kind: "references", line: 7, column: 2 },
    ],
    exports: { [HEAD]: SHOP_EXPORT },
    importOrigins,
    moduleDependencies,
  });

  const answer = importersFact(await importers({ files: ["src/Order.java"] }));

  assert.deepEqual(answer.status !== "unknown" && answer.value.files.map(({ users }) => users), [["src/Svc.java"]]);
  assert.deepEqual(judged, ["src/Svc.java"]);
});

test("a graph edge whose bare root Java places in another file leaves the graph's target: dropped when that declaration has no node, moved to it when the containment path finds one", async () => {
  const nodes = [
    fakeNode("dto", "namespace", "src/dto/Visits.java", 1, 20, "app.dto"),
    fakeNode("dtoVisits", "function", "src/dto/Visits.java", 5, 7, "Visits"),
    fakeNode("gateway", "namespace", "src/gateway/Visits.java", 1, 20, "app.gateway"),
    fakeNode("gatewayVisits", "function", "src/gateway/Visits.java", 5, 7, "Visits"),
    fakeNode("read", "method", "src/web/Resource.java", 3, 5),
    fakeNode("list", "method", "src/gateway/Client.java", 3, 5),
  ];
  const edges: FakeEdge[] = [
    { from: "dto", to: "dtoVisits", kind: "contains" },
    { from: "gateway", to: "gatewayVisits", kind: "contains" },
    { from: "read", to: "dtoVisits", kind: "references", line: 4, column: 2 },
    { from: "list", to: "dtoVisits", kind: "references", line: 4, column: 2 },
  ];
  const roots: Record<string, ImportOrigin> = {
    "src/web/Resource.java": { kind: "repository", file: "src/web/Resource.java", declared: "app.web.Resource.Visits" },
    "src/gateway/Client.java": { kind: "repository", file: "src/gateway/Visits.java", declared: "app.gateway.Visits" },
  };
  const importOrigins: ImportOriginsReader = () => ({
    origins: async (sites) => sites.map((site) => originFinding(site, undefined)),
    rootOrigins: async (sites) => sites.map((site) => ({ ...originFinding(site, roots[site.file]), bare: true as const })),
    replacedRoots: async () => NOTHING_REPLACED,
    rootBindings: NO_BINDINGS,
    declaredTypes: NO_DECLARED_TYPES, dispatchTargets: NO_DISPATCH_TARGETS, receiverMethods: NO_RECEIVER_METHODS,
  });
  const { callers } = setup({ nodes, edges, importOrigins });

  const answer = callersFact(await callers({ targets: [{ file: "src/dto/Visits.java", symbol: "Visits" }, { file: "src/gateway/Visits.java", symbol: "Visits" }] }));

  assert.ok(answer.status !== "unknown", JSON.stringify(answer));
  assert.deepEqual(answer.value.symbols.filter(({ depth }) => depth > 0).map(({ file, symbol, via }) => [file, symbol, via?.file]), [["src/gateway/Client.java", "list", "src/gateway/Visits.java"]]);
});

/**
 * `Reader.id` calls `get` at line 8, column 5, which the index matched to `Store.get` by name; `Other.get` is its homonym. The
 * checker's answer, given whole, says what the call binds.
 */
const TYPED_NODES = [fakeNode("store-get", "method", "src/store.ts", 4, 6, "get"), fakeNode("other-get", "method", "src/other.ts", 1, 3, "get"), fakeNode("id", "method", "src/reader.ts", 7, 9)];
const TYPED_EDGES: FakeEdge[] = [{ from: "id", to: "store-get", kind: "calls", line: 8, column: 4, confidence: 0.6, provenance: "heuristic" }];
const DECLARED = [{ kind: "node-modules" as const, at: "", path: "/host/checkout/node_modules" }];
const USED = [{ kind: "node-modules" as const, at: "", verified: false, digest: "read" }];
const boundTo = (target: TypeTarget): Extract<TypeBindingsAnswer, { status: "bound" }> => ({ status: "bound", bindings: [{ file: "src/reader.ts", line: 8, column: 5, name: "get", target }], unowned: [], refused: [], outputs: USED });
const STORE_GET: TypeTarget = { kind: "repository", file: "src/store.ts", line: 4, name: "get" };

function checker(answer: TypeBindingsAnswer, seen: (readonly SourceFile[])[] = []): TypedOption {
  const bindings: TypeBindings = { of: async (sources) => (seen.push(sources), answer) };
  return { bindings, outputs: DECLARED };
}

async function typedCallers(symbol: { file: string; symbol: string }, typeBindings?: TypedOption): Promise<Fact<ImpactValue>> {
  return callersFact(await setup({ nodes: TYPED_NODES, edges: TYPED_EDGES, importOrigins: origins(() => undefined), ...(typeBindings && { typeBindings }) }).callers({ targets: [symbol] }));
}

const viaOf = (answer: Fact<ImpactValue>, name: string) => (answer.status === "unknown" ? undefined : answer.value.symbols.find((symbol) => symbol.symbol === name)?.via);

test("a call the type checker binds to the edge's own target is typed and certain, and the fact records the declaration it read as unverified", async () => {
  const typed = await typedCallers({ file: "src/store.ts", symbol: "get" }, checker(boundTo(STORE_GET)));

  assert.deepEqual(typed.status !== "unknown" && typed.value.symbols.map(({ symbol, confidence, via }) => [symbol, confidence, via?.derivation]), [["get", 1, undefined], ["id", 1, "typed"]]);
  assert.deepEqual(typed.inputs.buildOutputs, USED);
});

test("a call the type checker binds to another repository declaration moves there, typed, and one it binds outside the repository is no dependence", async () => {
  const moved = checker(boundTo({ kind: "repository", file: "src/other.ts", line: 1, name: "get" }));

  assert.equal(viaOf(await typedCallers({ file: "src/store.ts", symbol: "get" }, moved), "id"), undefined);
  assert.equal(viaOf(await typedCallers({ file: "src/other.ts", symbol: "get" }, moved), "id")?.derivation, "typed");
  for (const outside of [{ kind: "external", module: "router-kit", name: "get" }, { kind: "ambient", name: "get" }] as const) {
    assert.equal(viaOf(await typedCallers({ file: "src/store.ts", symbol: "get" }, checker(boundTo(outside))), "id"), undefined, outside.kind);
  }
});

test("a call on a structural parameter the type checker binds is a typed dependence: the receiver it names takes nothing from the derivation (structural parameter, ADR-0045 decision 5)", async () => {
  const onParameter: ImportOriginsReader = (sources, paths, facts) => ({ ...origins(() => undefined)(sources, paths, facts), rootBindings: async (sites) => sites.map(() => ({ kind: "local", root: "store", lines: [7] })) });
  const nodes = [fakeNode("Store", "class", "src/store.ts", 1, 9), ...TYPED_NODES];
  const edges: FakeEdge[] = [{ from: "Store", to: "store-get", kind: "contains" }, ...TYPED_EDGES];

  const answer = callersFact(await setup({ nodes, edges, importOrigins: onParameter, syntax: true, typeBindings: checker(boundTo(STORE_GET)) }).callers({ targets: [{ file: "src/store.ts", symbol: "get" }] }));

  assert.equal(viaOf(answer, "id")?.derivation, "typed");
});

test("importers read the type checker's bindings: a call it moves to another file's declaration makes no user, and the fact records what it read", async () => {
  const importersOf = async (typeBindings?: TypedOption) => importersFact(await setup({ nodes: TYPED_NODES, edges: TYPED_EDGES, importOrigins: origins(() => undefined), ...(typeBindings && { typeBindings }) }).importers({ files: ["src/store.ts"] }));
  const namesOf = (answer: Fact<ImportersValue>) => answer.status !== "unknown" && answer.value.files.map(({ users, unresolvedNamers }) => ({ users, unresolvedNamers }));

  const moved = await importersOf(checker(boundTo({ kind: "repository", file: "src/other.ts", line: 1, name: "get" })));

  assert.deepEqual(namesOf(await importersOf()), [{ users: ["src/reader.ts"], unresolvedNamers: [] }]);
  assert.deepEqual(namesOf(moved), [{ users: [], unresolvedNamers: [] }]);
  assert.deepEqual(moved.inputs.buildOutputs, USED);
});

test("without a declared build output every answer is the one given before", async () => {
  const before = await typedCallers({ file: "src/store.ts", symbol: "get" });

  assert.equal(viaOf(before, "id")?.derivation, "name-match");
  assert.equal(canonicalJson(await typedCallers({ file: "src/store.ts", symbol: "get" }, { ...checker(boundTo(STORE_GET)), outputs: [] })), canonicalJson(before));
});

test("the checker reads the commit's lockfiles and declaration files apart from the index's export, which stays as it was", async () => {
  const files = ["src/store.ts", "src/reader.ts", "package.json", "package-lock.json", "src/env.d.ts", "node_modules/kit/index.d.ts"];
  const exports: Options["exports"] = { [HEAD]: { files: files.map((path) => ({ path, blob: path, written: true })), skipped: [] } };
  const sources = files.map((path) => ({ path, content: path }));
  const run = (typeBindings?: TypedOption) => setup({ nodes: TYPED_NODES, edges: TYPED_EDGES, importOrigins: origins(() => undefined), exports, sources, readsPlanned: true, ...(typeBindings && { typeBindings }) });
  const seen: (readonly SourceFile[])[] = [];
  const plain = run();
  const typed = run(checker(boundTo(STORE_GET), seen));

  assert.ok((await plain.callers({ targets: [{ file: "src/store.ts", symbol: "get" }] })).ok);
  assert.ok((await typed.callers({ targets: [{ file: "src/store.ts", symbol: "get" }] })).ok);
  assert.deepEqual(typed.log.plans[0], plain.log.plans[0]);
  assert.deepEqual(typed.log.plans.slice(1).map(({ wanted }) => wanted), [["package-lock.json", "src/env.d.ts"]]);
  assert.deepEqual(seen.map((read) => read.map(({ path }) => path).sort()), [["package-lock.json", "package.json", "src/env.d.ts", "src/reader.ts", "src/store.ts"]]);
});

test("a declaration the lockfile contradicts is not read: the call keeps its derivation and a build-output cut names each package", async () => {
  const answer = await typedCallers({ file: "src/store.ts", symbol: "get" }, checker({ status: "unused", outputs: [{ kind: "node-modules", at: "", stale: [{ path: "kit", installed: "2.0.0", locked: "1.0.0" }] }] }));

  assert.equal(viaOf(answer, "id")?.derivation, "name-match");
  assert.equal(answer.inputs.buildOutputs, undefined);
  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "build-output", at: ["node_modules/kit"], reason: "version-mismatch", reach: { kind: "anything" } }]);
});

test("a live tree is not typed: the call keeps its derivation and a build-output cut names each declaration it did not read", async () => {
  const seen: (readonly SourceFile[])[] = [];
  const live = fakeLive({ "src/store.ts": "1", "src/reader.ts": "1" });
  const answer = callersFact(await setup({ trust: TRUSTED, live, nodes: TYPED_NODES, edges: TYPED_EDGES, importOrigins: origins(() => undefined), typeBindings: checker(boundTo(STORE_GET), seen) }).queries.callers({ ...LIVE_BASE, targets: [{ file: "src/store.ts", symbol: "get" }], live: true }));

  assert.equal(viaOf(answer, "id")?.derivation, "name-match");
  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "build-output", at: ["node_modules"], reason: "live-tree", reach: { kind: "anything" } }]);
  assert.equal(seen.length, 0);
});

/** `Reader.id` calls `this.store.get` at line 8, column 5, a reference the index left unresolved. */
const UNSETTLED: FakeUnresolved[] = [{ from: "id", name: "this.store.get", kind: "calls", file: "src/reader.ts", line: 8, column: 4 }];

async function unsettledCallers(typeBindings?: TypedOption): Promise<Fact<ImpactValue>> {
  const exports: Options["exports"] = { [HEAD]: { files: ["src/store.ts", "src/other.ts", "src/reader.ts"].map((path) => ({ path, blob: path, written: true })), skipped: [] } };
  return callersFact(await setup({ nodes: TYPED_NODES, unresolved: UNSETTLED, exports, importOrigins: origins(() => undefined), ...(typeBindings && { typeBindings }) }).callers({ targets: [{ file: "src/store.ts", symbol: "get" }] }));
}

test("an unresolved call the type checker binds to a repository declaration is a typed dependence on it, and no cut", async () => {
  const before = await unsettledCallers();
  const typed = await unsettledCallers(checker(boundTo(STORE_GET)));

  assert.equal(viaOf(before, "id"), undefined);
  assert.deepEqual(before.status === "partial" && before.cuts.map(({ kind }) => kind), ["unresolved-link"]);
  assert.equal(viaOf(typed, "id")?.derivation, "typed");
  assert.equal(typed.status, "complete");
});

test("an unresolved call the type checker binds outside the repository, or to another declaration, retires its cut and depends on nothing walked", async () => {
  for (const target of [{ kind: "external", module: "router-kit", name: "get" }, { kind: "repository", file: "src/other.ts", line: 1, name: "get" }] as const) {
    const answer = await unsettledCallers(checker(boundTo(target)));

    assert.equal(viaOf(answer, "id"), undefined, target.kind);
    assert.equal(answer.status, "complete", target.kind);
  }
});

test("a checker fault leaves every call to the syntactic settlement and names each declaration it could not read", async () => {
  const unreadable = await typedCallers({ file: "src/store.ts", symbol: "get" }, checker({ status: "fault", fault: { kind: "unreadable", outputs: [{ kind: "node-modules", at: "", paths: ["kit"] }] } }));
  const crashed = await typedCallers({ file: "src/store.ts", symbol: "get" }, checker({ status: "fault", fault: { kind: "checker-failed", detail: "Debug Failure." } }));

  assert.deepEqual([viaOf(unreadable, "id")?.derivation, viaOf(crashed, "id")?.derivation], ["name-match", "name-match"]);
  assert.deepEqual([unreadable.inputs.buildOutputs, crashed.inputs.buildOutputs], [undefined, undefined]);
  assert.deepEqual(unreadable.status === "partial" && unreadable.cuts, [{ kind: "build-output", at: ["node_modules/kit"], reason: "outputs-unreadable", reach: { kind: "anything" } }]);
  assert.deepEqual(crashed.status === "partial" && crashed.cuts, [{ kind: "build-output", at: ["node_modules"], reason: "checker-failed", reach: { kind: "anything" } }]);
});

test("when one declaration is stale, every declaration the answer did not read is named, the clean one included", async () => {
  const two = { ...checker({ status: "unused", outputs: [{ kind: "node-modules", at: "", stale: [{ path: "kit", installed: "2.0.0", locked: "1.0.0" }] }] }), outputs: [...DECLARED, { kind: "node-modules" as const, at: "apps/web", path: "/host/checkout/apps/web/node_modules" }] };
  const answer = await typedCallers({ file: "src/store.ts", symbol: "get" }, two);

  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "build-output", at: ["apps/web/node_modules"], reason: "version-mismatch", reach: { kind: "anything" } }, { kind: "build-output", at: ["node_modules/kit"], reason: "version-mismatch", reach: { kind: "anything" } }]);
});

test("a link the declared directory refused is named in a build-output cut", async () => {
  const answer = await typedCallers({ file: "src/store.ts", symbol: "get" }, checker({ ...boundTo(STORE_GET), refused: ["node_modules/evil"] }));

  assert.equal(viaOf(answer, "id")?.derivation, "typed");
  assert.deepEqual(answer.status === "partial" && answer.cuts, [{ kind: "build-output", at: ["node_modules/evil"], reason: "link-outside", reach: { kind: "anything" } }]);
});

test("an unresolved call the checker binds to a declaration the graph does not hold keeps its cut", async () => {
  const answer = await unsettledCallers(checker(boundTo({ kind: "repository", file: "src/types.d.ts", line: 1, name: "get" })));

  assert.equal(viaOf(answer, "id"), undefined);
  assert.deepEqual(answer.status === "partial" && answer.cuts.map(({ kind }) => kind), ["unresolved-link"]);
});

test("a request's own declared build outputs reach the checker without a host-wide declaration", async () => {
  const seen: (readonly SourceFile[])[] = [];
  const { bindings } = checker(boundTo(STORE_GET), seen);
  const { deps } = setup({ nodes: TYPED_NODES, edges: TYPED_EDGES, importOrigins: origins(() => undefined) });
  const answer = callersFact(await createImpactQueries({ ...deps, typeBindings: bindings }).callers({ repo: "/repo", repoId: "repo", revision: "head", targets: [{ file: "src/store.ts", symbol: "get" }], buildOutputs: DECLARED }));

  assert.equal(viaOf(answer, "id")?.derivation, "typed");
  assert.deepEqual(answer.inputs.buildOutputs, USED);
});

test("the reverse lookup keeps each source's alignment only for an index the index cache keeps by content", async () => {
  const kept = async (cache: boolean): Promise<string[]> => {
    const real = createSnapshotDataCache(RETAINED_BYTES);
    const slots: string[] = [];
    const snapshotCache = { ...real, putFact: (key: string, json: string) => (slots.push(key), real.putFact(key, json)) };
    const nodes = [fakeNode("Svc", "class", SVC_FILE, 2, 9), fakeNode("get", "method", SVC_FILE, 4, 6), fakeNode("Cmp", "class", CMP_FILE, 2, 9), fakeNode("viaSvc", "method", CMP_FILE, 5, 7)];
    const edges = [{ from: "Svc", to: "get", kind: "contains" }, { from: "Cmp", to: "viaSvc", kind: "contains" }];
    const unresolved = [{ from: "viaSvc", name: "this.svc.get", kind: "calls", file: CMP_FILE, line: 6, column: 4 }];
    const sources = [{ path: SVC_FILE, content: "class Svc { get() {} }" }, { path: CMP_FILE, content: "this.svc.get();" }];
    const exports = { [HEAD]: { files: sources.map(({ path }, index) => ({ path, blob: `${index}`, written: true })), skipped: [] } };
    await setup({ nodes, edges, unresolved, sources, exports, syntax: true, importOrigins: origins(() => undefined), snapshotCache, ...(cache ? { cache: true } : {}) }).callers({ targets: [{ file: SVC_FILE, symbol: "get" }] });
    return slots.flatMap((key) => (key.includes("reverse-") ? [(JSON.parse(key) as { fact: string }).fact] : []));
  };

  assert.deepEqual(await kept(true), ["reverse-looked-up-names", "reverse-looked-up-names", "reverse-unbound-calls"]);
  assert.deepEqual(await kept(false), []);
});
