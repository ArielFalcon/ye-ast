import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "../../domain/shared/result.ts";
import type { MirrorEntry, MirrorFault, MirrorLocation, MirrorState } from "../../ports/live-mirror.port.ts";
import type { WorkingTreePath } from "../../ports/working-tree.port.ts";
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
  fullBuildStateId: "full",
  stateId: "state",
  pending: ["b.ts"],
});

test("the mirror root is under the repository's store directory, per scope", async () => {
  const { repo, location } = await fresh();
  assert.equal(createLiveMirror().root(location), join(repo, ".ye-ast-graph", "live", "default"));
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
  await writeFile(file, JSON.stringify({ version: 2, ...state() }));
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

test("discard removes the mirror with its store and state but never the lock", async () => {
  const { repo, location } = await fresh();
  await writeFile(join(repo, "a.ts"), "a");
  const mirror = createLiveMirror();
  ok(await mirror.reconcile(location, listed("a.ts"), [], []));
  ok(await mirror.writeState(location, state()));
  const lock = ok(await mirror.lock(location));

  ok(await mirror.discard(location));

  await assert.rejects(lstat(mirror.root(location)));
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
