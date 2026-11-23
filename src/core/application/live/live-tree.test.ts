import { test } from "node:test";
import assert from "node:assert/strict";
import { pathSelection } from "../../domain/shared/scope.ts";
import { liveScope } from "../../domain/snapshot/live-export.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { CodeGraphFault, CodeGraphReader, IndexSummary } from "../../ports/code-graph.port.ts";
import type { IndexedSnapshot } from "../../ports/index-cache.port.ts";
import type { LiveStaleNotice } from "../../ports/live-queries.port.ts";
import { fakeLive, NOW, VERSIONS, type FakeLive } from "./fake-live.testing.ts";
import { openLive, type LiveTree } from "./live-tree.ts";

const SCOPE = liveScope();
const selected = pathSelection(SCOPE, () => false);

function query(fake: FakeLive, options: { store?: boolean; synthesized?: boolean; onStale?: (notice: LiveStaleNotice) => void; signal?: AbortSignal; declined?: () => boolean } = {}, use: (tree: LiveTree) => Promise<unknown> = async (tree) => tree) {
  return openLive(fake.deps, { repo: "/repo", scope: SCOPE, selected, store: options.store ?? true, synthesized: options.synthesized, onStale: options.onStale, signal: options.signal, declined: options.declined }, use);
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

test("a capture declined before the lock takes no lock and lists, reconciles and builds nothing; one not declined is refreshed as any other", async () => {
  const declined = fakeLive({ "src/A.java": "1" });

  const given = await query(declined, { declined: () => true });

  assert.equal(!given.ok && given.fault.kind, "unavailable");
  assert.deepEqual(declined.calls, []);
  assert.deepEqual(declined.held, { locks: 0, released: 0 });
  assert.equal(declined.state.current, null);

  const kept = fakeLive({ "src/A.java": "1" });
  let asked = 0;
  const answered = await query(kept, { declined: () => {
    asked += 1;
    return false;
  } });
  assert.ok(answered.ok);
  assert.equal(kept.builds, 1);
  assert.equal(asked, 2, "asked before the lock and once it is held");
});

test("a capture declined once its lock is held releases it before listing, reconciling or building anything", async () => {
  const fake = fakeLive({ "src/A.java": "1" });

  const given = await query(fake, { declined: () => fake.held.locks > 0 });

  assert.equal(!given.ok && given.fault.kind, "unavailable");
  assert.deepEqual(fake.calls, ["lock"]);
  assert.deepEqual(fake.held, { locks: 1, released: 1 });
  assert.equal(fake.builds, 0);
  assert.equal(fake.state.current, null);
});

test("the lock is released when the decline asked once it is held throws", async () => {
  const fake = fakeLive({ "src/A.java": "1" });

  await assert.rejects(query(fake, { declined: () => {
    if (fake.held.locks > 0) throw new Error("boom");
    return false;
  } }), /boom/);

  assert.deepEqual(fake.held, { locks: 1, released: 1 });
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
  const control = await tree(fakeLive({ "src/A.java": "1" }));
  const fake = fakeLive({ "src/A.java": "1" });
  const current = JSON.stringify(SCOPE);
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

  const swept: string[] = [];
  const discardIfIdle = fake.deps.mirror.discardIfIdle;
  fake.deps.mirror.discardIfIdle = async (location) => { swept.push(location.scope); return discardIfIdle(location); };

  const answered = await tree(fake);

  assert.equal(fake.locations[0]!.scope, current);
  assert.deepEqual(swept, ["unused"]);
  assert.deepEqual(fake.debrisRemoved, [["gone.state.json"]]);
  assert.equal(answered.stateId, control.stateId);
});

test("the sweep runs on a process's first answer and after a mirror is created, discarded or fully built, never after an unchanged or synced refresh", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  const sweeps = () => fake.calls.filter((call) => call === "usage").length;

  await tree(fake);
  assert.equal(sweeps(), 1, "the first answer creates the mirror");
  await tree(fake);
  fake.tree.set("src/A.java", "2");
  await tree(fake);
  assert.equal(sweeps(), 1, "an unchanged and a synced refresh change nothing the sweep measures");

  fake.openable.value = false;
  await tree(fake);
  fake.openable.value = true;
  assert.equal(sweeps(), 2, "a full build");

  fake.state.current = { ...fake.state.current!, versions: { ...VERSIONS, codegraph: "0.9.0" } };
  await tree(fake);
  assert.equal(sweeps(), 3, "a mirror of other engines discarded and created again");

  const another = await openLive({ ...fake.deps }, { repo: "/repo", scope: SCOPE, selected, store: true }, async () => undefined);
  assert.ok(another.ok);
  assert.equal(sweeps(), 4, "another process's first answer");
});

