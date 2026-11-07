import { test } from "node:test";
import assert from "node:assert/strict";
import { pathSelection } from "../../domain/shared/scope.ts";
import { liveScope } from "../../domain/snapshot/live-export.ts";
import type { LiveStaleNotice } from "../../ports/live-queries.port.ts";
import { fakeLive, NOW, VERSIONS, type FakeLive } from "./fake-live.testing.ts";
import { openLive, type LiveTree } from "./live-tree.ts";

const SCOPE = liveScope();
const selected = pathSelection(SCOPE, () => false);

function query(fake: FakeLive, options: { store?: boolean; synthesized?: boolean; onStale?: (notice: LiveStaleNotice) => void; signal?: AbortSignal } = {}, use: (tree: LiveTree) => Promise<unknown> = async (tree) => tree) {
  return openLive(fake.deps, { repo: "/repo", scope: SCOPE, selected, store: options.store ?? true, synthesized: options.synthesized, onStale: options.onStale, signal: options.signal }, use);
}

async function tree(fake: FakeLive, store = true, synthesized = false): Promise<LiveTree> {
  const answered = await query(fake, { store, synthesized });
  assert.ok(answered.ok, JSON.stringify(answered));
  return answered.value as LiveTree;
}

test("the first query holds the lock, builds the index in full, records the state and releases the lock", async () => {
  const fake = fakeLive({ "src/A.java": "1" });

  const first = await tree(fake);

  assert.equal(fake.builds, 1);
  assert.deepEqual(fake.syncs, []);
  assert.deepEqual(first.origin, { kind: "full" });
  assert.equal(fake.state.current?.fullBuildStateId, first.stateId);
  assert.deepEqual(fake.state.current?.pending, []);
  assert.deepEqual(fake.held, { locks: 1, released: 1 });
  assert.deepEqual(fake.deps.versions, VERSIONS);
});

test("a state that claims a completed build whose store cannot be opened rebuilds the scope in full", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  await tree(fake);
  fake.openable.value = false;

  const again = await tree(fake);

  assert.equal(fake.builds, 2, "the store the state named could not be opened, so the scope is built again");
  assert.deepEqual(fake.syncs, []);
  assert.deepEqual(again.origin, { kind: "full" });
  assert.equal(fake.state.current?.fullBuildStateId, again.stateId);
  assert.deepEqual(fake.state.current?.pending, []);
});

test("a second query with no edit runs no build and no sync", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  await tree(fake);
  const builds = fake.builds;

  const again = await tree(fake);

  assert.equal(fake.builds, builds);
  assert.deepEqual(fake.syncs, []);
  assert.deepEqual(again.origin, { kind: "full" });
});

test("an edit, an added file and a deleted file run sync with exactly those paths, deletions included", async () => {
  const fake = fakeLive({ "src/A.java": "1", "src/B.java": "1", "src/C.java": "1" });
  const first = await tree(fake);
  fake.tree.set("src/A.java", "2");
  fake.tree.set("src/D.java", "1");
  fake.tree.delete("src/C.java");

  const next = await tree(fake);

  assert.deepEqual(fake.syncs, [["src/A.java", "src/C.java", "src/D.java"]]);
  assert.equal(fake.builds, 1);
  assert.deepEqual(next.origin, { kind: "sync", base: first.stateId });
  assert.notEqual(next.stateId, first.stateId);
  assert.deepEqual(fake.state.current?.pending, []);
});

test("a query that reads synthesized edges builds in full once a sync took a file the engine does not parse", async () => {
  const fake = fakeLive({ "src/a.component.ts": "1", "src/a.component.html": "1" });
  await tree(fake);
  fake.tree.set("src/a.component.html", "2");
  fake.engine.sync = { ok: true, value: { ...(fake.engine.sync.ok ? fake.engine.sync.value : (undefined as never)), filesUnparsed: ["src/a.component.html"] } };
  await tree(fake);
  fake.tree.set("src/a.component.ts", "2");
  fake.engine.sync = { ok: true, value: { ...(fake.engine.sync.ok ? fake.engine.sync.value : (undefined as never)), filesUnparsed: [] } };
  await tree(fake);
  assert.deepEqual(fake.state.current?.unparsedSinceBuild, ["src/a.component.html"], "a later sync of sources only keeps the record");

  const rebuilt = await tree(fake, true, true);

  assert.equal(fake.builds, 2);
  assert.deepEqual(rebuilt.origin, { kind: "full" });
  assert.deepEqual(fake.state.current?.unparsedSinceBuild, []);
});

