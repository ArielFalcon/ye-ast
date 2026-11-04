import { createWorkspaceQueries } from "../topology/workspace-queries.ts";
import { createImpactQueries } from "../impact/impact-queries.ts";
import { createWorkspaceImpactQueries } from "../topology/workspace-impact.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEntrypointQueries } from "../entrypoints/entrypoint-queries.ts";
import { withSnapshotPreparation } from "./prepared-snapshot.ts";
import type { SnapshotReaderDeps, SnapshotData, SnapshotDataCache } from "./read-snapshot.ts";

const SHA = "a".repeat(40);
function setup() {
  const log = { exports: 0, reads: 0, extracts: 0, created: [] as string[], removed: [] as string[] };
  const deps: SnapshotReaderDeps = {
    vcs: {
      resolveCommit: async (_repo, revision) => ({ ok: true, value: revision === "other" ? "b".repeat(40) : SHA }),
      exportCommit: async (_repo, _sha, _root, plan) => {
        log.exports++;
        return { ok: true, value: { files: [{ path: "src/app.ts", blob: "blob", written: plan.write("src/app.ts") }], skipped: [] } };
      },
      remotes: async () => ({ ok: true, value: [] }),
      repositoryName: async () => ({ ok: true, value: "repo" }),
      headBranch: async () => ({ ok: true, value: undefined }),
    },
    scratch: {
      create: async () => { const path = `/tmp/preparation-${log.created.length}`; log.created.push(path); return path; },
      remove: async (path) => { log.removed.push(path); },
    },
    reader: { read: async (root) => { assert.ok(!log.removed.includes(root)); log.reads++; return [{ path: "src/app.ts", content: "export const value = 1;" }]; } },
    extractor: { extract: async () => { log.extracts++; return []; } },
    digest: { of: (value) => value },
    producer: { name: "ye-ast", version: "test" },
  };
  const query = (extra: Partial<SnapshotReaderDeps> = {}) => createEntrypointQueries({ ...deps, ...extra, matcher: { matches: (path, glob) => path.startsWith(glob.replace("**", "")) }, engines: {} });
  const request = { repo: "/repo", repoId: "repo", revision: "HEAD" };
  return { deps, log, query, request };
}

test("an operation shares compatible SHA export, sources and extraction and removes retained resources after its consumers", async () => {
  const { deps, log, query, request } = setup();
  await withSnapshotPreparation(deps.scratch, async (preparation) => {
    const queries = query({ preparation });
    const first = await queries.map(request);
    const second = await queries.map({ ...request, revision: "alias" });
    assert.deepEqual(second, first);
    assert.equal(log.exports, 1);
    assert.equal(log.reads, 1);
    assert.equal(log.extracts, 1);
    assert.ok(log.created.some((root) => !log.removed.includes(root)));
  });
  assert.deepEqual(log.removed.toSorted(), log.created.toSorted());
});

test("preparation keeps source, SHA, scope, trust and budget boundaries separate", async () => {
  const { deps, log, query, request } = setup();
  await withSnapshotPreparation(deps.scratch, async (preparation) => {
    const queries = query({ preparation });
    await queries.map(request);
    await queries.map({ ...request, repo: "/another" });
    await queries.map({ ...request, revision: "other" });
    await queries.map({ ...request, scope: { exclude: ["src/**"] } });
    await query({ preparation, trust: { read: async () => ({ ok: true, value: "trusted" }) } }).map(request);
    await query({ preparation, budget: { maxBytes: 0, maxEntries: 0 } }).map(request);
    assert.equal(log.exports, 6);
  });
});

test("a cancelled consumer cannot use a prepared result and resources are removed when a consumer throws", async () => {
  const { deps, log, query, request } = setup();
  const stop = new AbortController();
  await assert.rejects(withSnapshotPreparation(deps.scratch, async (preparation) => {
    const queries = query({ preparation });
    await queries.map(request);
    stop.abort();
    const cancelled = await queries.map({ ...request, signal: stop.signal });
    assert.ok(!cancelled.ok && cancelled.fault.kind === "aborted");
    throw new TypeError("consumer");
  }), TypeError);
  assert.deepEqual(log.removed.toSorted(), log.created.toSorted());
});

test("workspace discovery and its trigger walk share preparation while deriving separate facts", async () => {
  const { deps, log } = setup();
  await withSnapshotPreparation(deps.scratch, async (preparation) => {
    const shared = { ...deps, preparation, matcher: { matches: () => true }, engines: {} };
    const workspace = createWorkspaceQueries({ ...shared, evidence: { names: () => [], artifacts: () => [] }, callSites: { of: async () => [] } });
    const impact = impactQueriesFor(shared);
    const queries = createWorkspaceImpactQueries({ workspace, impact, digest: deps.digest });
    const answer = await queries.callers({ repo: { path: "/repo", id: "repo" }, targets: [{ file: "README.md", start: 1, end: 1 }] });
    assert.ok(answer.ok && answer.value.fact.status !== "unknown");
    const section = answer.value.fact.value.sections.repo;
    assert.ok(section && section.status !== "unknown");
    assert.deepEqual(section.value.reads.map(({ kind }) => kind), ["discovery", "trigger"]);
    assert.equal(log.exports, 1);
    assert.equal(log.reads, 1);
    assert.equal(log.extracts, 1);
  });
  assert.deepEqual(log.removed.toSorted(), log.created.toSorted());
});

