import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeLive } from "../live/fake-live.testing.ts";
import { withWorkspaceSnapshots } from "./workspace-snapshots.ts";
import type { WorkspacePlanningRequest } from "./workspace-plan.ts";

const sha = "a".repeat(40);
const url = "https://example.invalid/lib";
const request: WorkspacePlanningRequest = { repo: { path: "/app", id: "app" }, repos: [{ path: "/a", id: "a", live: true }, { path: "/b", id: "b", live: true }, { path: "/lib", id: "lib" }], scope: { include: ["src/**"] } };
function setup(options: { alias?: boolean; untrusted?: string; abort?: AbortController; abortTrust?: AbortController } = {}) {
  const fake = fakeLive({ "src/a.ts": "v1" });
  const events: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const deps: Parameters<typeof withWorkspaceSnapshots>[0] = {
    vcs: {
      canonicalRoot: async (path: string, signal?: AbortSignal) => { events.push(`canonical:${path}`); signals.push(signal); if (options.abort) options.abort.abort(); return { ok: true, value: options.alias && path === "/b" ? "/real/a" : `/real${path}` }; },
      resolveCommit: async (path: string, revision: string, signal?: AbortSignal) => { events.push(`resolve:${path}:${revision}`); signals.push(signal); return { ok: true, value: sha }; },
      remotes: async (path: string, signal?: AbortSignal) => { events.push(`remotes:${path}`); signals.push(signal); return { ok: true, value: [] }; },
      headBranch: async (_path: string, signal?: AbortSignal) => { signals.push(signal); return { ok: true, value: "main" }; },
      exportCommit: async () => assert.fail("preflight must not export sources"),
      repositoryName: async () => assert.fail("preflight must not read repository names"),
    },
    trust: { read: async (path: string) => { events.push(`trust:${path}`); if (path === "/real/a") options.abortTrust?.abort(); return { ok: true, value: path === options.untrusted ? "untrusted" : "trusted" }; } },
    defaults: { of: async () => ({ ok: true, value: { repos: [{ path: "/lib", id: "lib", remote: url }] } }), resolve: (_root, manifest) => manifest },
    refresh: { refresh: async (_: unknown, signal?: AbortSignal) => { events.push("refresh"); signals.push(signal); return [{ url, freshness: { status: "unverified", reason: "failed" }, listing: { branches: [] } }]; } },
    digest: { of: () => "b".repeat(64) }, matcher: { matches: () => true },
    scratch: { create: async () => "/scratch", remove: async () => undefined },
    reader: { read: async () => assert.fail("preflight must not load sources") },
    extractor: { extract: async () => assert.fail("preflight must not extract sources") },
    producer: { name: "test", version: "0" },
    graph: fake.deps.graph, live: fake.deps,
  };
  return { deps, events, signals, fake };
}
const run = (s: ReturnType<typeof setup>, req = request) => withWorkspaceSnapshots(s.deps, req, async ({ livePlans, plans }) => ({ ok: true, value: { livePlans, plans } }));

test("a HEAD change while acquiring a live lease refuses the capture and releases the lease", async () => {
  const s = setup();
  const resolveCommit = s.deps.vcs.resolveCommit;
  let changed = false;
  s.deps.vcs.resolveCommit = (repo, revision, signal) => changed && repo === "/real/a" && revision === "HEAD"
    ? Promise.resolve({ ok: true, value: "c".repeat(40) })
    : resolveCommit(repo, revision, signal);
  const lock = s.fake.deps.mirror.lock;
  s.fake.deps.mirror.lock = async (location, signal) => {
    if (location.repo === "/real/a") { changed = true; s.fake.tree.set("src/a.ts", "new commit"); }
    return lock(location, signal);
  };
  let used = false;
  const result = await withWorkspaceSnapshots(s.deps, request, async () => { used = true; return { ok: true, value: null }; });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.fault.kind, "workspace-capture-unavailable");
    if (result.fault.kind === "workspace-capture-unavailable") {
      assert.equal(result.fault.repo, "a");
      assert.equal(result.fault.cause.kind, "live-mirror-failed");
    }
  }
  assert.equal(used, false);
  assert.equal(s.fake.held.locks, 1);
  assert.equal(s.fake.held.released, 1);
});

test("all live canonical trusts precede authorized refresh and heads", async () => {
  const s = setup({ untrusted: "/real/b" });
  const result = await run(s);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.fault.kind, "live-requires-trusted");
  assert.ok(s.events.includes("trust:/real/a"));
  assert.ok(s.events.includes("trust:/real/b"));
  assert.ok(!s.events.some((e) => e === "refresh" || e.startsWith("resolve:") || e.startsWith("remotes:")));
});