test("a sweep that could not measure the mirrors runs again on the next answer", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  fake.engine.usage = { ok: false, fault: { kind: "unreadable", detail: "cannot read the live directory" } };
  await tree(fake);
  fake.engine.usage = { ok: true, value: { scopes: [], debris: [] } };

  await tree(fake);
  await tree(fake);

  assert.equal(fake.calls.filter((call) => call === "usage").length, 2);
});

test("the lock covers the refresh and the pin, and the answer runs after its release on the store pinned under it", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  await tree(fake);
  fake.tree.set("src/A.java", "2");
  const seen: string[] = [];

  const answered = await openLive(fake.deps, { repo: "/repo", scope: SCOPE, selected, store: true }, async (pinnedTree, pinned: string) => {
    seen.push(`use:${fake.held.locks - fake.held.released}:${pinned}`);
    return pinnedTree.store !== undefined;
  }, async (pinnedTree) => {
    seen.push(`pin:${fake.held.locks - fake.held.released}:${fake.stores.opened}:${pinnedTree.store !== undefined}`);
    return "pinned";
  });

  assert.deepEqual(answered, { ok: true, value: true });
  assert.deepEqual(fake.syncs, [["src/A.java"]]);
  assert.deepEqual(seen, ["pin:1:2:true", "use:0:pinned"], "the pin runs with the lock held and the synced store open; the answer runs with it released");
  assert.equal(fake.openedAt.at(-1), fake.state.current?.storeGeneration, "the store is pinned at the generation the sync committed");
});

test("an unchanged store is pinned through the reader that proved it, shared by every reading of the answer and closed once the query returns", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  await tree(fake);
  fake.stores.opened = 0;
  fake.stores.closed = 0;

  const answered = await query(fake, {}, async (tree) => {
    tree.store?.close();
    tree.store?.close();
    return { ...fake.stores };
  });

  assert.deepEqual(answered, { ok: true, value: { opened: 1, closed: 0 } }, "closing the shared store closes nothing");
  assert.deepEqual(fake.stores, { opened: 1, closed: 1 });
});

test("the pinned store is closed whatever the answer does, a query that reads no store pins none, and none outlives a rebuild", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  await tree(fake);
  fake.stores.opened = 0;
  fake.stores.closed = 0;

  await assert.rejects(query(fake, {}, async () => { throw new Error("boom"); }));
  assert.deepEqual(fake.stores, { opened: 1, closed: 1 });
  const storeless = await query(fake, { store: false }, async (tree) => tree.store);
  assert.deepEqual([storeless, fake.stores], [{ ok: true, value: undefined }, { opened: 1, closed: 1 }]);

  fake.state.current = { ...fake.state.current!, unparsedSinceBuild: ["src/app.component.html"] };
  let pinned: unknown;
  const rebuilt = await query(fake, { synthesized: true }, async (tree) => { pinned = tree.store; return undefined; });

  assert.ok(rebuilt.ok);
  assert.ok(pinned !== undefined, "the store the rebuild committed is pinned");
  assert.equal(fake.builds, 2);
  assert.deepEqual(fake.stores, { opened: 3, closed: 3 }, "the reader opened before the build is closed, and the one pinned is opened after it");
  assert.equal(fake.openedAt.at(-1), fake.state.current?.storeGeneration);
});

test("a committed state that names no store generation does not serve: the store is rebuilt and pinned at the generation it commits", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  await tree(fake);
  fake.state.current = { ...fake.state.current!, storeGeneration: "" };
  const before = fake.openedAt.length;

  const answered = await query(fake, {}, async (tree) => tree.store !== undefined);

  assert.deepEqual(answered, { ok: true, value: true });
  assert.equal(fake.builds, 2);
  assert.deepEqual(fake.openedAt.slice(before), [fake.state.current?.storeGeneration]);
});