test("cancellation during a source read is retried by an independent consumer of the same operation", async () => {
  const { deps, log, query, request } = setup();
  const controller = new AbortController();
  const original = deps.reader.read;
  let interrupt = true;
  deps.reader.read = async (...args) => {
    const answer = await original(...args);
    if (interrupt) { interrupt = false; controller.abort(); }
    return answer;
  };
  await withSnapshotPreparation(deps.scratch, async (preparation) => {
    const queries = query({ preparation });
    const aborted = await queries.map({ ...request, signal: controller.signal });
    assert.ok(!aborted.ok && aborted.fault.kind === "aborted");
    const retried = await queries.map(request);
    assert.ok(retried.ok);
    assert.equal(log.exports, 1);
    assert.equal(log.reads, 2);
    assert.equal(log.extracts, 1);
  });
});

test("a failed export is not retained for the next consumer", async () => {
  const { deps, log, query, request } = setup();
  const original = deps.vcs.exportCommit;
  let attempts = 0;
  deps.vcs.exportCommit = async (...args) => ++attempts === 1 ? { ok: false, fault: { kind: "export-write-failed", detail: "unavailable" } } : original(...args);
  await withSnapshotPreparation(deps.scratch, async (preparation) => {
    const queries = query({ preparation });
    const failed = await queries.map(request);
    assert.ok(!failed.ok && failed.fault.kind === "export-write-failed");
    assert.ok((await queries.map(request)).ok);
    assert.equal(attempts, 2);
  });
  assert.deepEqual(log.removed.toSorted(), log.created.toSorted());
});

function dataCache(): SnapshotDataCache {
  const entries = new Map<string, SnapshotData>();
  return { get: (key) => { const data = entries.get(key); return data === undefined ? undefined : structuredClone(data); }, put: (key, data) => { entries.set(key, structuredClone(data)); } };
}

test("independent requests reuse sources and findings but each exports into its own temporary directory", async () => {
  const { log, query, request } = setup();
  const snapshotCache = dataCache();
  const first = await query({ snapshotCache }).map(request);
  assert.deepEqual(log.removed.toSorted(), log.created.toSorted());
  const second = await query({ snapshotCache }).map({ ...request, revision: "alias" });
  assert.deepEqual(second, first);
  assert.equal(log.exports, 2);
  assert.equal(log.reads, 1);
  assert.equal(log.extracts, 1);
  assert.deepEqual(log.removed.toSorted(), log.created.toSorted());
});

test("cross-request reuse revalidates SHA, source, scope, trust and export budgets", async () => {
  const { log, query, request } = setup();
  const snapshotCache = dataCache();
  const queries = query({ snapshotCache });
  await queries.map(request);
  await queries.map({ ...request, repo: "/another" });
  await queries.map({ ...request, revision: "other" });
  await queries.map({ ...request, scope: { exclude: ["src/**"] } });
  await query({ snapshotCache, trust: { read: async () => ({ ok: true, value: "trusted" }) } }).map(request);
  await query({ snapshotCache, budget: { maxBytes: 0, maxEntries: 0 } }).map(request);
  assert.equal(log.exports, 6);
  assert.equal(log.reads, 6);
  assert.equal(log.extracts, 6);
});

test("a current export fault is returned even when the same SHA has retained source data", async () => {
  const { deps, log, query, request } = setup();
  const queries = query({ snapshotCache: dataCache() });
  await queries.map(request);
  deps.vcs.exportCommit = async () => ({ ok: false, fault: { kind: "object-missing", detail: "missing blob" } });
  const answer = await queries.map(request);
  assert.ok(!answer.ok && answer.fault.kind === "object-missing");
  assert.equal(log.reads, 1);
  assert.equal(log.extracts, 1);
});

test("the current export listing and its caller-budget stop cannot be replaced by cached data", async () => {
  const { deps, log, query, request } = setup();
  const queries = query({ snapshotCache: dataCache() });
  await queries.map(request);
  deps.vcs.exportCommit = async () => ({ ok: true, value: { files: [], skipped: [], stopped: { at: "src/app.ts", limit: 0 } } });
  const answer = await queries.map(request);
  assert.ok(answer.ok && answer.value.status === "partial");
  const section = answer.value.value.entrypoints;
  assert.ok(section.status === "partial" && section.cuts.some((cut) => cut.kind === "caller-budget"));
  assert.equal(log.reads, 2);
  assert.equal(log.extracts, 2);
});