test("a query that reads synthesized edges builds in full when the sync it runs takes a file the engine does not parse", async () => {
  const fake = fakeLive({ "src/a.component.ts": "1", "src/a.component.html": "1" });
  await tree(fake);
  fake.tree.set("src/a.component.html", "2");
  fake.engine.sync = { ok: true, value: { ...(fake.engine.sync.ok ? fake.engine.sync.value : (undefined as never)), filesUnparsed: ["src/a.component.html"] } };

  const rebuilt = await tree(fake, true, true);

  assert.deepEqual(fake.syncs, [["src/a.component.html"]]);
  assert.equal(fake.builds, 2);
  assert.deepEqual(rebuilt.origin, { kind: "full" });
  assert.deepEqual(fake.state.current?.unparsedSinceBuild, []);
});

test("a query that reads no synthesized edge keeps the synced store over a file the engine does not parse", async () => {
  const fake = fakeLive({ "src/a.component.ts": "1", "src/a.component.html": "1" });
  const first = await tree(fake);
  fake.tree.set("src/a.component.html", "2");
  fake.engine.sync = { ok: true, value: { ...(fake.engine.sync.ok ? fake.engine.sync.value : (undefined as never)), filesUnparsed: ["src/a.component.html"] } };
  await tree(fake);

  const again = await tree(fake);

  assert.equal(fake.builds, 1);
  assert.deepEqual(again.origin, { kind: "sync", base: first.stateId });
  assert.deepEqual(again.unparsedSinceBuild, ["src/a.component.html"]);
});

test("a state built by other engines is discarded and the mirror is rebuilt in full", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  await tree(fake);
  fake.state.current = { ...fake.state.current!, versions: { ...VERSIONS, codegraph: "0.9.0" } };
  fake.calls.length = 0;
  const discard = fake.deps.mirror.discard;
  fake.deps.mirror.discard = async (location) => {
    assert.equal(fake.held.locks - fake.held.released, 1);
    return discard(location);
  };

  await tree(fake);

  assert.deepEqual(fake.calls.filter((call) => ["discard", "reconcile", "buildMirror"].includes(call)), ["discard", "reconcile", "buildMirror"]);
  assert.equal(fake.builds, 2);
});

test("the paths a crashed refresh left pending are synced by the next one", async () => {
  const fake = fakeLive({ "src/A.java": "1", "src/B.java": "1" });
  await tree(fake);
  fake.state.current = { ...fake.state.current!, pending: ["src/B.java"] };

  await tree(fake);

  assert.deepEqual(fake.syncs, [["src/B.java"]]);
  assert.deepEqual(fake.state.current?.pending, []);
});

test("a lock still held when the signal aborts, or a refresh cut by it, is unavailable and releases what it took", async () => {
  const held = fakeLive({ "src/A.java": "1" });
  held.engine.lock = { ok: false, fault: { kind: "aborted", detail: "waiting for the lock was aborted" } };
  const waited = await query(held);
  assert.equal(!waited.ok && waited.fault.kind, "unavailable");
  assert.equal(held.builds, 0);

  const cut = fakeLive({ "src/A.java": "1" });
  cut.engine.build = { ok: false, fault: { kind: "aborted", detail: "stopped" } };
  const built = await query(cut);
  assert.equal(!built.ok && built.fault.kind, "unavailable");
  assert.deepEqual(cut.held, { locks: 1, released: 1 });
  assert.equal(cut.state.current?.fullBuildStateId, "");
});