/** Runs a query, and answers its stateId, the generation it committed and the one it pinned the store at. */
async function generationOf(fake: FakeLive, options: { store?: boolean; synthesized?: boolean } = {}): Promise<{ stateId: string; committed: string | undefined; opened: (string | undefined)[] }> {
  const before = fake.openedAt.length;
  const answered = await query(fake, options, async (tree) => tree.stateId);
  assert.ok(answered.ok, JSON.stringify(answered));
  return { stateId: answered.value as string, committed: fake.state.current?.storeGeneration, opened: fake.openedAt.slice(before) };
}

test("every committed build or sync commits a new store generation, a full rebuild at an unchanged stateId too, and the answer reads the store at it", async () => {
  const fake = fakeLive({ "src/a.component.ts": "1", "src/a.component.html": "1" });
  const built = await generationOf(fake);
  fake.tree.set("src/a.component.html", "2");
  fake.engine.sync = { ok: true, value: { ...(fake.engine.sync.ok ? fake.engine.sync.value : (undefined as never)), filesUnparsed: ["src/a.component.html"] } };
  const synced = await generationOf(fake);
  const rebuilt = await generationOf(fake, { synthesized: true });
  const unchanged = await generationOf(fake);

  assert.equal(rebuilt.stateId, synced.stateId, "the rebuild keeps the stateId");
  assert.equal(fake.builds, 2);
  const committed = [built, synced, rebuilt].map(({ committed }) => committed);
  assert.ok(committed.every((generation) => generation !== undefined && generation !== ""));
  assert.equal(new Set(committed).size, 3);
  assert.deepEqual([built, synced, rebuilt].map(({ opened }) => opened.at(-1)), committed, "the store pinned is read at the generation just committed");
  assert.deepEqual([unchanged.committed, unchanged.opened], [rebuilt.committed, [rebuilt.committed]], "an unchanged store keeps its generation");
});

test("a refresh clears the generation while it writes the store and hands the worker the one committed before, and never opens the store at a generation while paths are pending", async () => {
  const fake = fakeLive({ "src/A.java": "1", "src/B.java": "1" });
  const first = (await generationOf(fake)).committed!;
  const written: [readonly string[], string][] = [];
  const write = fake.deps.mirror.writeState;
  fake.deps.mirror.writeState = (location, state) => {
    written.push([state.pending, state.storeGeneration]);
    return write(location, state);
  };

  fake.tree.set("src/A.java", "2");
  const second = await generationOf(fake);
  assert.deepEqual(written, [[["src/A.java"], ""], [[], second.committed]]);

  fake.tree.set("src/B.java", "2");
  const copied = await generationOf(fake, { store: false });
  assert.deepEqual([fake.state.current?.pending, copied.committed, copied.opened], [["src/B.java"], second.committed, []], "copying files keeps the generation of the store it left alone");
  const third = await generationOf(fake);
  assert.deepEqual(third.opened, [third.committed]);

  fake.state.current = { ...fake.state.current!, pending: ["src/A.java"], storeGeneration: "" };
  const recovered = await generationOf(fake);

  assert.deepEqual(fake.syncGenerations, [
    { held: first, next: second.committed },
    { held: second.committed, next: third.committed },
    { held: "", next: recovered.committed },
  ]);
  assert.deepEqual(recovered.opened, [recovered.committed]);
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

const KEPT_SUMMARY: IndexSummary = { filesIndexed: 1, filesSkipped: 0, filesErrored: 0, filesNotIndexed: [], versions: { codegraph: "1.0.0", schema: 11, extraction: 27 } };

/** An index cache that keeps every content it is asked for at `/kept/<content>`; closing the kept store is logged in the fake's calls. */
function withIndexes(fake: FakeLive, answer: Result<void, CodeGraphFault> = { ok: true, value: undefined }): { obtained: { content: string; snapshot: string }[] } {
  const kept = { obtained: [] as { content: string; snapshot: string }[] };
  fake.deps.indexes = {
    obtain: async ({ content, snapshot }): Promise<Result<IndexedSnapshot, CodeGraphFault>> => {
      kept.obtained.push({ content, snapshot });
      if (!answer.ok) return answer;
      const store = { close: () => void fake.calls.push("close-kept") } as unknown as CodeGraphReader;
      return { ok: true, value: { store, summary: KEPT_SUMMARY, directory: `/kept/${content}` } };
    },
  };
  return kept;
}

test("with an index cache, a full build copies the kept index of the tree's content into the mirror, builds nothing in place and releases the kept index only after the copy", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  const kept = withIndexes(fake);

  const first = await tree(fake);

  assert.deepEqual(kept.obtained, [{ content: first.stateId, snapshot: "/index" }]);
  assert.deepEqual(fake.adopted, [["/index", `/kept/${first.stateId}`]]);
  assert.equal(fake.builds, 0);
  assert.ok(fake.calls.indexOf("adoptMirror") < fake.calls.indexOf("close-kept"), "the lease outlives the copy");
  assert.deepEqual(first.origin, { kind: "full" });
  assert.equal(fake.state.current?.fullBuildStateId, first.stateId);
});

test("a sync never reaches the index cache, so a sync-derived store is never published", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  const kept = withIndexes(fake);
  await tree(fake);
  fake.tree.set("src/A.java", "2");

  const synced = await tree(fake);

  assert.equal(fake.syncs.length, 1);
  assert.deepEqual(synced.origin?.kind, "sync");
  assert.equal(kept.obtained.length, 1);
  assert.equal(fake.adopted.length, 1);
});