test("a cancelled extraction is repeated by the next independent request", async () => {
  const { deps, log, query, request } = setup();
  const controller = new AbortController();
  const original = deps.extractor.extract;
  let interrupt = true;
  deps.extractor.extract = async (...args) => {
    const answer = await original(...args);
    if (interrupt) { interrupt = false; controller.abort(); }
    return answer;
  };
  const queries = query({ snapshotCache: dataCache() });
  const aborted = await queries.map({ ...request, signal: controller.signal });
  assert.ok(!aborted.ok && aborted.fault.kind === "aborted");
  assert.ok((await queries.map(request)).ok);
  assert.equal(log.extracts, 2);
  assert.equal(log.reads, 1);
  assert.ok((await queries.map(request)).ok);
  assert.equal(log.extracts, 2);
});

test("concurrent requests keep independent cancellation and publish no interrupted source read", async () => {
  const { deps, log, query, request } = setup();
  const controller = new AbortController();
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
  const released = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const original = deps.reader.read;
  let reads = 0;
  deps.reader.read = async (...args) => {
    const value = await original(...args);
    if (++reads === 1) { firstEntered(); await released; }
    return value;
  };
  const queries = query({ snapshotCache: dataCache() });
  const first = queries.map({ ...request, signal: controller.signal });
  await entered;
  const independent = await queries.map(request);
  assert.ok(independent.ok);
  controller.abort();
  releaseFirst();
  const interrupted = await first;
  assert.ok(!interrupted.ok && interrupted.fault.kind === "aborted");
  assert.deepEqual(await queries.map(request), independent);
  assert.equal(log.exports, 3);
  assert.equal(log.reads, 2);
  assert.equal(log.extracts, 1);
  assert.deepEqual(log.removed.toSorted(), log.created.toSorted());
});

test("retained sources are not served to an already cancelled request", async () => {
  const { log, query, request } = setup();
  const queries = query({ snapshotCache: dataCache() });
  await queries.map(request);
  const controller = new AbortController();
  controller.abort();
  const stopped = await queries.map({ ...request, signal: controller.signal });
  assert.ok(!stopped.ok && stopped.fault.kind === "aborted");
  assert.equal(log.exports, 1);
  assert.equal(log.reads, 1);
  assert.equal(log.extracts, 1);
});

function impactQueriesFor(deps: SnapshotReaderDeps) {
  const unavailable = { ok: false, fault: { kind: "index-failed", detail: "unused" } } as const;
  return createImpactQueries({
      ...deps, matcher: { matches: () => true }, engines: {},
      vcs: Object.assign(deps.vcs, { mergeBase: async () => ({ ok: true as const, value: SHA }), diffCommits: async () => ({ ok: true as const, value: [] }), diffDirectories: async () => ({ ok: true as const, value: [] }) }),
      graph: { index: async () => unavailable, open: () => unavailable, buildMirror: async () => unavailable, syncMirror: async () => unavailable },
      angular: { read: async () => [] }, relations: { extract: async () => ({ relations: [], fields: [], locals: [] }) }, dynamicLoads: { extract: async () => [] }, angularEngines: {},
    });
}

test("a source-only request cannot downgrade findings published by a concurrent request", async () => {
  const { deps, log, query, request } = setup();
  const snapshotCache = dataCache();
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
  const released = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const original = deps.reader.read;
  let reads = 0;
  deps.reader.read = async (...args) => {
    const value = await original(...args);
    if (++reads === 1) { firstEntered(); await released; }
    return value;
  };
  const first = impactQueriesFor({ ...deps, snapshotCache }).importers({ ...request, files: [] });
  await entered;
  const queries = query({ snapshotCache });
  assert.ok((await queries.map(request)).ok);
  releaseFirst();
  assert.ok((await first).ok);
  assert.ok((await queries.map(request)).ok);
  assert.equal(log.reads, 2);
  assert.equal(log.extracts, 1);
});

test("deadline findings are not reused as a completed extraction", async () => {
  const { deps, log, query, request } = setup();
  let deadline = true;
  deps.extractor.extract = async () => {
    log.extracts++;
    return deadline ? [{ status: "unknown", reason: "deadline", evidence: [] }] : [];
  };
  const queries = query({ snapshotCache: dataCache() });
  assert.ok((await queries.map(request)).ok);
  deadline = false;
  const complete = await queries.map(request);
  assert.ok(complete.ok && complete.value.value.entrypoints.status !== "unknown");
  assert.deepEqual(complete.value.value.entrypoints.value, []);
  assert.equal(log.reads, 1);
  assert.equal(log.extracts, 2);
});
