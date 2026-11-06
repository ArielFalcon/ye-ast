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
import { createImpactQueries, type ImpactQueriesDeps } from "../impact/impact-queries.ts";
import type { ImportOriginsReader, ImportOriginSite } from "../../ports/import-origins.port.ts";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import type { SnapshotDataCache } from "./read-snapshot.ts";
import { createSnapshotDataCache } from "./snapshot-data-cache.ts";
import { createHeadReader, createHeldLive, withLiveCaptures } from "./head-reading.ts";
import { openLive } from "../live/live-tree.ts";
import { liveScope } from "../../domain/snapshot/live-export.ts";
import { pathSelection } from "../../domain/shared/scope.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const FORK = "c".repeat(40);
const SUMMARY: IndexSummary = { filesIndexed: 1, filesSkipped: 0, filesErrored: 0, filesNotIndexed: [], versions: { codegraph: "x", schema: 0, extraction: 0 } };

function change(path: string, overrides: Partial<FileChange> = {}): FileChange {
  return { path, deleted: false, binary: false, added: [{ start: 1, end: 1 }], removals: [], removedNames: [], ...overrides };
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
  trust?: TrustRecordReader;
  live?: FakeLive;
  /** What `diffDirectories` answers. */
  directoryChanges?: Result<readonly FileChange[], VcsFault>;
  onDiffDirectories?: () => void;
  /** The head's sources, as the export reader hands them over. */
  sources?: SourceFile[];
  /** Reads the imports of those sources, as composition wires it. */
  importOrigins?: ImportOriginsReader;
  moduleDependencies?: ModuleDependenciesReader;
  snapshotSources?: Partial<Record<string, SourceFile[]>>;
  snapshotCache?: SnapshotDataCache;
}

function setup(options: Options = {}) {
  const log = { exported: [] as string[], plans: [] as { sha: string; destination: string; wanted: string[] }[], compared: [] as [string, string][], created: [] as string[], removed: [] as string[], indexed: 0, closed: 0, reads: 0, extractions: 0, obtained: [] as string[] };
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
    reader: { read: async (root) => { log.reads++; return options.snapshotSources?.[log.plans.find((plan) => plan.destination === root)?.sha ?? ""] ?? options.sources ?? []; } },
    extractor: { extract: async () => { log.extractions++; return []; } },
    angular: { read: async () => options.declarations ?? [] },
    relations: options.relationReader ?? { extract: async () => ({ relations: options.relations ?? [], fields: options.fields ?? [], locals: [] }) },
    dynamicLoads: { extract: async () => options.loads ?? [] },
    contracts: { operations: () => [] },
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
    ...(options.declarationEvidence && { declarationEvidence: options.declarationEvidence }),
    ...(options.importOrigins && { importOrigins: options.importOrigins }),
    ...(options.moduleDependencies && { moduleDependencies: options.moduleDependencies }),
    ...(options.snapshotCache && { snapshotCache: options.snapshotCache }),
  };
  const request: AtRevision<ImpactOfChangeRequest> = { repo: "/repo", repoId: "repo", base: "base", head: "head", ...(options.signal && { signal: options.signal }) };
  const queries = createImpactQueries(deps);
  const callersRequest: AtRevision<ImpactCallersRequest> = { repo: "/repo", repoId: "repo", revision: "head", targets: [], ...(options.signal && { signal: options.signal }) };
  const importersRequest: AtRevision<ImpactImportersRequest> = { repo: "/repo", repoId: "repo", revision: "head", files: [], ...(options.signal && { signal: options.signal }) };
  return {
    deps,
    log,
    queries,
    ask: (overrides: Partial<AtRevision<ImpactOfChangeRequest>> = {}) => queries.ofChange({ ...request, ...overrides }),
    callers: (overrides: Partial<AtRevision<ImpactCallersRequest>>) => queries.callers({ ...callersRequest, ...overrides }),
    importers: (overrides: Partial<AtRevision<ImpactImportersRequest>>) => queries.importers({ ...importersRequest, ...overrides }),
  };
}

const TRUSTED: TrustRecordReader = { read: async () => ({ ok: true, value: "trusted" }) };
const LIVE_BASE = { repo: "/repo", repoId: "repo" } as const;
const LIVE_NODES = [fakeNode("f", "function", "src/A.java", 1, 3), fakeNode("g", "function", "src/B.java", 1, 3)];