test("canonical aliases fail with repository IDs before trust or refresh", async () => {
  const s = setup({ alias: true });
  const result = await run(s);
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.fault.kind, "duplicate-workspace-source"); assert.match(result.fault.detail, /a/); assert.match(result.fault.detail, /b/); assert.ok(!result.fault.detail.includes("/real")); }
  assert.ok(!s.events.some((e) => e.startsWith("trust:/real") || e === "refresh" || e.startsWith("resolve:") || e.startsWith("remotes:")));
});

test("distinct live roots yield preflight metadata after trust with the common signal", async () => {
  const s = setup();
  const controller = new AbortController();
  const result = await run(s, { ...request, signal: controller.signal });
  assert.ok(result.ok);
  const value = result.value.value;
  assert.deepEqual(value.livePlans.map(({ repoId, declared, canonical, head, trust }) => ({ repoId, declared, canonical, head, trust })), [
    { repoId: "a", declared: "/a", canonical: "/real/a", head: sha, trust: "trusted" },
    { repoId: "b", declared: "/b", canonical: "/real/b", head: sha, trust: "trusted" },
  ]);
  assert.equal(value.livePlans[0]?.scope.ignored, "git");
  assert.deepEqual(s.events.filter((e) => e.startsWith("canonical:")), ["canonical:/a", "canonical:/b"]);
  assert.ok(s.events.indexOf("trust:/real/b") < s.events.indexOf("refresh"));
  assert.ok(s.events.indexOf("refresh") < s.events.indexOf("resolve:/real/a:HEAD"));
  assert.ok(s.signals.every((signal) => signal === controller.signal));
  assert.ok(value.plans.some((plan) => plan.kind === "unavailable"));
});

test("cancellation during canonicalization prevents refresh and callback", async () => {
  const controller = new AbortController();
  const s = setup({ abort: controller });
  let called = false;
  const result = await withWorkspaceSnapshots(s.deps, { ...request, signal: controller.signal }, async () => { called = true; return { ok: true, value: null }; });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.fault.kind, "aborted");
  assert.equal(called, false);
  assert.ok(!s.events.includes("refresh"));
});

test("fresh live replay mismatch is rejected before callback", async () => {
  const s = setup();
  const replay = { version: 1 as const, declaration: `ws-r1:${"b".repeat(64)}`, snapshots: [
    { repo: "a", kind: "live" as const, head: "c".repeat(40), stateId: "old-state" },
    { repo: "app", kind: "sha" as const, sha },
    { repo: "b", kind: "live" as const, head: sha, stateId: "b-state" },
    { repo: "lib", kind: "sha" as const, sha },
  ] };
  let called = false;
  const result = await withWorkspaceSnapshots(s.deps, { ...request, replay, offline: true }, async () => { called = true; return { ok: true, value: null }; });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.fault.kind, "workspace-replay-mismatch");
  assert.equal(called, false);
  assert.equal(s.fake.held.released, 2);
});


test("cancellation during canonical trust prevents refresh and head resolution", async () => {
  const controller = new AbortController();
  const s = setup({ abortTrust: controller });
  const result = await run(s, { ...request, signal: controller.signal });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.fault.kind, "aborted");
  assert.ok(!s.events.some((event) => event === "refresh" || event.startsWith("resolve:")));
});

test("replay kind mismatch precedes canonical preflight and refresh", async () => {
  const s = setup();
  const replay = { version: 1 as const, declaration: `ws-r1:${"b".repeat(64)}`, snapshots: [
    { repo: "a", kind: "sha" as const, sha }, { repo: "app", kind: "sha" as const, sha },
    { repo: "b", kind: "live" as const, head: sha, stateId: "state" }, { repo: "lib", kind: "sha" as const, sha },
  ] };
  const result = await run(s, { ...request, replay });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.fault.kind, "workspace-replay-mismatch");
  assert.ok(!s.events.some((event) => event.startsWith("canonical:") || event === "refresh" || event.startsWith("resolve:")));
});


test("workspace callback runs with every selected live lease held", async () => {
  const s = setup();
  const fake = fakeLive({ "src/a.ts": "v1" });
  const deps = { ...s.deps, graph: fake.deps.graph, live: fake.deps };
  let observed = false;
  const result = await withWorkspaceSnapshots(deps, request, async (context) => {
    observed = true;
    assert.equal(fake.held.locks - fake.held.released, 2);
    assert.equal(context.liveCaptures.size, 2);
    return { ok: true, value: "read" };
  });
  assert.ok(result.ok);
  assert.equal(observed, true);
  assert.equal(fake.held.released, 2);
});

