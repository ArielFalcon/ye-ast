import { createCapturedDecisionQueries } from "../decisions/decision-queries.ts";
import type { LiveMirror, MirrorLocation } from "../../ports/live-mirror.port.ts";
import type { WorkspacePlanningRequest } from "./workspace-plan.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeLive } from "../live/fake-live.testing.ts";
import { createWorkspaceReadOperation, type WorkspaceQueriesDeps } from "./workspace-queries.ts";

const sha = "a".repeat(40);

test("live discovery uses held dirty sources and retains its snapshot through postlude", async () => {
  const fake = fakeLive({ "src/app.ts": "dirty" });
  let extracts = 0;
  const deps: WorkspaceQueriesDeps = {
    vcs: {
      canonicalRoot: async (path) => ({ ok: true, value: path }),
      resolveCommit: async () => ({ ok: true, value: sha }),
      remotes: async () => ({ ok: true, value: [] }),
      headBranch: async () => ({ ok: true, value: "main" }),
      repositoryName: async () => ({ ok: true, value: "app" }),
      exportCommit: async () => assert.fail("live must not export a commit"),
    },
    trust: { read: async () => ({ ok: true, value: "trusted" }) },
    scratch: { create: async () => "/scratch", remove: async () => undefined },
    reader: { read: async (_root, paths) => paths.map((path) => ({ path, content: fake.tree.get(path) ?? "" })) },
    extractor: { extract: async () => { extracts++; return []; } },
    digest: { of: (text) => text }, matcher: { matches: () => true },
    evidence: { names: (sources) => sources.map(({ path, content }) => ({ name: content, kind: "dependency" as const, evidence: [{ path, line: 1 }] })), artifacts: () => [] },
    callSites: { of: async () => [] }, producer: { name: "test", version: "1" }, engines: {},
    graph: fake.deps.graph, live: fake.deps,
  };
  const result = await createWorkspaceReadOperation(deps).withRead({ repo: { path: "/app", id: "app", live: true } }, async (read, context) => {
    assert.equal(fake.held.locks - fake.held.released, 1);
    assert.notEqual(read.fact.status, "unknown");
    if (read.fact.status === "unknown") throw new Error("unexpected unknown");
    const section = read.fact.value.sections.app;
    assert.ok(section && section.status !== "unknown");
    assert.equal(section.value.names[0]?.name, "dirty");
    assert.equal(section.inputs.declaredScope.ignored, "git");
    assert.equal(section.inputs.scope, JSON.stringify(context.liveCaptures.get("app")!.scope));
    assert.equal(section.inputs.trust, "trusted");
    const captured = await context.liveCaptures.get("app")!.extract(context.signal);
    assert.ok(captured.ok);
    fake.tree.set("src/app.ts", "newer");
    return { ok: true, value: read.fact.snapshot };
  });
  assert.ok(result.ok);
  assert.equal(result.value.value.kind, "live");
  assert.equal(extracts, 1);
  assert.equal(fake.held.released, 1);
  assert.equal(result.value.workspaceLive?.[0]?.repo, "app");
});