test("an installed held-live provider with no matching capture fails without reopening", async () => {
  const live = fakeLive({ "src/A.java": "1" });
  const { deps, queries } = setup({ trust: TRUSTED, live, nodes: LIVE_NODES });
  Object.assign(deps, { heldLive: () => undefined });
  const answer = await queries.callers({ ...LIVE_BASE, targets: [{ file: "src/A.java", symbol: "f" }], live: true });
  assert.ok(!answer.ok && answer.fault.kind === "live-mirror-failed");
  assert.equal(live.held.locks, 0);
});

test("held live callers and change reuse one captured tree, head, sources and extraction", async () => {
  const live = fakeLive({ "src/A.java": "2", "src/New.java": "new" });
  const { deps, queries, log } = setup({ trust: TRUSTED, live, nodes: LIVE_NODES, directoryChanges: { ok: true, value: [change("src/A.java"), change("src/Old.java", { deleted: true })] }, exports: { [FORK]: { files: [{ path: "src/A.java", blob: "1", written: true }, { path: "src/Old.java", blob: "old", written: true }], skipped: [] } } });
  let currentHead = HEAD;
  const resolved: string[] = [];
  deps.vcs.resolveCommit = async (_repo, revision) => { resolved.push(revision); return { ok: true, value: revision === "HEAD" ? currentHead : BASE }; };
  const merges: string[] = [];
  deps.vcs.mergeBase = async (_repo, _base, head) => { merges.push(head); return { ok: true, value: FORK }; };
  const reader = deps.reader.read;
  const seen: string[] = [];
  let mirrorBytes = "";
  deps.reader.read = async (root, paths) => { if (root === "/index") { log.reads++; seen.push(mirrorBytes); return [{ path: "src/A.java", content: mirrorBytes }]; } return reader(root, paths); };
  const scope = liveScope();
  const opened = await openLive(live.deps, { repo: "/repo", scope, selected: pathSelection(scope, () => false), store: true }, async (tree) => {
    const held = createHeldLive({ repo: "/repo", repoId: "repo", head: HEAD, scope, tree, trust: "trusted", deps });
    deps.heldLive = () => held;
    mirrorBytes = live.tree.get("src/A.java")!;
    live.tree.set("src/A.java", "changed after capture");
    currentHead = "d".repeat(40);
    const exported = await createHeadReader(deps).atExport({ repo: "/repo", repoId: "repo", live: true }, { declaredConfig: {}, engines: {} }, async (head) => ({ ok: true, value: { ...head.base("export"), status: "complete", value: true } }));
    assert.ok(exported.ok);
    assert.equal(log.reads, 0);
    assert.equal(log.extractions, 0);
    const callers = await queries.callers({ ...LIVE_BASE, targets: [{ file: "src/A.java", symbol: "f" }], live: true });
    assert.ok(callers.ok);
    const changed = await queries.ofChange({ ...LIVE_BASE, base: "base", live: true });
    assert.ok(changed.ok);
    assert.deepEqual(callers.value.snapshot, { repo: "repo", kind: "live", head: HEAD, stateId: tree.stateId });
    assert.deepEqual(changed.value.snapshot, callers.value.snapshot);
    assert.equal(live.held.released, 0);
    assert.equal(log.closed, 2);
    assert.deepEqual(live.materialized, [["src/A.java", "src/New.java", "src/Old.java"]]);
    return undefined;
  });
  assert.ok(opened.ok);
  assert.deepEqual(resolved, ["base"]);
  assert.deepEqual(merges, [HEAD]);
  assert.deepEqual(seen, ["2"]);
  assert.equal(log.extractions, 2); // captured head and merge base
  assert.deepEqual(live.held, { locks: 1, released: 1 });
});

