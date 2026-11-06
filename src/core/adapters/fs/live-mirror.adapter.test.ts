import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "../../domain/shared/result.ts";
import type { MirrorEntry, MirrorFault, MirrorLocation, MirrorState } from "../../ports/live-mirror.port.ts";
import type { WorkingTreePath } from "../../ports/working-tree.port.ts";
import { isWritten } from "../../domain/snapshot/live-export.ts";
import { createLiveMirror, defaultLiveMirrorDeps } from "./live-mirror.adapter.ts";
import type { LiveMirrorDeps } from "./live-mirror.adapter.ts";

let scratch: string;
let counter = 0;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "ye-ast-live-mirror-"));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function fresh(): Promise<{ repo: string; location: MirrorLocation }> {
  counter += 1;
  const repo = join(scratch, `case-${counter}`, "repo");
  await mkdir(repo, { recursive: true });
  return { repo, location: { repo, scope: "default" } };
}

const listed = (...paths: string[]): WorkingTreePath[] => paths.map((path) => ({ path, submodule: false }));

function faultKind<T>(result: Result<T, MirrorFault>): string | undefined {
  return result.ok ? undefined : result.fault.kind;
}

function ok<T>(result: Result<T, MirrorFault>): T {
  assert.equal(result.ok, true, result.ok ? "" : result.fault.detail);
  return (result as { ok: true; value: T }).value;
}

const state = (manifest: readonly MirrorEntry[] = []): MirrorState => ({
  versions: { codegraph: "1.0.0", store: "11.27", staging: "1" },
  manifest,
  skipped: [{ path: "link", reason: "symlink" }],
  notHeld: ["a.bin"],
  indexed: ["a.ts"],
  fullBuildStateId: "full",
  stateId: "state",
  pending: ["b.ts"],
});

test("the mirror root is under the repository's store directory, per scope", async () => {
  const { repo, location } = await fresh();
  assert.equal(createLiveMirror().root(location), join(repo, ".ye-ast-graph", "live", "default"));
});

test("the index tree sits under the mirror's engine directory, so the mirror's own listing never reaches it", async () => {
  const { repo, location } = await fresh();
  await writeFile(join(repo, "a.ts"), "a");
  const mirror = createLiveMirror();
  ok(await mirror.reconcile(location, listed("a.ts"), [], []));

  assert.equal(mirror.indexRoot(location), join(repo, ".ye-ast-graph", "live", "default", ".ye-ast-graph", "index-tree"));

  ok(await mirror.materialize(location, ["a.ts"], mirror.indexRoot(location)));
  assert.equal(await readFile(join(mirror.indexRoot(location), "a.ts"), "utf8"), "a");
  assert.deepEqual(ok(await mirror.reconcile(location, listed("a.ts"), [], [])).manifest.map((entry) => entry.path), ["a.ts"]);
  assert.equal(await readFile(join(mirror.indexRoot(location), "a.ts"), "utf8"), "a");
});

test("prune removes the paths it is given and the directories they empty, and leaves the store and the mirror alone", async () => {
  const { repo, location } = await fresh();
  await mkdir(join(repo, "deep", "gone"), { recursive: true });
  await writeFile(join(repo, "deep", "gone", "x.ts"), "x");
  await writeFile(join(repo, "keep.ts"), "k");
  const mirror = createLiveMirror();
  ok(await mirror.reconcile(location, listed("deep/gone/x.ts", "keep.ts"), [], []));
  const index = mirror.indexRoot(location);
  ok(await mirror.materialize(location, ["deep/gone/x.ts", "keep.ts"], index));
  await mkdir(join(index, ".ye-ast-graph"));
  await writeFile(join(index, ".ye-ast-graph", "engine.db"), "db");

  ok(await mirror.prune(location, ["deep/gone/x.ts", "missing.ts", "../escape"]));

  await assert.rejects(lstat(join(index, "deep")));
  assert.equal(await readFile(join(index, "keep.ts"), "utf8"), "k");
  assert.equal(await readFile(join(index, ".ye-ast-graph", "engine.db"), "utf8"), "db");
  assert.equal(await readFile(join(mirror.root(location), "deep", "gone", "x.ts"), "utf8"), "x");
});

test("prune of a mirror that does not exist succeeds and an aborted signal answers aborted", async () => {
  const { location } = await fresh();
  const mirror = createLiveMirror();
  assert.deepEqual(await mirror.prune(location, ["a.ts"]), { ok: true, value: undefined });

  const deleted = await fresh();
  await writeFile(join(deleted.repo, "a.ts"), "a");
  ok(await mirror.reconcile(deleted.location, listed("a.ts"), [], []));
  ok(await mirror.materialize(deleted.location, ["a.ts"], mirror.indexRoot(deleted.location)));
  const controller = new AbortController();
  controller.abort();
  assert.equal(faultKind(await mirror.prune(deleted.location, ["a.ts"], controller.signal)), "aborted");
});