function multipleLive() {
  const app = fakeLive({ "src/app.ts": "client:library" });
  const lib = fakeLive({ "src/lib.ts": "library:served" });
  const fakes = new Map([["/app", app], ["/lib", lib]]);
  const mirror = new Proxy(app.deps.mirror, { get(_target, property: keyof LiveMirror) {
    if (property === "root" || property === "indexRoot") return (location: MirrorLocation) => location.repo;
    return (...args: unknown[]) => {
      const first = args[0];
      const repo = typeof first === "string" ? first : (first as MirrorLocation).repo;
      const owner = fakes.get(repo)!;
      const method = owner.deps.mirror[property] as (...values: unknown[]) => unknown;
      return method(...args);
    };
  } });
  const live = { ...app.deps, mirror, workingTree: { list: (repo: string, signal?: AbortSignal) => fakes.get(repo)!.deps.workingTree.list(repo, signal) } };
  const counts: Record<string, number> = {};
  const originEvents: { repo: string; held: number; signal: AbortSignal | undefined }[] = [];
  const trustEvents: { repo: string; held: number }[] = [];
  const digest = { of: (text: string) => { let hash = 2166136261; for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619); return (hash >>> 0).toString(16).padStart(8, "0").repeat(8); } };
  const held = () => [...fakes.values()].reduce((n, fake) => n + fake.held.locks - fake.held.released, 0);
  const deps: WorkspaceQueriesDeps = {
    vcs: {
      canonicalRoot: async (path) => ({ ok: true, value: path }),
      resolveCommit: async () => ({ ok: true, value: sha }),
      remotes: async (repo, signal) => { originEvents.push({ repo, held: held(), signal }); return { ok: true, value: repo === "/lib" ? [{ name: "origin", url: "https://example.invalid/lib" }] : [] }; },
      headBranch: async () => ({ ok: true, value: "main" }),
      repositoryName: async () => ({ ok: true, value: "app" }),
      exportCommit: async () => assert.fail("live must not export a commit"),
    },
    trust: { read: async (repo) => { trustEvents.push({ repo, held: held() }); return { ok: true, value: "trusted" }; } },
    scratch: { create: async () => "/scratch", remove: async () => undefined },
    reader: { read: async (root, paths) => paths.map((path) => ({ path, content: fakes.get(root)!.tree.get(path) ?? "" })) },
    extractor: { extract: async (sources) => {
      const source = sources[0]!;
      counts[source.path] = (counts[source.path] ?? 0) + 1;
      return [{ status: "complete", value: { kind: "http-route", name: source.content, method: "GET", path: `/${source.content}`, handler: { path: source.path, symbol: "handler", line: 2 }, basePath: { status: "unknown", reason: "unresolved", evidence: [] } }, evidence: [{ path: source.path, line: 2 }] }];
    } },
    digest, matcher: { matches: () => true },
    evidence: { names: (sources) => sources.filter((source) => source.content === "client:library").map(({ path }) => ({ kind: "dependency" as const, name: "library", evidence: [{ path, line: 1 }] })), artifacts: (sources) => sources.some(({ content }) => content === "library:served") ? ["library"] : [] },
    callSites: { of: async (sources, repo, libraries) => repo === "app" && sources[0]?.content === "client:library" && libraries?.[0]?.content === "library:served" ? [{ repo, file: "src/app.ts", line: 3, symbol: "call", transport: "http", target: { status: "complete", value: { method: "GET", path: "/library" }, evidence: [] } }] : [] },
    producer: { name: "test", version: "1" }, engines: {}, graph: live.graph, live,
  };
  const request: WorkspacePlanningRequest = { repo: { path: "/app", id: "app", live: true }, repos: [{ path: "/lib", id: "lib", live: true }] };
  return { app, lib, deps, counts, originEvents, trustEvents, held, request };
}

test("two held repositories join captured sources and retain separate findings and snapshots", async () => {
  const s = multipleLive();
  const result = await createWorkspaceReadOperation(s.deps).withRead(s.request, async (read, context) => {
    assert.equal(s.held(), 2);
    assert.notEqual(read.fact.status, "unknown");
    if (read.fact.status === "unknown") throw new Error("unexpected unknown");
    const repos = read.fact.value.repositories;
    assert.deepEqual(repos.map((repo) => repo.repo), ["app", "lib"]);
    assert.deepEqual(repos.map((repo) => repo.snapshot.kind), ["live", "live"]);
    assert.deepEqual(repos.map((repo) => repo.declaredTrust), ["trusted", "trusted"]);
    assert.ok(s.trustEvents.every(({ held }) => held === 0));
    assert.deepEqual(repos.map((repo) => repo.entrypoints[0]?.evidence[0]?.path), ["src/app.ts", "src/lib.ts"]);
    assert.deepEqual(repos.map((repo) => repo.entrypoints[0]?.status === "complete" ? repo.entrypoints[0].value.name : undefined), ["client:library", "library:served"]);
    assert.equal(repos[0]?.callSites[0]?.file, "src/app.ts");
    assert.equal(repos[0]?.callSites[0]?.target.status, "complete");
    for (const capture of context.liveCaptures.values()) assert.ok((await capture.extract(context.signal)).ok);
    return { ok: true, value: read.fact.value.repositorySnapshots };
  });
  assert.ok(result.ok);
  assert.deepEqual(result.value.value.map((item) => item.snapshot.repo), ["app", "lib"]);
  assert.deepEqual(s.counts, { "src/app.ts": 1, "src/lib.ts": 1 });
  assert.equal(s.held(), 0);
});