test("the lock is released when the answer throws", async () => {
  const fake = fakeLive({ "src/A.java": "1" });

  await assert.rejects(query(fake, {}, async () => Promise.reject(new Error("boom"))), /boom/);

  assert.deepEqual(fake.held, { locks: 1, released: 1 });
});

test("the files the store does not hold are the build's unindexed files plus the sync's failures", async () => {
  const fake = fakeLive({ "src/A.java": "1", "src/B.java": "1" });
  fake.engine.build = { ok: true, value: { ...fake.engine.build.ok ? fake.engine.build.value : (undefined as never), filesNotIndexed: ["src/Odd.java"] } };
  const first = await tree(fake);
  assert.deepEqual(first.notHeld, ["src/Odd.java"]);

  fake.tree.set("src/A.java", "2");
  fake.engine.sync = { ok: true, value: { ...(fake.engine.sync.ok ? fake.engine.sync.value : (undefined as never)), filesNotIndexed: ["src/Odd.java"], filesFailed: ["src/A.java"] } };
  const second = await tree(fake);

  assert.deepEqual(second.notHeld, ["src/A.java", "src/Odd.java"]);
  assert.deepEqual(fake.state.current?.notHeld, ["src/A.java", "src/Odd.java"]);
});

test("a sync the engine cannot do falls back to a full build of the mirror", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  await tree(fake);
  fake.tree.set("src/A.java", "2");
  fake.engine.sync = { ok: false, fault: { kind: "store-unreadable", detail: "damaged" } };

  const rebuilt = await tree(fake);

  assert.equal(fake.builds, 2);
  assert.deepEqual(rebuilt.origin, { kind: "full" });
});

test("a repository that is not sha1 is refused before anything is copied", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  fake.objectFormat.value = "sha256";

  const answered = await query(fake);

  assert.equal(!answered.ok && answered.fault.kind, "unsupported-object-format");
  assert.equal(fake.calls.includes("reconcile"), false);
  assert.deepEqual(fake.held, { locks: 1, released: 1 });
});

test("a query that reads no store copies the files and builds nothing; the next store query syncs what it skipped", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  const mapped = await tree(fake, false);
  assert.equal(fake.builds, 0);
  assert.equal(mapped.origin, undefined);
  assert.equal(fake.state.current?.fullBuildStateId, "");

  await tree(fake);
  assert.equal(fake.builds, 1);

  fake.tree.set("src/A.java", "2");
  await tree(fake, false);
  assert.deepEqual(fake.syncs, []);
  assert.deepEqual(fake.state.current?.pending, ["src/A.java"]);

  await tree(fake);
  assert.deepEqual(fake.syncs, [["src/A.java"]]);
});

test("the stateId is the digest of the listing's fingerprint, so equal listings give equal ids", async () => {
  const one = await tree(fakeLive({ "src/A.java": "1" }));
  const same = await tree(fakeLive({ "src/A.java": "1" }));
  const other = await tree(fakeLive({ "src/A.java": "2" }));

  assert.equal(one.stateId, same.stateId);
  assert.notEqual(one.stateId, other.stateId);
});

test("a JSON resource edit changes live state identity even when source declarations do not change", async () => {
  const before = await tree(fakeLive({ "src/A.java": "same", "src/data.json": "1" }));
  const after = await tree(fakeLive({ "src/A.java": "same", "src/data.json": "2" }));
  assert.notEqual(before.stateId, after.stateId);
});

test("an edit after the answer is built is reported as stale with the changed paths", async () => {
  const fake = fakeLive({ "src/A.java": "1", "src/B.java": "1" });
  const notices: LiveStaleNotice[] = [];

  const answered = await query(fake, { onStale: (notice) => notices.push(notice) }, async (held) => {
    fake.tree.set("src/B.java", "2");
    return held.stateId;
  });

  assert.ok(answered.ok);
  assert.deepEqual(notices, [{ stateId: answered.value, changed: ["src/B.java"] }]);
});