test("held capture rejects root, identity, scope and reader dependency mismatches without reopening", async () => {
  const live = fakeLive({ "src/A.java": "1" });
  const { deps, queries } = setup({ trust: TRUSTED, live, nodes: LIVE_NODES });
  const scope = liveScope();
  const result = await openLive(live.deps, { repo: "/repo", scope, selected: pathSelection(scope, () => false), store: true }, async (tree) => {
    const held = createHeldLive({ repo: "/repo", repoId: "repo", head: HEAD, scope, tree, trust: "trusted", deps });
    for (const invalid of [
      { ...held, repo: "/other" },
      { ...held, repoId: "other" },
      { ...held, scope: liveScope({ include: ["other/**"] }) },
      { ...held, deps: { ...held.deps, reader: { ...held.deps.reader } } },
      { ...held, tree: { ...held.tree, location: { ...tree.location, scope: "other" } } },
    ]) {
      deps.heldLive = () => invalid;
      const answer = await queries.callers({ ...LIVE_BASE, targets: [{ file: "src/A.java", symbol: "f" }], live: true });
      assert.ok(!answer.ok && answer.fault.kind === "live-mirror-failed");
      assert.deepEqual(live.held, { locks: 1, released: 0 });
    }
  });
  assert.ok(result.ok);
  assert.deepEqual(live.held, { locks: 1, released: 1 });
});

test("a held capture over the content of an earlier one reads nothing, and a capture held across an edit keeps the content it captured", async () => {
  const live = fakeLive({ "src/A.java": "1" });
  const snapshotCache = createSnapshotDataCache(1 << 20);
  const { deps, queries, log } = setup({ trust: TRUSTED, live, nodes: LIVE_NODES, snapshotCache });
  const scope = liveScope();
  const capture = (use: (held: ReturnType<typeof createHeldLive>) => Promise<void>) => openLive(live.deps, { repo: "/repo", scope, selected: pathSelection(scope, () => false), store: true }, async (tree) => {
    const held = createHeldLive({ repo: "/repo", repoId: "repo", head: HEAD, scope, tree, trust: "trusted", deps });
    deps.heldLive = () => held;
    await use(held);
  });
  const ask = () => queries.callers({ ...LIVE_BASE, targets: [{ file: "src/A.java", symbol: "f" }], live: true });

  assert.ok((await capture(async () => { assert.ok((await ask()).ok); })).ok);
  assert.deepEqual([log.reads, log.extractions], [1, 1]);
  assert.ok((await capture(async () => { assert.ok((await ask()).ok); assert.ok((await ask()).ok); })).ok);
  assert.deepEqual([log.reads, log.extractions], [1, 1]);
  assert.ok((await capture(async (held) => {
    live.tree.set("src/A.java", "2");
    const extracted = await held.extract();
    assert.ok(extracted.ok);
    assert.ok((await ask()).ok);
  })).ok);
  assert.deepEqual([log.reads, log.extractions], [1, 1]);
  assert.ok((await capture(async () => { assert.ok((await ask()).ok); })).ok);
  assert.deepEqual([log.reads, log.extractions], [2, 2]);
});

for (const stage of ["sources", "extraction"] as const) {
  test(`held live callers retry a rejected ${stage} promise within the same capture`, async () => {
    const live = fakeLive({ "src/A.java": "1" });
    const { deps, queries, log } = setup({ trust: TRUSTED, live, nodes: LIVE_NODES });
    const transient = new Error(`transient ${stage} failure`);
    let attempts = 0;
    if (stage === "sources") {
      const read = deps.reader.read;
      deps.reader.read = async (...args) => {
        if (++attempts === 1) throw transient;
        return read(...args);
      };
    } else {
      const extract = deps.extractor.extract;
      deps.extractor.extract = async (...args) => {
        if (++attempts === 1) throw transient;
        return extract(...args);
      };
    }
    const scope = liveScope();
    const result = await openLive(live.deps, { repo: "/repo", scope, selected: pathSelection(scope, () => false), store: true }, async (tree) => {
      const held = createHeldLive({ repo: "/repo", repoId: "repo", head: HEAD, scope, tree, trust: "trusted", deps });
      deps.heldLive = () => held;
      const ask = () => queries.callers({ ...LIVE_BASE, targets: [{ file: "src/A.java", symbol: "f" }], live: true });
      await assert.rejects(ask(), (error) => error === transient);
      const retry = await ask();
      assert.ok(retry.ok);
      assert.deepEqual(retry.value.snapshot, { repo: "repo", kind: "live", head: HEAD, stateId: tree.stateId });
      assert.ok((await ask()).ok);
      assert.equal(attempts, 2);
      assert.equal(log.reads, 1);
      assert.equal(log.extractions, 1);
      assert.deepEqual(live.held, { locks: 1, released: 0 });
    });
    assert.ok(result.ok);
    assert.deepEqual(live.held, { locks: 1, released: 1 });
  });
}