test("reconcile copies listed files, records their git blob ids and answers sorted", async () => {
  const { repo, location } = await fresh();
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "src", "b.ts"), "export const b = 1;\n");
  await writeFile(join(repo, "a.ts"), "export const a = 1;\n");
  const mirror = createLiveMirror();

  const result = ok(await mirror.reconcile(location, listed("src/b.ts", "a.ts"), [], []));

  assert.deepEqual(result.manifest.map((entry) => entry.path), ["a.ts", "src/b.ts"]);
  assert.deepEqual(result.changed, ["a.ts", "src/b.ts"]);
  assert.equal(await readFile(join(mirror.root(location), "src", "b.ts"), "utf8"), "export const b = 1;\n");
});

test("a path the export does not write is fingerprinted but never copied", async () => {
  const { repo, location } = await fresh();
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "src", "A.java"), "class A {}\n");
  await writeFile(join(repo, "NOTES.md"), "# notes\n");
  const mirror = createLiveMirror({ ...defaultLiveMirrorDeps, writes: isWritten });

  const result = ok(await mirror.reconcile(location, listed("src/A.java", "NOTES.md"), [], []));

  assert.deepEqual(result.manifest.map((entry) => entry.path), ["NOTES.md", "src/A.java"]);
  assert.equal(await readFile(join(mirror.root(location), "src", "A.java"), "utf8"), "class A {}\n");
  await assert.rejects(lstat(join(mirror.root(location), "NOTES.md")), /ENOENT/);
});

test("a blob id equals git hash-object for the same bytes", async () => {
  const { repo, location } = await fresh();
  const bytes = Buffer.from([0, 1, 2, 255, 10, 13, 0]);
  await writeFile(join(repo, "f.bin"), bytes);

  const { manifest } = ok(await createLiveMirror().reconcile(location, listed("f.bin"), [], []));

  const expected = execFileSync("git", ["hash-object", join(repo, "f.bin")], { encoding: "utf8" }).trim();
  assert.equal(manifest[0]!.blob, expected);
  assert.equal(manifest[0]!.size, bytes.length);
});

test("an unchanged second reconcile copies nothing and changes nothing", async () => {
  const { repo, location } = await fresh();
  await writeFile(join(repo, "a.ts"), "a");
  const copies: string[] = [];
  const mirror = createLiveMirror({ ...defaultLiveMirrorDeps, copyFile: async (from, to) => { copies.push(from); await defaultLiveMirrorDeps.copyFile(from, to); } });
  const first = ok(await mirror.reconcile(location, listed("a.ts"), [], []));

  const second = ok(await mirror.reconcile(location, listed("a.ts"), first.manifest, []));

  assert.equal(copies.length, 1);
  assert.deepEqual(second.changed, []);
  assert.deepEqual(second.manifest, first.manifest);
});

test("a same-size edit with a new modification time is copied again", async () => {
  const { repo, location } = await fresh();
  await writeFile(join(repo, "a.ts"), "one");
  await utimes(join(repo, "a.ts"), 1_000_000, 1_000_000);
  const mirror = createLiveMirror();
  const first = ok(await mirror.reconcile(location, listed("a.ts"), [], []));
  await writeFile(join(repo, "a.ts"), "two");
  await utimes(join(repo, "a.ts"), 2_000_000, 2_000_000);

  const second = ok(await mirror.reconcile(location, listed("a.ts"), first.manifest, []));

  assert.deepEqual(second.changed, ["a.ts"]);
  assert.equal(await readFile(join(mirror.root(location), "a.ts"), "utf8"), "two");
});

test("changedSince names the edited, added and gone paths by stat alone and writes nothing", async () => {
  const { repo, location } = await fresh();
  for (const name of ["kept.ts", "edited.ts", "gone.ts"]) await writeFile(join(repo, name), name);
  const mirror = createLiveMirror();
  const first = ok(await mirror.reconcile(location, listed("edited.ts", "gone.ts", "kept.ts"), [], []));
  await writeFile(join(repo, "edited.ts"), "edited.ts and more");
  await writeFile(join(repo, "added.ts"), "new");
  await rm(join(repo, "gone.ts"));
  const before = await readdir(repo);

  const changed = ok(await mirror.changedSince(location, listed("added.ts", "edited.ts", "gone.ts", "kept.ts"), first, undefined));
  const unlisted = ok(await mirror.changedSince(location, listed("added.ts", "edited.ts", "kept.ts"), first, undefined));

  assert.deepEqual(changed, ["added.ts", "edited.ts", "gone.ts"]);
  assert.deepEqual(unlisted, ["added.ts", "edited.ts", "gone.ts"]);
  assert.deepEqual(ok(await mirror.changedSince(location, listed("kept.ts"), { manifest: first.manifest.filter((entry) => entry.path === "kept.ts"), skipped: [] }, undefined)), []);
  assert.deepEqual(await readdir(repo), before);
});

test("changedSince ignores a tracked path that is absent from the disk and the mirror, and a skipped link that is still one", async () => {
  const { repo, location } = await fresh();
  await writeFile(join(repo, "target"), "t");
  await symlink("target", join(repo, "link"));
  const mirror = createLiveMirror();
  const first = ok(await mirror.reconcile(location, listed("link", "missing.ts"), [], []));

  assert.deepEqual(ok(await mirror.changedSince(location, listed("link", "missing.ts"), first, undefined)), []);
  await rm(join(repo, "link"));
  await writeFile(join(repo, "link"), "now a file");
  assert.deepEqual(ok(await mirror.changedSince(location, listed("link", "missing.ts"), first, undefined)), ["link"]);
});