test("a tree that did not move after the answer is not reported", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  const notices: LiveStaleNotice[] = [];

  await query(fake, { onStale: (notice) => notices.push(notice) });

  assert.deepEqual(notices, []);
});

test("the listing is filtered by the scope's selection before it is mirrored", async () => {
  const fake = fakeLive({ "src/A.java": "1", "docs/readme.md": "1" });

  const only = await openLive(fake.deps, { repo: "/repo", scope: SCOPE, selected: (path) => path.startsWith("src/"), store: false }, async (held) => held);

  assert.ok(only.ok);
  assert.deepEqual(fake.state.current?.manifest.map((entry) => entry.path), ["src/A.java"]);
});

test("a sweep that cannot read the mirrors leaves the answer and its stateId as they were", async () => {
  const control = await tree(fakeLive({ "src/A.java": "1" }));
  const refused = fakeLive({ "src/A.java": "1" });
  refused.engine.usage = { ok: false, fault: { kind: "unreadable", detail: "cannot read the live directory" } };
  const thrown = fakeLive({ "src/A.java": "1" });
  thrown.deps.mirror.usage = async () => {
    throw new Error("boom");
  };

  const refusedTree = await tree(refused);
  const thrownTree = await tree(thrown);

  assert.equal(refusedTree.stateId, control.stateId);
  assert.equal(thrownTree.stateId, control.stateId);
  assert.deepEqual(refusedTree.export, control.export);
});

test("the sweep discards the mirrors the policy names, keeps the one being answered, and leaves the answer alone", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  const first = await tree(fake);
  fake.discarded.length = 0;
  const current = fake.locations[0]!.scope;
  const dayMs = 24 * 60 * 60 * 1000;
  fake.engine.usage = {
    ok: true,
    value: {
      scopes: [
        { scope: current, versions: VERSIONS, bytes: 0, lastUsedMs: NOW - 30 * dayMs, locked: false },
        { scope: "unused", versions: VERSIONS, bytes: 0, lastUsedMs: NOW - 30 * dayMs, locked: false },
      ],
      debris: ["gone.state.json"],
    },
  };

  const again = await tree(fake);

  assert.deepEqual(fake.discarded, ["unused"]);
  assert.equal(fake.calls.filter((call) => call === "discardIfIdle").length, 1);
  assert.deepEqual(fake.debrisRemoved, [["gone.state.json"]]);
  assert.equal(again.stateId, first.stateId);
});

test("every successful refresh touches the state, including one that writes nothing", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  await tree(fake);
  const writes = fake.calls.filter((call) => call === "writeState").length;

  await tree(fake);

  assert.equal(fake.calls.filter((call) => call === "writeState").length, writes);
  assert.equal(fake.touches, 2);

  fake.engine.touch = { ok: false, fault: { kind: "write-failed", detail: "read-only" } };
  const answered = await tree(fake);
  assert.equal(answered.stateId, fake.state.current?.stateId);
});

function clear(fake: FakeLive): void {
  fake.calls.length = 0;
  fake.staged.length = 0;
  fake.pruned.length = 0;
  fake.syncs.length = 0;
  fake.built.length = 0;
  fake.synced.length = 0;
}

test("the index tree holds only the paths the export writes, so a test file never reaches the engine", async () => {
  const fake = fakeLive({ "src/a.ts": "1", "src/a.spec.ts": "1", "README.md": "1" });

  const held = await tree(fake);

  assert.equal(held.root, "/index");
  assert.deepEqual(fake.built, ["/index"]);
  assert.deepEqual(fake.staged, [["src/a.ts"]]);
  assert.deepEqual(fake.state.current?.indexed, ["src/a.ts"]);
});