test("multiple live captures acquire in root order and release in reverse", async () => {
  const live = fakeLive({ "src/A.java": "1" });
  const { deps } = setup({ live });
  const events: string[] = [];
  const lock = live.deps.mirror.lock;
  live.deps.mirror.lock = async (location, signal) => {
    events.push(`lock:${location.repo}`);
    const result = await lock(location, signal);
    if (!result.ok) return result;
    return { ok: true, value: { release: async () => { events.push(`release:${location.repo}`); await result.value.release(); } } };
  };
  const selections = ["/b", "/a"].map((repo) => ({ repo, repoId: repo, head: HEAD, scope: liveScope(), trust: "trusted" as const }));
  const result = await withLiveCaptures(deps, selections, undefined, async (captures) => {
    assert.deepEqual([...captures.keys()], ["/a", "/b"]);
    assert.deepEqual(events, ["lock:/a", "lock:/b"]);
    return 42;
  });
  assert.ok(result.ok && result.value === 42);
  assert.deepEqual(events, ["lock:/a", "lock:/b", "release:/b", "release:/a"]);
});

test("duplicate roots or identities are rejected before any live lock", async () => {
  const live = fakeLive({});
  const { deps } = setup({ live });
  const a = { repo: "/a", repoId: "a", head: HEAD, scope: liveScope(), trust: "trusted" as const };
  for (const other of [{ ...a, repoId: "b" }, { ...a, repo: "/b" }]) {
    await assert.rejects(withLiveCaptures(deps, [a, other], undefined, async () => undefined), TypeError);
  }
  assert.equal(live.held.locks, 0);
});