test("materialize copies the mirror's version of the listed paths and leaves out those it does not hold", async () => {
  const { repo, location } = await fresh();
  await mkdir(join(repo, "sub"));
  await writeFile(join(repo, "sub", "a.ts"), "a");
  await writeFile(join(repo, "b.ts"), "b");
  await writeFile(join(repo, ".gitignore"), "x");
  const mirror = createLiveMirror();
  ok(await mirror.reconcile(location, listed("sub/a.ts", "b.ts", ".gitignore"), [], []));
  const destination = join(repo, "..", "out");
  await mkdir(destination);

  ok(await mirror.materialize(location, ["sub/a.ts", ".gitignore", "missing.ts", "../escape"], destination));

  assert.equal(await readFile(join(destination, "sub", "a.ts"), "utf8"), "a");
  assert.deepEqual((await readdir(destination)).sort(), ["sub"]);
});

test("a forced path is copied again whatever its stat says", async () => {
  const { repo, location } = await fresh();
  await writeFile(join(repo, "a.ts"), "a");
  const copies: string[] = [];
  const mirror = createLiveMirror({ ...defaultLiveMirrorDeps, copyFile: async (from, to) => { copies.push(from); await defaultLiveMirrorDeps.copyFile(from, to); } });
  const first = ok(await mirror.reconcile(location, listed("a.ts"), [], []));

  ok(await mirror.reconcile(location, listed("a.ts"), first.manifest, ["a.ts"]));

  assert.equal(copies.length, 2);
});

test("a path no longer present is deleted from the mirror with its empty parents", async () => {
  const { repo, location } = await fresh();
  await mkdir(join(repo, "d", "e"), { recursive: true });
  await writeFile(join(repo, "d", "e", "x.ts"), "x");
  await writeFile(join(repo, "keep.ts"), "k");
  const mirror = createLiveMirror();
  const first = ok(await mirror.reconcile(location, listed("d/e/x.ts", "keep.ts"), [], []));
  await rm(join(repo, "d", "e", "x.ts"));

  const second = ok(await mirror.reconcile(location, listed("keep.ts"), first.manifest, []));

  assert.deepEqual(second.manifest.map((entry) => entry.path), ["keep.ts"]);
  assert.deepEqual(second.changed, ["d/e/x.ts"]);
  assert.deepEqual(await readdir(mirror.root(location)), ["keep.ts"]);
});

test("a symbolic link to a file outside the root is skipped and its target never read", async () => {
  const { repo, location } = await fresh();
  const outside = join(repo, "..", "secret.txt");
  await writeFile(outside, "secret");
  await chmod(outside, 0o000);
  await symlink(outside, join(repo, "link.txt"));
  const copied: string[] = [];
  const mirror = createLiveMirror({ ...defaultLiveMirrorDeps, copyFile: async (from, to) => { copied.push(from); await defaultLiveMirrorDeps.copyFile(from, to); } });

  const result = ok(await mirror.reconcile(location, listed("link.txt"), [], []));

  assert.deepEqual(result.skipped, [{ path: "link.txt", reason: "symlink" }]);
  assert.deepEqual(result.manifest, []);
  assert.deepEqual(copied, []);
  await chmod(outside, 0o600);
});

test("a path under a directory that is a link to outside the root is skipped as a symlink", async () => {
  const { repo, location } = await fresh();
  const outside = join(repo, "..", "outside");
  await mkdir(outside);
  await writeFile(join(outside, "b.ts"), "outside");
  await symlink(outside, join(repo, "a"));

  const result = ok(await createLiveMirror().reconcile(location, listed("a/b.ts"), [], []));

  assert.deepEqual(result.skipped, [{ path: "a/b.ts", reason: "symlink" }]);
  assert.deepEqual(result.manifest, []);
});

test("a submodule and an unsafe path are skipped with the export's reasons and never read", async () => {
  const { location } = await fresh();
  const paths: WorkingTreePath[] = [{ path: "sub", submodule: true }, { path: "../x", submodule: false }, { path: "/etc/passwd", submodule: false }, { path: "a//b", submodule: false }, { path: "a\\b", submodule: false }, { path: "a\0b", submodule: false }, { path: "", submodule: false }];

  const result = ok(await createLiveMirror().reconcile(location, paths, [], []));

  assert.deepEqual(result.skipped.map((entry) => entry.reason).sort(), ["submodule", "unsafe-path", "unsafe-path", "unsafe-path", "unsafe-path", "unsafe-path", "unsafe-path"]);
  assert.deepEqual(result.manifest, []);
});

test("a listed path that is not a regular file is skipped, never opened", async () => {
  const { repo, location } = await fresh();
  await mkdir(join(repo, "dir"));

  const result = ok(await createLiveMirror().reconcile(location, listed("dir"), [], []));

  assert.deepEqual(result.manifest, []);
  assert.deepEqual(result.skipped, [{ path: "dir", reason: "unsafe-path" }]);
});