test("an edit, an added and a deleted map-scope file reach the index tree and its store, and a non-map edit reaches neither", async () => {
  const fake = fakeLive({ "src/a.ts": "1", "src/b.ts": "1", "README.md": "1" });
  await tree(fake);
  clear(fake);

  fake.tree.set("src/a.ts", "2");
  fake.tree.set("src/c.ts", "1");
  fake.tree.delete("src/b.ts");
  const edited = await tree(fake);

  assert.deepEqual(fake.staged, [["src/a.ts", "src/c.ts"]]);
  assert.deepEqual(fake.pruned, [["src/b.ts"]]);
  assert.deepEqual(fake.synced, ["/index"]);
  assert.deepEqual(fake.syncs, [["src/a.ts", "src/b.ts", "src/c.ts"]]);
  assert.deepEqual(fake.state.current?.indexed, ["src/a.ts", "src/c.ts"]);
  assert.equal(edited.root, "/index");

  clear(fake);
  fake.tree.set("README.md", "2");
  await tree(fake);

  assert.deepEqual([fake.staged, fake.pruned, fake.syncs, fake.builds], [[], [], [], 1]);
});

test("a query that reads no store stages no index tree and reads the mirror itself", async () => {
  const fake = fakeLive({ "src/a.ts": "1", "src/a.spec.ts": "1" });

  const mapped = await tree(fake, false);

  assert.equal(mapped.root, "/mirror");
  assert.deepEqual(fake.staged, []);
  assert.deepEqual(fake.built, []);
});

test("a state the mirror cannot read as one discards the mirror and rebuilds the store in full exactly once", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  fake.state.current = null;

  const first = await tree(fake);

  assert.deepEqual(fake.calls.filter((call) => ["discard", "buildMirror"].includes(call)), ["discard", "buildMirror"]);
  assert.deepEqual(first.origin, { kind: "full" });
  clear(fake);

  await tree(fake);

  assert.deepEqual(fake.calls.filter((call) => ["discard", "buildMirror"].includes(call)), []);
});

test("a store whose sync cannot run is rebuilt in full over the index tree", async () => {
  const fake = fakeLive({ "src/a.ts": "1", "src/a.spec.ts": "1" });
  await tree(fake);
  clear(fake);
  fake.tree.set("src/a.ts", "2");
  fake.engine.sync = { ok: false, fault: { kind: "store-unreadable", detail: "damaged" } };
  fake.engine.build = { ok: true, value: { ...(fake.engine.build.ok ? fake.engine.build.value : (undefined as never)), filesNotIndexed: [] } };

  await tree(fake);

  assert.deepEqual(fake.built, ["/index"]);
  assert.deepEqual(fake.state.current?.indexed, ["src/a.ts"]);
});

test("postlude reports listing and comparison faults after release before returning", async () => {
  for (const stage of ["listing", "comparison"] as const) {
    const fake = fakeLive({ "src/A.java": "1" });
    const fault = { kind: "unreadable" as const, detail: stage };
    const list = fake.deps.workingTree.list;
    let lists = 0;
    fake.deps.workingTree.list = async (...args) => ++lists === 2 && stage === "listing" ? { ok: false, fault } : list(...args);
    if (stage === "comparison") fake.deps.mirror.changedSince = async () => ({ ok: false, fault });
    const notices: unknown[] = [];
    let stateId = "";
    const answer = await openLive(fake.deps, { repo: "/repo", scope: SCOPE, selected, store: false, onStalenessUnavailable: async (notice) => {
      assert.equal(fake.held.released, 1);
      await Promise.resolve();
      notices.push(notice);
    } }, async (held) => { stateId = held.stateId; return 42; });
    assert.ok(answer.ok);
    assert.deepEqual(notices, [{ stage, stateId, cause: fault }]);
  }
});