test("mismatched live replay rejects before discovery extraction or consumer", async () => {
  const s = multipleLive();
  const operation = createWorkspaceReadOperation(s.deps);
  const initial = await operation.withRead(s.request, async () => ({ ok: true, value: null }));
  assert.ok(initial.ok && initial.value.workspaceReplay);
  s.counts["src/app.ts"] = 0; s.counts["src/lib.ts"] = 0;
  const replay = { ...initial.value.workspaceReplay, snapshots: initial.value.workspaceReplay.snapshots.map((snapshot) => snapshot.repo === "app" && snapshot.kind === "live" ? { ...snapshot, stateId: "f".repeat(64) } : snapshot) };
  let called = false;
  const result = await operation.withRead({ ...s.request, replay }, async () => { called = true; return { ok: true, value: null }; });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.fault.kind, "workspace-replay-mismatch");
  assert.deepEqual(s.counts, { "src/app.ts": 0, "src/lib.ts": 0 });
  assert.equal(called, false);
  assert.equal(s.held(), 0);
});

test("captured decisions read origins while both leases are held and return stale notice after release", async () => {
  const s = multipleLive();
  const controller = new AbortController();
  const original = s.deps.vcs.remotes;
  let libReads = 0;
  s.deps.vcs = { ...s.deps.vcs, remotes: async (repo, signal) => {
    const result = await original(repo, signal);
    if (repo === "/lib" && ++libReads === 2) s.lib.tree.set("src/lib.ts", "changed");
    return result;
  } };
  const operation = createWorkspaceReadOperation(s.deps);
  const queries = createCapturedDecisionQueries({ operation, vcs: s.deps.vcs, digest: s.deps.digest });
  const result = await queries.decisions({ ...s.request, signal: controller.signal });
  assert.ok(result.ok);
  assert.equal(libReads, 2);
  assert.deepEqual(s.originEvents.filter(({ repo }) => repo === "/lib").map(({ held, signal }) => ({ held, signal })), [{ held: 2, signal: controller.signal }, { held: 2, signal: controller.signal }]);
  assert.equal(s.held(), 0);
  assert.deepEqual(result.value.workspaceLive?.map((notice) => notice.repo), ["lib"]);
  assert.notEqual(result.value.fact.status, "unknown");
  if (result.value.fact.status !== "unknown") {
    assert.deepEqual(result.value.fact.value.repositories.map((item) => item.repo), ["app", "lib"]);
    const remote = result.value.fact.value.decisions.find((decision) => decision.id === "remote:lib");
    assert.equal(remote?.options[0]?.value, "https://example.invalid/lib");
    assert.equal(remote?.options[0]?.evidence[0]?.repo, "lib");
  }
});

test("persisted membership keeps an unavailable SHA beside the live trigger and replay vector", async () => {
  const s = multipleLive();
  const missingSha = "b".repeat(40);
  const url = "https://example.invalid/missing";
  s.deps.defaults = { of: async () => ({ ok: true, value: { repos: [{ path: "/missing", id: "missing", remote: url }] } }), resolve: (_root, manifest) => manifest };
  s.deps.refresh = { refresh: async () => [{ url, freshness: { status: "verified" }, listing: { branches: [{ name: "main", sha: missingSha }], defaultBranch: "main" } }] };
  const result = await createWorkspaceReadOperation(s.deps).withRead({ repo: { path: "/app", id: "app", live: true } }, async (read) => {
    assert.equal(read.fact.status, "partial");
    assert.equal(read.fact.value.workspace.source, "persisted");
    assert.deepEqual(read.fact.value.workspace.repos, ["app", "missing"]);
    assert.deepEqual(read.fact.value.sections.missing?.snapshot, { repo: "missing", kind: "sha", sha: missingSha });
    assert.equal(read.fact.value.sections.missing?.status, "unknown");
    assert.deepEqual(read.fact.value.repositorySnapshots.map(({ repo }) => repo), ["app"]);
    return { ok: true, value: read.fact.snapshot };
  });
  assert.ok(result.ok);
  assert.equal(result.value.value.repo, "app");
  assert.deepEqual(result.value.workspaceReplay?.snapshots.map(({ repo, kind }) => ({ repo, kind })), [{ repo: "app", kind: "live" }, { repo: "missing", kind: "sha" }]);
  assert.deepEqual(result.value.workspaceReplay?.snapshots[1], { repo: "missing", kind: "sha", sha: missingSha });
});