test("a path missing from the working tree is left out of the manifest", async () => {
  const { location } = await fresh();
  const result = ok(await createLiveMirror().reconcile(location, listed("gone.ts"), [], []));
  assert.deepEqual(result, { manifest: [], skipped: [], changed: [] });
});

test(".gitignore and codegraph.json are recorded in the manifest but absent from the mirror", async () => {
  const { repo, location } = await fresh();
  await mkdir(join(repo, "sub"));
  await writeFile(join(repo, ".gitignore"), "dist\n");
  await writeFile(join(repo, "sub", ".gitignore"), "x\n");
  await writeFile(join(repo, "codegraph.json"), "{}");
  const mirror = createLiveMirror();

  const result = ok(await mirror.reconcile(location, listed(".gitignore", "sub/.gitignore", "codegraph.json"), [], []));

  assert.deepEqual(result.manifest.map((entry) => entry.path), [".gitignore", "codegraph.json", "sub/.gitignore"]);
  assert.equal(result.manifest[0]!.blob, execFileSync("git", ["hash-object", join(repo, ".gitignore")], { encoding: "utf8" }).trim());
  assert.deepEqual(await readdir(mirror.root(location)), []);
});

test("the engine's store inside the mirror is neither listed nor deleted by reconcile", async () => {
  const { repo, location } = await fresh();
  await writeFile(join(repo, "a.ts"), "a");
  const mirror = createLiveMirror();
  ok(await mirror.reconcile(location, listed("a.ts"), [], []));
  await mkdir(join(mirror.root(location), ".ye-ast-graph"));
  await writeFile(join(mirror.root(location), ".ye-ast-graph", "engine.db"), "db");

  const first = ok(await mirror.reconcile(location, [], [], []));

  assert.deepEqual(first.manifest, []);
  assert.equal(await readFile(join(mirror.root(location), ".ye-ast-graph", "engine.db"), "utf8"), "db");
});

test("a file that changes while it is copied is copied once more, then refused as unreadable", async () => {
  const { repo, location } = await fresh();
  const target = join(repo, "a.ts");
  await writeFile(target, "start");
  let calls = 0;
  const once: LiveMirrorDeps = { ...defaultLiveMirrorDeps, copyFile: async (from, to) => { calls += 1; if (calls === 1) await writeFile(target, "changed!"); await defaultLiveMirrorDeps.copyFile(from, to); } };
  const recovered = ok(await createLiveMirror(once).reconcile(location, listed("a.ts"), [], []));
  assert.equal(recovered.manifest[0]!.size, "changed!".length);

  let tick = 0;
  const always: LiveMirrorDeps = { ...defaultLiveMirrorDeps, copyFile: async (from, to) => { tick += 1; await writeFile(target, `v${"x".repeat(tick)}`); await defaultLiveMirrorDeps.copyFile(from, to); } };
  const refused = await createLiveMirror(always).reconcile(location, listed("a.ts"), [], ["a.ts"]);

  assert.equal(faultKind(refused), "unreadable");
  assert.match((refused as { fault: MirrorFault }).fault.detail, /a\.ts/);
});

test("reconcile answers aborted when its signal is aborted", async () => {
  const { repo, location } = await fresh();
  await writeFile(join(repo, "a.ts"), "a");
  const controller = new AbortController();
  controller.abort();
  assert.equal(faultKind(await createLiveMirror().reconcile(location, listed("a.ts"), [], [], controller.signal)), "aborted");
});

test("the state round-trips", async () => {
  const { location } = await fresh();
  const mirror = createLiveMirror();
  const written = state([{ path: "a.ts", size: 1, mtimeNs: "123", blob: "abc" }]);

  ok(await mirror.writeState(location, written));

  assert.deepEqual(ok(await mirror.readState(location)), written);
});

test("an absent, malformed or wrongly shaped state reads as null", async () => {
  const { repo, location } = await fresh();
  const mirror = createLiveMirror();
  assert.equal(ok(await mirror.readState(location)), null);
  ok(await mirror.writeState(location, state()));
  const file = join(repo, ".ye-ast-graph", "live", "default.state.json");

  await writeFile(file, "{not json");
  assert.equal(ok(await mirror.readState(location)), null);
  await writeFile(file, JSON.stringify({ version: 1, ...state([{ path: "a", size: "1" } as unknown as MirrorEntry]) }));
  assert.equal(ok(await mirror.readState(location)), null);
  await writeFile(file, JSON.stringify({ version: 1, ...state() }));
  assert.equal(ok(await mirror.readState(location)), null);
});