test("selected vector includes actual live states and unavailable committed pins", async () => {
  const s = setup();
  const signal = new AbortController().signal;
  const result = await withWorkspaceSnapshots(s.deps, { ...request, signal }, async (context) => {
    assert.equal(context.signal, signal);
    assert.equal(s.fake.held.locks - s.fake.held.released, 2);
    assert.strictEqual(context.liveCaptures.get("a"), context.liveCaptures.get("a"));
    return { ok: true, value: context.selectedSnapshots.map((item) => item.repo) };
  });
  assert.ok(result.ok);
  assert.deepEqual(result.value.value, ["a", "app", "b", "lib"]);
  assert.deepEqual(result.value.workspaceReplay?.snapshots.map(({ repo, kind }) => [repo, kind]), [["a", "live"], ["app", "sha"], ["b", "live"], ["lib", "sha"]]);
  assert.deepEqual(result.value.workspaceReplay?.snapshots.find((snapshot) => snapshot.repo === "lib"), { repo: "lib", kind: "sha", sha });
  assert.equal(s.fake.held.released, 2);
});

test("fresh replay matches and head or state changes fail before callback", async () => {
  const s = setup();
  const first = await withWorkspaceSnapshots(s.deps, request, async () => ({ ok: true, value: "ok" }));
  assert.ok(first.ok && first.value.workspaceReplay);
  const replay = first.value.workspaceReplay;
  const same = await withWorkspaceSnapshots(s.deps, { ...request, replay }, async () => ({ ok: true, value: "matched" }));
  assert.ok(same.ok);
  assert.equal(same.value.value, "matched");
  for (const field of ["head", "stateId"] as const) {
    const snapshots = replay.snapshots.map((snapshot) => snapshot.repo === "a" && snapshot.kind === "live" ? { ...snapshot, [field]: field === "head" ? "d".repeat(40) : "different-state" } : snapshot);
    let called = false;
    const before = s.fake.held.released;
    const result = await withWorkspaceSnapshots(s.deps, { ...request, replay: { ...replay, snapshots } }, async () => { called = true; return { ok: true, value: null }; });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.fault.kind, "workspace-replay-mismatch");
    assert.equal(called, false);
    assert.equal(s.fake.held.released - before, 2);
  }
});

test("stale notices are repository attributed and returned after all releases", async () => {
  const s = setup();
  const result = await withWorkspaceSnapshots(s.deps, request, async () => {
    s.fake.tree.set("src/a.ts", "changed");
    return { ok: true, value: "done" };
  });
  assert.ok(result.ok);
  assert.equal(s.fake.held.released, 2);
  assert.deepEqual(result.value.workspaceLive?.map((notice) => [notice.repo, notice.kind, notice.snapshot.repo]), [["a", "stale", "a"], ["b", "stale", "b"]]);
  assert.deepEqual(result.value.workspaceLive?.map((notice) => notice.kind === "stale" && notice.notice.changed), [["src/a.ts"], ["src/a.ts"]]);
});

test("staleness listing and comparison failures retain typed repository causes", async () => {
  const s = setup();
  const list = s.fake.deps.workingTree.list;
  s.fake.deps.workingTree.list = async (repo, signal) => s.fake.held.released > 0 && repo === "/real/a" ? { ok: false, fault: { kind: "object-missing", detail: "listing failed" } } : list(repo, signal);
  s.fake.deps.mirror.changedSince = async () => ({ ok: false, fault: { kind: "unreadable", detail: "stat failed" } });
  const result = await withWorkspaceSnapshots(s.deps, request, async () => ({ ok: true, value: "done" }));
  assert.ok(result.ok);
  assert.equal(s.fake.held.released, 2);
  assert.deepEqual(result.value.workspaceLive?.map((notice) => notice.kind === "staleness-unavailable" && [notice.repo, notice.snapshot.repo, notice.cause]), [
    ["a", "a", { kind: "object-missing", detail: "listing failed" }],
    ["b", "b", { kind: "live-mirror-failed", detail: "unreadable: stat failed" }],
  ]);
});

test("capture failure is repository attributed and releases earlier leases", async () => {
  const s = setup();
  const lock = s.fake.deps.mirror.lock;
  s.fake.deps.mirror.lock = async (location, signal) => location.repo === "/real/b" ? { ok: false, fault: { kind: "refused", detail: "lock refused" } } : lock(location, signal);
  let called = false;
  const result = await withWorkspaceSnapshots(s.deps, request, async () => { called = true; return { ok: true, value: null }; });
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.fault, { kind: "workspace-capture-unavailable", repo: "b", detail: "live capture unavailable", cause: { kind: "live-mirror-failed", detail: "refused: lock refused" } });
  assert.equal(called, false);
  assert.equal(s.fake.held.released, 1);
});