test("the full rebuild that replaces a sync the engine cannot do copies the kept index of the new content", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  const kept = withIndexes(fake);
  await tree(fake);
  fake.tree.set("src/A.java", "2");
  fake.engine.sync = { ok: false, fault: { kind: "index-failed", detail: "the engine cannot sync" } };

  const rebuilt = await tree(fake);

  assert.deepEqual(kept.obtained.map((asked) => asked.content), [kept.obtained[0]!.content, rebuilt.stateId]);
  assert.equal(fake.builds, 0);
  assert.deepEqual(rebuilt.origin, { kind: "full" });
});

test("a cache that cannot serve or a copy that fails builds the mirror in place, and an abort in either builds nothing", async () => {
  const cases: { name: string; obtain?: Result<void, CodeGraphFault>; adopt?: Result<IndexSummary, CodeGraphFault>; builds: number; answered: boolean }[] = [
    { name: "cache unavailable", obtain: { ok: false, fault: { kind: "cache-unavailable", detail: "refused" } }, builds: 1, answered: true },
    { name: "kept index build failed", obtain: { ok: false, fault: { kind: "index-failed", detail: "failed" } }, builds: 1, answered: true },
    { name: "copy failed", adopt: { ok: false, fault: { kind: "index-failed", detail: "copy failed" } }, builds: 1, answered: true },
    { name: "obtain aborted", obtain: { ok: false, fault: { kind: "aborted", detail: "aborted" } }, builds: 0, answered: false },
    { name: "copy aborted", adopt: { ok: false, fault: { kind: "aborted", detail: "aborted" } }, builds: 0, answered: false },
  ];
  for (const { name, obtain, adopt, builds, answered } of cases) {
    const fake = fakeLive({ "src/A.java": "1" });
    withIndexes(fake, obtain);
    if (adopt !== undefined) fake.engine.adopt = adopt;

    const outcome = await query(fake);

    assert.equal(outcome.ok, answered, name);
    if (!outcome.ok) assert.equal(outcome.fault.kind, "unavailable", name);
    assert.equal(fake.builds, builds, name);
    assert.equal(fake.calls.filter((call) => call === "close-kept").length, obtain === undefined ? 1 : 0, `${name}: the kept index is released`);
  }
});

test("a path a crashed refresh copied into the index tree and the export no longer writes is pruned before the store is refreshed", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  await tree(fake);
  fake.state.current = { ...fake.state.current!, pending: ["src/Gone.java"] };

  await tree(fake);

  assert.deepEqual(fake.pruned, [["src/Gone.java"]]);
  assert.deepEqual(fake.state.current?.pending, []);
});