test("writing the state leaves no temporary file and the file is private", async () => {
  const { repo, location } = await fresh();
  const mirror = createLiveMirror();
  ok(await mirror.writeState(location, state()));
  const directory = join(repo, ".ye-ast-graph", "live");

  assert.deepEqual(await readdir(directory), ["default.state.json"]);
  assert.equal((await stat(join(directory, "default.state.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});

test("a mirror directory that is group-writable is refused", async () => {
  const { repo, location } = await fresh();
  await writeFile(join(repo, "a.ts"), "a");
  const mirror = createLiveMirror();
  ok(await mirror.reconcile(location, listed("a.ts"), [], []));
  await chmod(mirror.root(location), 0o770);

  assert.equal(faultKind(await mirror.reconcile(location, listed("a.ts"), [], [])), "refused");
  assert.equal(faultKind(await mirror.discard(location)), "refused");
});

test("a mirror directory or an ancestor that is a symbolic link is refused", async () => {
  const { repo, location } = await fresh();
  const elsewhere = join(repo, "..", "elsewhere");
  await mkdir(elsewhere, { mode: 0o700 });
  await symlink(elsewhere, join(repo, ".ye-ast-graph"));
  const mirror = createLiveMirror();

  assert.equal(faultKind(await mirror.reconcile(location, [], [], [])), "refused");
  assert.equal(faultKind(await mirror.lock(location)), "refused");
  assert.deepEqual(await readdir(elsewhere), []);
});

test("the state lives beside the lock, so a rebuild that empties the engine's store keeps it", async () => {
  const { repo, location } = await fresh();
  const mirror = createLiveMirror();
  ok(await mirror.reconcile(location, [], [], []));
  ok(await mirror.writeState(location, state()));

  await rm(join(mirror.root(location), ".ye-ast-graph"), { recursive: true, force: true });

  assert.deepEqual(ok(await mirror.readState(location)), state());
  assert.equal((await lstat(join(repo, ".ye-ast-graph", "live", "default.state.json"))).isFile(), true);
});

test("discard removes the mirror with its index tree, store and state but never the lock", async () => {
  const { repo, location } = await fresh();
  await writeFile(join(repo, "a.ts"), "a");
  const mirror = createLiveMirror();
  ok(await mirror.reconcile(location, listed("a.ts"), [], []));
  ok(await mirror.materialize(location, ["a.ts"], mirror.indexRoot(location)));
  await mkdir(join(mirror.indexRoot(location), ".ye-ast-graph"), { recursive: true, mode: 0o700 });
  await writeFile(join(mirror.indexRoot(location), ".ye-ast-graph", "engine.db"), "db");
  ok(await mirror.writeState(location, state()));
  const lock = ok(await mirror.lock(location));

  ok(await mirror.discard(location));

  await assert.rejects(lstat(mirror.root(location)));
  await assert.rejects(lstat(mirror.indexRoot(location)));
  assert.equal((await lstat(join(repo, ".ye-ast-graph", "live", "default.lock"))).isFile(), true);
  await assert.rejects(lstat(join(repo, ".ye-ast-graph", "live", "default.state.json")));
  assert.equal(ok(await mirror.readState(location)), null);
  await lock.release();
});

test("discard of a mirror that does not exist succeeds", async () => {
  const { location } = await fresh();
  assert.deepEqual(await createLiveMirror().discard(location), { ok: true, value: undefined });
});

const pids = (alive: readonly number[], pid: () => number): LiveMirrorDeps => ({ ...defaultLiveMirrorDeps, pid, isAlive: (candidate) => alive.includes(candidate), sleep: () => new Promise((resolve) => setImmediate(resolve)) });

test("the lock is exclusive: a second holder waits until the first releases", async () => {
  const { location } = await fresh();
  const first = ok(await createLiveMirror(pids([10, 20], () => 10)).lock(location));
  let second = false;
  const waiting = createLiveMirror(pids([10, 20], () => 20)).lock(location).then((result) => { second = true; return result; });

  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second, false);
  await first.release();
  const held = ok(await waiting);

  assert.equal(second, true);
  await held.release();
});

test("a lock whose holder is dead is stale and replaced", async () => {
  const { repo, location } = await fresh();
  const mirror = createLiveMirror(pids([], () => 30));
  ok(await mirror.reconcile(location, [], [], []));
  await writeFile(join(repo, ".ye-ast-graph", "live", "default.lock"), "999999");

  const held = ok(await mirror.lock(location));

  assert.equal(await readFile(join(repo, ".ye-ast-graph", "live", "default.lock"), "utf8"), "30");
  await held.release();
});

test("a lock file with unreadable content is stale", async () => {
  const { repo, location } = await fresh();
  const mirror = createLiveMirror(pids([], () => 31));
  ok(await mirror.reconcile(location, [], [], []));
  await writeFile(join(repo, ".ye-ast-graph", "live", "default.lock"), "not a pid");

  ok(await mirror.lock(location));

  assert.equal(await readFile(join(repo, ".ye-ast-graph", "live", "default.lock"), "utf8"), "31");
});

test("waiting for a live holder ends as aborted when the signal aborts", async () => {
  const { location } = await fresh();
  const holder = ok(await createLiveMirror(pids([40, 41], () => 40)).lock(location));
  const controller = new AbortController();
  const waiting = createLiveMirror({ ...pids([40, 41], () => 41), sleep: async () => controller.abort() }).lock(location, controller.signal);

  assert.equal(faultKind(await waiting), "aborted");
  await holder.release();
});

test("release removes the lock file only while it still holds our pid", async () => {
  const { repo, location } = await fresh();
  const file = join(repo, ".ye-ast-graph", "live", "default.lock");
  const mine = ok(await createLiveMirror(pids([50], () => 50)).lock(location));
  await writeFile(file, "51");

  await mine.release();
  assert.equal(await readFile(file, "utf8"), "51");

  await writeFile(file, "50");
  await mine.release();
  await assert.rejects(lstat(file));
});

test("concurrent lock calls never hold the lock at once", async () => {
  const { location } = await fresh();
  const total = 8;
  let holders = 0;
  let peak = 0;
  let completed = 0;
  const all = Array.from({ length: total }, (_, index) => index + 100);
  await Promise.all(all.map(async (pid) => {
    const held = ok(await createLiveMirror(pids(all, () => pid)).lock(location));
    holders += 1;
    peak = Math.max(peak, holders);
    await new Promise((resolve) => setImmediate(resolve));
    holders -= 1;
    completed += 1;
    await held.release();
  }));

  assert.equal(peak, 1);
  assert.equal(completed, total);
});

test("the usage of a repository that keeps no mirror is empty", async () => {
  const { repo } = await fresh();

  assert.deepEqual(ok(await createLiveMirror().usage(repo)), { scopes: [], debris: [] });
});

test("usage measures a scope from its state, its index tree and its store, its last use from the state's mtime, whether its lock is live, and calls only a stale temporary file debris", async () => {
  const { repo } = await fresh();
  const mirror = createLiveMirror({ ...defaultLiveMirrorDeps, isAlive: (pid) => pid === 4242 });
  const one = { repo, scope: "one" };
  const two = { repo, scope: "two" };
  const three = { repo, scope: "three" };
  for (const location of [one, two, three]) ok(await mirror.reconcile(location, [], [], []));
  ok(await mirror.writeState(one, state([{ path: "a.ts", size: 10, mtimeNs: "1", blob: "a" }, { path: "b.ts", size: 5, mtimeNs: "2", blob: "b" }])));
  await mkdir(join(mirror.root(one), ".ye-ast-graph"), { mode: 0o700 });
  await writeFile(join(mirror.root(one), ".ye-ast-graph", "engine.db"), "x".repeat(100));
  await mkdir(join(mirror.indexRoot(one), ".ye-ast-graph"), { recursive: true, mode: 0o700 });
  await writeFile(join(mirror.indexRoot(one), "a.ts"), "i".repeat(20));
  await writeFile(join(mirror.indexRoot(one), ".ye-ast-graph", "engine.db"), "s".repeat(30));
  await writeFile(join(mirror.root(one), "not-in-the-manifest.ts"), "y".repeat(5_000));
  ok(await mirror.writeState(two, state([{ path: "c.ts", size: 7, mtimeNs: "3", blob: "c" }])));
  const live = join(repo, ".ye-ast-graph", "live");
  await writeFile(join(live, "one.lock"), "4242");
  await writeFile(join(live, "two.lock"), "9999");
  await writeFile(join(live, "three.lock"), "not a pid");
  await utimes(join(live, "one.state.json"), 1_000_000, 1_000_000);
  await utimes(join(live, "two.state.json"), 2_000_000, 2_000_000);
  await writeFile(join(live, "gone.state.json"), "{}");
  await writeFile(join(live, ".c0ffee.tmp"), "");
  await utimes(join(live, ".c0ffee.tmp"), 1_000_000, 1_000_000);
  await writeFile(join(live, "young.tmp"), "");

  const usage = ok(await mirror.usage(repo));

  assert.deepEqual(usage.scopes, [
    { scope: "one", versions: state().versions, bytes: 165, lastUsedMs: 1_000_000_000, locked: true },
    { scope: "three", versions: null, bytes: 0, lastUsedMs: null, locked: false },
    { scope: "two", versions: state().versions, bytes: 7, lastUsedMs: 2_000_000_000, locked: false },
  ]);
  assert.deepEqual(usage.debris, ["gone.state.json"]);
});

test("discardDebris removes exactly the entries it is told to and never reaches outside the live directory", async () => {
  const { repo } = await fresh();
  const mirror = createLiveMirror();
  const location = { repo, scope: "kept" };
  ok(await mirror.reconcile(location, [], [], []));
  ok(await mirror.writeState(location, state()));
  const live = join(repo, ".ye-ast-graph", "live");
  await writeFile(join(live, "gone.state.json"), "{}");
  await writeFile(join(live, ".c0ffee.tmp"), "");
  const outside = join(repo, "outside.txt");
  await writeFile(outside, "outside");
  await symlink(outside, join(live, "linked.state.json"));
  await mkdir(join(live, "directory.state.json"));
  await writeFile(join(live, "kept.lock"), "held");

  ok(await mirror.discardDebris(repo, ["gone.state.json", ".c0ffee.tmp", "linked.state.json", "directory.state.json", "kept.lock", "../outside.txt", "kept"]));

  await assert.rejects(lstat(join(live, "gone.state.json")));
  assert.equal((await lstat(join(live, ".c0ffee.tmp"))).isFile(), true);
  assert.equal(await readFile(outside, "utf8"), "outside");
  assert.equal((await lstat(join(live, "linked.state.json"))).isSymbolicLink(), true);
  assert.equal((await lstat(join(live, "directory.state.json"))).isDirectory(), true);
  assert.equal(await readFile(join(live, "kept.lock"), "utf8"), "held");
  assert.equal((await lstat(join(live, "kept"))).isDirectory(), true);
});

test("touch moves the state's modification time and leaves its bytes as they are", async () => {
  const { repo } = await fresh();
  const location = { repo, scope: "default" };
  const mirror = createLiveMirror({ ...defaultLiveMirrorDeps, now: () => 1_700_000_000_000 });
  ok(await mirror.writeState(location, state()));
  const file = join(repo, ".ye-ast-graph", "live", "default.state.json");
  await utimes(file, 1_000_000, 1_000_000);
  const bytes = await readFile(file, "utf8");

  ok(await mirror.touch(location));

  assert.equal(Math.round((await stat(file)).mtimeMs), 1_700_000_000_000);
  assert.equal(await readFile(file, "utf8"), bytes);
});

test("debris measured before a scope becomes active cannot remove its state", async () => {
  const { repo, location } = await fresh();
  const mirror = createLiveMirror();
  ok(await mirror.writeState(location, state()));
  const measured = ok(await mirror.usage(repo));
  assert.ok(measured.debris.includes("default.state.json"));
  const held = ok(await mirror.lock(location));
  try {
    ok(await mirror.reconcile(location, [], [], []));
    ok(await mirror.writeState(location, state()));
    ok(await mirror.discardDebris(repo, measured.debris));
    assert.deepEqual(ok(await mirror.readState(location)), state());
  } finally {
    await held.release();
  }
});

test("idle discard reserves the measured candidate without waiting and reclaims it after release", async () => {
  const { repo, location } = await fresh();
  const mirror = createLiveMirror({ ...defaultLiveMirrorDeps, sleep: async () => { throw new Error("must not wait"); } });
  await writeFile(join(repo, "a.ts"), "source");
  ok(await mirror.reconcile(location, listed("a.ts"), [], []));
  ok(await mirror.materialize(location, ["a.ts"], mirror.indexRoot(location)));
  ok(await mirror.writeState(location, state()));
  const measured = ok(await mirror.usage(repo));
  assert.equal(measured.scopes[0]?.locked, false);
  const held = ok(await mirror.lock(location));
  try {
    ok(await mirror.discardIfIdle(location));
    assert.equal(await readFile(join(mirror.root(location), "a.ts"), "utf8"), "source");
    assert.equal(await readFile(join(mirror.indexRoot(location), "a.ts"), "utf8"), "source");
    assert.deepEqual(ok(await mirror.readState(location)), state());
  } finally {
    await held.release();
  }
  ok(await mirror.discardIfIdle(location));
  await assert.rejects(lstat(mirror.root(location)), { code: "ENOENT" });
  assert.equal(ok(await mirror.readState(location)), null);
  const again = ok(await mirror.lock(location));
  await again.release();
});

test("idle deletion releases reservations on missing root and write failure", async () => {
  const { repo, location } = await fresh();
  const mirror = createLiveMirror();
  ok(await mirror.discardIfIdle(location));
  ok(await mirror.writeState(location, state()));
  ok(await mirror.discardIfIdle(location));
  let held = ok(await mirror.lock(location));
  await held.release();
  ok(await mirror.reconcile(location, [], [], []));
  const stateFile = join(repo, ".ye-ast-graph", "live", "default.state.json");
  await rm(stateFile, { force: true });
  ok(await mirror.discardIfIdle(location));
  held = ok(await mirror.lock(location));
  await held.release();
  ok(await mirror.reconcile(location, [], [], []));
  await mkdir(stateFile);
  assert.equal(faultKind(await mirror.discardIfIdle(location)), "write-failed");
  held = ok(await mirror.lock(location));
  await held.release();
});


test("cleanup reserves scoped state debris and preserves unattributable temporaries and lock attempts", async () => {
  const { repo, location } = await fresh();
  const mirror = createLiveMirror({ ...defaultLiveMirrorDeps, now: () => 10_000_000, sleep: async () => { throw new Error("must not wait"); } });
  ok(await mirror.writeState(location, state()));
  const live = join(repo, ".ye-ast-graph", "live");
  const scoped = "default.state.json.12345678-1234-4123-8123-123456789abc.tmp";
  const legacy = ".12345678-1234-4123-8123-123456789abc.tmp";
  const attempt = "default.lock.12345678-1234-4123-8123-123456789abc.tmp";
  const young = "default.state.json.12345678-1234-4123-8123-123456789abd.tmp";
  for (const name of [scoped, legacy, attempt]) {
    await writeFile(join(live, name), name);
    await utimes(join(live, name), 1, 1);
  }
  await writeFile(join(live, young), "young");
  await utimes(join(live, young), 10_000, 10_000);
  const measured = ok(await mirror.usage(repo));
  assert.deepEqual(measured.debris, [scoped, "default.state.json"].sort());
  const held = ok(await mirror.lock(location));
  try {
    ok(await mirror.discardDebris(repo, [...measured.debris, legacy, attempt, young]));
    assert.equal(await readFile(join(live, scoped), "utf8"), scoped);
    assert.deepEqual(ok(await mirror.readState(location)), state());
  } finally { await held.release(); }
  ok(await mirror.discardDebris(repo, [...measured.debris, legacy, attempt, young]));
  await assert.rejects(lstat(join(live, scoped)), { code: "ENOENT" });
  await assert.rejects(lstat(join(live, "default.state.json")), { code: "ENOENT" });
  assert.equal(await readFile(join(live, legacy), "utf8"), legacy);
  assert.equal(await readFile(join(live, attempt), "utf8"), attempt);
  assert.equal(await readFile(join(live, young), "utf8"), "young");
});

test("idle cleanup leaves stale and unreadable locks in place", async () => {
  const { repo, location } = await fresh();
  const mirror = createLiveMirror({ ...defaultLiveMirrorDeps, isAlive: () => false, sleep: async () => { throw new Error("must not wait"); } });
  ok(await mirror.reconcile(location, [], [], []));
  ok(await mirror.writeState(location, state()));
  const lock = join(repo, ".ye-ast-graph", "live", "default.lock");
  for (const text of ["9999", "invalid"]) {
    await writeFile(lock, text);
    ok(await mirror.discardIfIdle(location));
    assert.equal(await readFile(lock, "utf8"), text);
    assert.deepEqual(ok(await mirror.readState(location)), state());
  }
});

test("state writer exposes a scope-bearing temporary to retention while its owner holds the lease", async () => {
  const { repo, location } = await fresh();
  const live = join(repo, ".ye-ast-graph", "live");
  let temporary = "";
  const mirror = createLiveMirror({
    ...defaultLiveMirrorDeps,
    now: () => 10_000_000_000_000,
    renameState: async (from, to) => {
      temporary = from;
      const measured = ok(await mirror.usage(repo));
      assert.ok(measured.debris.includes(from.slice(live.length + 1)));
      ok(await mirror.discardDebris(repo, measured.debris));
      assert.equal((await lstat(from)).isFile(), true);
      await defaultLiveMirrorDeps.renameState(from, to);
    },
  });
  const held = ok(await mirror.lock(location));
  try { ok(await mirror.writeState(location, state())); } finally { await held.release(); }
  assert.match(temporary.slice(live.length + 1), /^default\.state\.json\.[0-9a-f-]+\.tmp$/);
  assert.deepEqual(ok(await mirror.readState(location)), state());
});

test("debris cleanup skips a busy scope but reclaims another and rechecks whether the orphan gained a root", async () => {
  const { repo, location } = await fresh();
  const mirror = createLiveMirror({ ...defaultLiveMirrorDeps, sleep: async () => { throw new Error("must not wait"); } });
  ok(await mirror.writeState(location, state()));
  ok(await mirror.writeState({ repo, scope: "other" }, state()));
  const measured = ok(await mirror.usage(repo));
  const held = ok(await mirror.lock(location));
  try {
    ok(await mirror.reconcile(location, [], [], []));
    ok(await mirror.discardDebris(repo, measured.debris));
    assert.deepEqual(ok(await mirror.readState(location)), state());
    assert.equal(ok(await mirror.readState({ repo, scope: "other" })), null);
  } finally { await held.release(); }
  ok(await mirror.discardDebris(repo, measured.debris));
  assert.deepEqual(ok(await mirror.readState(location)), state());
});

test("a thrown debris cleanup failure releases its scope reservation", async () => {
  const { repo, location } = await fresh();
  const mirror = createLiveMirror({ ...defaultLiveMirrorDeps, now: () => { throw new Error("clock failed"); } });
  ok(await mirror.writeState(location, state()));
  const entry = "default.state.json.12345678-1234-4123-8123-123456789abc.tmp";
  await writeFile(join(repo, ".ye-ast-graph", "live", entry), "temporary");
  assert.equal(faultKind(await mirror.discardDebris(repo, [entry])), "write-failed");
  const held = ok(await mirror.lock(location));
  await held.release();
});

test("reconcile and changedSince give the same exact answer over more files than are statted at once", async () => {
  const { repo, location } = await fresh();
  const names = Array.from({ length: 150 }, (_, index) => `f${String(index).padStart(3, "0")}.ts`);
  for (const name of names) await writeFile(join(repo, name), name);
  const mirror = createLiveMirror();
  const first = ok(await mirror.reconcile(location, listed(...names), [], []));
  await writeFile(join(repo, "f007.ts"), "edited");
  await rm(join(repo, "f099.ts"));
  await writeFile(join(repo, "f149.ts"), "edited too");

  const changed = ok(await mirror.changedSince(location, listed(...names), first, undefined));
  const second = ok(await mirror.reconcile(location, listed(...names), first.manifest, []));

  assert.deepEqual(changed, ["f007.ts", "f099.ts", "f149.ts"]);
  assert.deepEqual(second.changed, ["f007.ts", "f099.ts", "f149.ts"]);
  assert.deepEqual(second.manifest.map((entry) => entry.path), names.filter((name) => name !== "f099.ts"));
});

test("changedSince answers aborted when its signal is aborted", async () => {
  const { repo, location } = await fresh();
  await writeFile(join(repo, "a.ts"), "a");
  const mirror = createLiveMirror();
  const first = ok(await mirror.reconcile(location, listed("a.ts"), [], []));
  const controller = new AbortController();
  controller.abort();

  assert.equal(faultKind(await mirror.changedSince(location, listed("a.ts"), first, controller.signal)), "aborted");
});