test("callback failure, throw and abort unwind all leases without success metadata", async () => {
  for (const action of ["fault", "throw", "abort"] as const) {
    const s = setup();
    const controller = new AbortController();
    const operation = withWorkspaceSnapshots(s.deps, { ...request, signal: controller.signal }, async () => {
      if (action === "throw") throw new Error("callback failed");
      if (action === "abort") controller.abort();
      return { ok: false as const, fault: { kind: "custom-fault" as const, code: 7 } };
    });
    if (action === "throw") await assert.rejects(operation, /callback failed/);
    else {
      const result = await operation;
      assert.equal(result.ok, false);
      if (!result.ok) assert.deepEqual(result.fault, action === "fault" ? { kind: "custom-fault", code: 7 } : { kind: "aborted", detail: "interrupted by the caller" });
    }
    assert.equal(s.fake.held.released, 2);
  }
});

test("a held live handle shares successful lazy sources and extraction", async () => {
  const s = setup();
  let reads = 0;
  let extracts = 0;
  s.deps.reader.read = async (_root, paths) => { reads++; return paths.map((path) => ({ path, content: "source" })); };
  s.deps.extractor.extract = async () => { extracts++; return []; };
  const signal = new AbortController().signal;
  const signals: (AbortSignal | undefined)[] = [];
  const lock = s.fake.deps.mirror.lock;
  s.fake.deps.mirror.lock = async (location, passed) => { signals.push(passed); return lock(location, passed); };
  const list = s.fake.deps.workingTree.list;
  s.fake.deps.workingTree.list = async (repo, passed) => { signals.push(passed); return list(repo, passed); };
  const result = await withWorkspaceSnapshots(s.deps, { ...request, signal }, async (context) => {
    const held = context.liveCaptures.get("a")!;
    assert.strictEqual(held, context.liveCaptures.get("a"));
    assert.equal((await held.sources(context.signal)).ok, true);
    assert.equal((await held.extract(context.signal)).ok, true);
    assert.equal((await held.extract(context.signal)).ok, true);
    return { ok: true, value: "done" };
  });
  assert.ok(result.ok);
  assert.equal(reads, 1);
  assert.equal(extracts, 1);
  assert.ok(signals.length > 0 && signals.every((passed) => passed === signal));
});

test("owned preparation cleanup finishes before a successful carrier is returned", async () => {
  const s = setup();
  let removed = false;
  s.deps.scratch.remove = async () => { assert.equal(s.fake.held.released, 2); removed = true; };
  const result = await withWorkspaceSnapshots(s.deps, request, async (context) => {
    const prepared = await context.preparation.obtain("test", s.deps, async () => ({ ok: false, fault: { kind: "git-failed", detail: "unused" } }));
    assert.equal(prepared.ok, false);
    assert.equal(removed, false);
    return { ok: true, value: "done" };
  });
  assert.ok(result.ok);
  assert.equal(removed, true);
});

test("capture listing failure retains the original VCS cause", async () => {
  const s = setup();
  const list = s.fake.deps.workingTree.list;
  s.fake.deps.workingTree.list = async (repo, signal) => repo === "/real/b" ? { ok: false, fault: { kind: "object-missing", detail: "listing unavailable" } } : list(repo, signal);
  const result = await withWorkspaceSnapshots(s.deps, request, async () => ({ ok: true, value: null }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.fault, { kind: "workspace-capture-unavailable", repo: "b", detail: "live capture unavailable", cause: { kind: "object-missing", detail: "listing unavailable" } });
  assert.equal(s.fake.held.released, 2);
});

test("a committed-only request needs no live graph or mirror", async () => {
  const s = setup();
  const { graph: _graph, live: _live, defaults: _defaults, ...committed } = s.deps;
  const result = await withWorkspaceSnapshots(committed, { repo: { path: "/app", id: "app" }, offline: true }, async ({ liveCaptures, selectedSnapshots }) => {
    assert.equal(liveCaptures.size, 0);
    return { ok: true, value: selectedSnapshots };
  });
  assert.ok(result.ok);
  assert.deepEqual(result.value.value, [{ repo: "app", kind: "sha", sha }]);
});


test("cancellation during owned cleanup returns no replay or successful carrier", async () => {
  const s = setup();
  const controller = new AbortController();
  let cleaned = false;
  s.deps.scratch.remove = async () => {
    assert.equal(s.fake.held.released, 2);
    cleaned = true;
    controller.abort();
  };
  const result = await withWorkspaceSnapshots(s.deps, { ...request, signal: controller.signal }, async (context) => {
    await context.preparation.obtain("cleanup-abort", s.deps, async () => ({ ok: false, fault: { kind: "git-failed", detail: "unused" } }));
    return { ok: true, value: "discard this answer" };
  });
  assert.equal(cleaned, true);
  assert.deepEqual(result, { ok: false, fault: { kind: "aborted", detail: "interrupted by the caller" } });
});