test("a full build publishes the index tree only when it holds exactly the written files; one that departs or cannot be checked is built in place, unpublished, and a written file it lacks is not held", async () => {
  const cases: { name: string; verify: FakeLive["engine"]["verify"]; obtained: number; builds: number; notHeld?: string[]; answered: boolean }[] = [
    { name: "exact", verify: { ok: true, value: { missing: [], foreign: [] } }, obtained: 1, builds: 0, answered: true },
    { name: "foreign file", verify: { ok: true, value: { missing: [], foreign: ["src/Planted.java"] } }, obtained: 0, builds: 1, notHeld: [], answered: true },
    { name: "missing file", verify: { ok: true, value: { missing: ["src/B.java"], foreign: [] } }, obtained: 0, builds: 1, notHeld: ["src/B.java"], answered: true },
    { name: "unreadable tree", verify: { ok: false, fault: { kind: "unreadable", detail: "cannot read" } }, obtained: 0, builds: 1, notHeld: [], answered: true },
    { name: "aborted check", verify: { ok: false, fault: { kind: "aborted", detail: "aborted" } }, obtained: 0, builds: 0, answered: false },
  ];
  for (const { name, verify, obtained, builds, notHeld, answered } of cases) {
    const fake = fakeLive({ "src/A.java": "1", "src/B.java": "2", "src/A.spec.ts": "3" });
    const kept = withIndexes(fake);
    fake.engine.verify = verify;

    const outcome = await query(fake);

    assert.equal(outcome.ok, answered, name);
    assert.deepEqual(fake.verified, [[{ path: "src/A.java", blob: "1" }, { path: "src/B.java", blob: "2" }]], `${name}: the written files and their blobs are checked`);
    assert.equal(kept.obtained.length, obtained, name);
    assert.equal(fake.builds, builds, name);
    if (notHeld !== undefined) assert.deepEqual(fake.state.current?.notHeld, notHeld, name);
  }
});

test("a full build over a tree no staging refreshed is checked too: a planted state that names every written file, or a state whose store cannot be opened", async () => {
  const planted = fakeLive({ "src/A.java": "1" });
  const plantedKept = withIndexes(planted);
  await tree(planted);
  planted.state.current = { ...planted.state.current!, fullBuildStateId: "", storeGeneration: "" };
  const unreadable = fakeLive({ "src/A.java": "1" });
  const unreadableKept = withIndexes(unreadable);
  await tree(unreadable);
  unreadable.openable.value = false;

  for (const [name, fake, kept] of [["planted state", planted, plantedKept], ["unreadable store", unreadable, unreadableKept]] as const) {
    fake.engine.verify = { ok: true, value: { missing: [], foreign: ["src/Planted.java"] } };
    fake.staged.length = 0;
    fake.verified.length = 0;

    await tree(fake);

    assert.equal(fake.verified.length, 1, name);
    assert.equal(kept.obtained.length, 1, `${name}: only the first, exact build was published`);
    assert.equal(fake.builds, 1, `${name}: built in place`);
  }
  assert.deepEqual(planted.staged, [], "the planted state staged nothing");
});

test("discarding a mirror retires what the engine keeps running for it: a mirror built by other engines, and one the sweep discards", async () => {
  const fake = fakeLive({ "src/A.java": "1" });
  fake.deps.mirror.indexRoot = (location) => `/index/${location.scope}`;
  await tree(fake);
  fake.retired.length = 0;
  fake.state.current = { ...fake.state.current!, versions: { ...VERSIONS, codegraph: "0.9.0" } };
  const current = fake.locations[0]!.scope;

  await tree(fake);
  assert.deepEqual(fake.retired, [`/index/${current}`]);

  fake.engine.usage = { ok: true, value: { scopes: [{ scope: "other", versions: null, bytes: 1, lastUsedMs: NOW, locked: false }], debris: [] } };
  fake.state.current = { ...fake.state.current!, versions: { ...VERSIONS, codegraph: "0.9.0" } };
  await tree(fake);
  assert.deepEqual(fake.retired, [`/index/${current}`, `/index/${current}`, "/index/other"]);
});