test("actual cancellation at each live lifecycle boundary prevents success and notices", async () => {
  for (const stage of ["before", "lock", "refresh", "callback", "listing", "comparison", "sweep"] as const) {
    const fake = fakeLive({ "src/A.java": "1" });
    const controller = new AbortController();
    const lock = fake.deps.mirror.lock;
    fake.deps.mirror.lock = async (...args) => { const result = await lock(...args); if (stage === "lock") controller.abort(); return result; };
    const list = fake.deps.workingTree.list;
    let lists = 0;
    fake.deps.workingTree.list = async (...args) => { const result = await list(...args); lists++; if ((stage === "refresh" && lists === 1) || (stage === "listing" && lists === 2)) controller.abort(); return result; };
    const compare = fake.deps.mirror.changedSince;
    fake.deps.mirror.changedSince = async (...args) => { const result = await compare(...args); if (stage === "comparison") controller.abort(); return result; };
    const usage = fake.deps.mirror.usage;
    fake.deps.mirror.usage = async (...args) => { const result = await usage(...args); if (stage === "sweep") controller.abort(); return result; };
    if (stage === "before") controller.abort();
    const notices: unknown[] = [];
    const result = await openLive(fake.deps, { repo: "/repo", scope: SCOPE, selected, store: false, signal: controller.signal, onStale: (n) => notices.push(n), onStalenessUnavailable: (n) => { notices.push(n); } }, async () => { if (stage === "callback") controller.abort(); return 42; });
    assert.equal(!result.ok && result.fault.kind, "aborted", stage);
    assert.deepEqual(notices, [], stage);
    assert.equal(fake.held.locks, fake.held.released, stage);
  }
});

test("a throwing postlude hook propagates after releasing the lock", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  fake.deps.mirror.changedSince = async () => ({ ok: false, fault: { kind: "unreadable", detail: "failed" } });
  await assert.rejects(openLive(fake.deps, { repo: "/repo", scope: SCOPE, selected, store: false, onStalenessUnavailable: () => { throw new Error("hook"); } }, async () => 42), /hook/);
  assert.equal(fake.held.locks, fake.held.released);
});

test("cancellation overrides returned acquisition and postlude failures without notification", async () => {
  for (const stage of ["lock", "refresh", "listing", "comparison"] as const) {
    const fake = fakeLive({ "src/A.java": "1" });
    const controller = new AbortController();
    const fault = { kind: "aborted" as const, detail: "cancelled" };
    if (stage === "lock") fake.deps.mirror.lock = async () => { controller.abort(); return { ok: false, fault }; };
    const list = fake.deps.workingTree.list;
    let lists = 0;
    fake.deps.workingTree.list = async (...args) => {
      lists++;
      if ((stage === "refresh" && lists === 1) || (stage === "listing" && lists === 2)) { controller.abort(); return { ok: false, fault }; }
      return list(...args);
    };
    if (stage === "comparison") fake.deps.mirror.changedSince = async () => { controller.abort(); return { ok: false, fault }; };
    const notices: unknown[] = [];
    const result = await openLive(fake.deps, { repo: "/repo", scope: SCOPE, selected, store: false, signal: controller.signal, onStale: (n) => notices.push(n), onStalenessUnavailable: (n) => { notices.push(n); } }, async () => 42);
    assert.equal(!result.ok && result.fault.kind, "aborted", stage);
    assert.deepEqual(notices, [], stage);
    assert.equal(fake.held.locks, fake.held.released, stage);
  }
});

test("cancellation inside an awaited failure notification prevents success", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  const controller = new AbortController();
  fake.deps.mirror.changedSince = async () => ({ ok: false, fault: { kind: "unreadable", detail: "failed" } });
  const result = await openLive(fake.deps, { repo: "/repo", scope: SCOPE, selected, store: false, signal: controller.signal, onStalenessUnavailable: async () => { await Promise.resolve(); controller.abort(); } }, async () => 42);
  assert.equal(!result.ok && result.fault.kind, "aborted");
  assert.equal(fake.held.locks, fake.held.released);
});

test("cancellation during release overrides an earlier refresh failure", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  const controller = new AbortController();
  fake.objectFormat.value = "sha256";
  const lock = fake.deps.mirror.lock;
  fake.deps.mirror.lock = async (...args) => {
    const result = await lock(...args);
    if (!result.ok) return result;
    const release = result.value.release;
    return { ok: true, value: { release: async () => { await release(); controller.abort(); } } };
  };
  const result = await query(fake, { signal: controller.signal });
  assert.equal(!result.ok && result.fault.kind, "aborted");
  assert.equal(fake.held.locks, fake.held.released);
});