function recordLeases(live: FakeLive): string[] {
  const events: string[] = [];
  const lock = live.deps.mirror.lock;
  live.deps.mirror.lock = async (location, signal) => {
    events.push(`lock:${location.repo}`);
    const result = await lock(location, signal);
    if (!result.ok) return result;
    return { ok: true, value: { release: async () => { events.push(`release:${location.repo}`); await result.value.release(); } } };
  };
  return events;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const threeSelections = ["/c", "/b", "/a"].map((repo) => ({ repo, repoId: repo, head: HEAD, scope: liveScope(), trust: "trusted" as const }));

test("later acquisition failure keeps its cause and releases earlier leases in reverse", async () => {
  const live = fakeLive({});
  const { deps } = setup({ live });
  const lock = live.deps.mirror.lock;
  const cause = { kind: "refused" as const, detail: "locked" };
  live.deps.mirror.lock = async (location, signal) => location.repo === "/c" ? { ok: false, fault: cause } : lock(location, signal);
  const events = recordLeases(live);
  const result = await withLiveCaptures(deps, threeSelections, undefined, async () => { assert.fail("incomplete capture"); });
  assert.ok(!result.ok);
  assert.equal(result.fault.repoId, "/c");
  assert.deepEqual(result.fault.cause, { kind: "live-mirror-failed", detail: "refused: locked" });
  assert.deepEqual(events, ["lock:/a", "lock:/b", "lock:/c", "release:/b", "release:/a"]);
  assert.deepEqual(live.held, { locks: 2, released: 2 });
});

test("abort during a later acquisition identifies that repository and unwinds earlier leases", async () => {
  const live = fakeLive({});
  const { deps } = setup({ live });
  const controller = new AbortController();
  const lock = live.deps.mirror.lock;
  live.deps.mirror.lock = async (location, signal) => {
    if (location.repo === "/c") { controller.abort(); return { ok: false, fault: { kind: "aborted", detail: "cancelled" } }; }
    return lock(location, signal);
  };
  const events = recordLeases(live);
  const result = await withLiveCaptures(deps, threeSelections, controller.signal, async () => { assert.fail("incomplete capture"); });
  assert.ok(!result.ok);
  assert.equal(result.fault.repoId, "/c");
  assert.equal(result.fault.cause.kind, "aborted");
  assert.deepEqual(events, ["lock:/a", "lock:/b", "lock:/c", "release:/b", "release:/a"]);
  assert.deepEqual(live.held, { locks: 2, released: 2 });
});

test("callback throw and cancellation release all leases in reverse", async () => {
  for (const cancel of [false, true]) {
    const live = fakeLive({});
    const { deps } = setup({ live });
    const events = recordLeases(live);
    const controller = new AbortController();
    const error = new Error("callback");
    const operation = withLiveCaptures(deps, threeSelections, controller.signal, async () => { if (cancel) { controller.abort(); return 1; } throw error; });
    if (cancel) { const result = await operation; assert.ok(!result.ok && result.fault.cause.kind === "aborted"); }
    else await assert.rejects(operation, (thrown) => thrown === error);
    assert.deepEqual(events, ["lock:/a", "lock:/b", "lock:/c", "release:/c", "release:/b", "release:/a"]);
    assert.deepEqual(live.held, { locks: 3, released: 3 });
  }
});

test("overlapping operations hold independent capture maps for distinct roots", async () => {
  const live = fakeLive({});
  const { deps } = setup({ live });
  const entered = [deferred(), deferred()];
  const release = deferred();
  const seen: ReadonlyMap<string, unknown>[] = [];
  const operations = ["/a", "/b"].map((repo, i) => withLiveCaptures(deps, [{ repo, repoId: repo, head: HEAD, scope: liveScope(), trust: "trusted" }], undefined, async (captures) => {
    seen[i] = captures;
    entered[i]!.resolve();
    await release.promise;
  }));
  try {
    await Promise.all(entered.map((barrier) => barrier.promise));
    assert.deepEqual([...seen[0]!.keys()], ["/a"]);
    assert.deepEqual([...seen[1]!.keys()], ["/b"]);
    assert.notEqual(seen[0], seen[1]);
    assert.ok(seen[0]!.get("/a"));
    assert.ok(seen[1]!.get("/b"));
    assert.notEqual(seen[0]!.get("/a"), seen[1]!.get("/b"));
    assert.deepEqual(live.held, { locks: 2, released: 0 });
  } finally { release.resolve(); }
  const results = await Promise.all(operations);
  assert.ok(results.every((result) => result.ok));
  assert.deepEqual(live.held, { locks: 2, released: 2 });
});

test("input order does not affect capture order", async () => {
  const live = fakeLive({});
  const { deps } = setup({ live });
  for (const input of [threeSelections, [...threeSelections].reverse()]) {
    const result = await withLiveCaptures(deps, input, undefined, async (captures) => [...captures.keys()]);
    assert.ok(result.ok);
    assert.deepEqual(result.value, ["/a", "/b", "/c"]);
  }
});

test("empty live selections call back without live dependencies and respect cancellation", async () => {
  const { deps } = setup();
  const result = await withLiveCaptures(deps, [], undefined, async (captures) => {
    assert.equal(captures.size, 0);
    return 42;
  });
  assert.deepEqual(result, { ok: true, value: 42 });
  const controller = new AbortController();
  controller.abort();
  const aborted = await withLiveCaptures(deps, [], controller.signal, async () => { assert.fail("aborted callback"); });
  assert.ok(!aborted.ok && aborted.fault.cause.kind === "aborted");
  const during = new AbortController();
  const interrupted = await withLiveCaptures(deps, [], during.signal, async () => { during.abort(); return 42; });
  assert.ok(!interrupted.ok && interrupted.fault.cause.kind === "aborted");
});
test("cancellation during an outer postlude suppresses already queued inner notices", async () => {
  const live = fakeLive({ "src/A.java": "1" });
  const { deps } = setup({ live });
  const controller = new AbortController();
  const compared: string[] = [];
  const notices: string[] = [];
  live.deps.mirror.changedSince = async (location) => {
    compared.push(location.repo);
    if (location.repo === "/b") {
      controller.abort();
      return { ok: false, fault: { kind: "aborted", detail: "cancelled comparison" } };
    }
    return { ok: true, value: ["src/A.java"] };
  };
  const result = await withLiveCaptures(deps, threeSelections.map((selection) => ({ ...selection, onStale: () => { notices.push(selection.repoId); } })), controller.signal, async () => 42);
  assert.ok(!result.ok);
  assert.deepEqual(compared, ["/c", "/b"]);
  assert.deepEqual(notices, []);
  assert.equal(result.fault.repoId, "/b");
  assert.equal(result.fault.cause.kind, "aborted");
  assert.deepEqual(live.held, { locks: 3, released: 3 });
});
