import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsSourceReader } from "../core/adapters/fs/fs-source-reader.adapter.ts";
import { createLiveMirror, defaultLiveMirrorDeps } from "../core/adapters/fs/live-mirror.adapter.ts";
import { createGitWorkingTree } from "../core/adapters/git/git-working-tree.adapter.ts";
import { createGitVcs } from "../core/adapters/git/git-vcs.adapter.ts";
import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import { createPathMatcher } from "../core/adapters/fs/path-matcher.adapter.ts";
import { isWritten, liveScope } from "../core/domain/snapshot/live-export.ts";
import { fakeLive } from "../core/application/live/fake-live.testing.ts";
import { openLive } from "../core/application/live/live-tree.ts";
import { pathSelection } from "../core/domain/shared/scope.ts";
import { withLiveCaptures, type HeadReaderDeps } from "../core/application/snapshot/head-reading.ts";

test("two held mirrors retain captured bytes and report the changed repository after release", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ye-ast-captures-"));
  try {
    const repos = ["a", "b"].map((name) => {
      const repo = join(dir, name); mkdirSync(repo);
      execFileSync("git", ["init", "-q", repo]);
      writeFileSync(join(repo, "file.ts"), `original ${name}`);
      execFileSync("git", ["-C", repo, "add", "file.ts"]);
      execFileSync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"]);
      return repo;
    });
    const fake = fakeLive();
    const digest = createSha256Digest();
    const mirror = createLiveMirror({ ...defaultLiveMirrorDeps, writes: isWritten });
    let active = 0;
    const lock = mirror.lock;
    mirror.lock = async (...args) => {
      const acquired = await lock(...args);
      if (!acquired.ok) return acquired;
      active++;
      return { ok: true, value: { release: async () => { await acquired.value.release(); active--; } } };
    };
    const live = { ...fake.deps, mirror, workingTree: createGitWorkingTree(), digest };
    const deps = { live, graph: live.graph, digest, matcher: createPathMatcher(), reader: createFsSourceReader(), extractor: { extract: async () => [] }, vcs: createGitVcs() } as unknown as HeadReaderDeps;
    const notices: { repo: string; stateId: string }[] = [];
    const snapshots: { head: string; stateId: string }[] = [];
    let callbackFinished = false;
    const selections = repos.map((repo, index) => ({ repo, repoId: String(index), head: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), scope: liveScope(), trust: "trusted" as const, onStale: (notice: { stateId: string }) => {
      assert.equal(active, 0);
      assert.equal(callbackFinished, true);
      assert.equal(notice.stateId, snapshots[index]!.stateId);
      notices.push({ repo, stateId: notice.stateId });
    } }));
    const result = await withLiveCaptures(deps, selections, undefined, async (captures) => {
      for (const [index, repo] of repos.entries()) {
        const held = captures.get(String(index))!;
        snapshots[index] = { head: held.head, stateId: held.tree.stateId };
        assert.equal(held.tree.location.repo, repo);
        assert.equal(held.head, selections[index]!.head);
        assert.ok(held.tree.stateId);
      }
      writeFileSync(join(repos[1]!, "file.ts"), "changed contents");
      for (const [index] of repos.entries()) {
        const held = captures.get(String(index))!;
        const sources = await held.sources();
        assert.ok(sources.ok);
        assert.equal(sources.value.sources[0]?.content, `original ${index === 0 ? "a" : "b"}`);
        assert.deepEqual({ head: held.head, stateId: held.tree.stateId }, snapshots[index]);
      }
      assert.deepEqual(notices, []);
      callbackFinished = true;
    });
    assert.ok(result.ok);
    assert.deepEqual(notices, [{ repo: repos[1], stateId: snapshots[1]!.stateId }]);
    const firstSnapshots = snapshots.map((snapshot) => ({ ...snapshot }));
    const next = await withLiveCaptures(deps, selections, undefined, async (captures) => {
      const changed = captures.get("1")!;
      const sources = await changed.sources();
      assert.ok(sources.ok);
      assert.equal(sources.value.sources[0]?.content, "changed contents");
      assert.equal(changed.head, firstSnapshots[1]!.head);
      assert.notEqual(changed.tree.stateId, firstSnapshots[1]!.stateId);
    });
    assert.ok(next.ok);
    assert.deepEqual(snapshots, firstSnapshots);
    assert.equal(active, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a path pending for the store is copied once by queries that read no store, and the next store query still syncs it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ye-ast-pending-"));
  try {
    const repo = join(dir, "repo"); mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "a.ts"), "one");
    const fake = fakeLive();
    const copies: string[] = [];
    const mirror = createLiveMirror({ ...defaultLiveMirrorDeps, writes: isWritten, copyFile: async (from, to) => { copies.push(from); await defaultLiveMirrorDeps.copyFile(from, to); } });
    const scope = liveScope();
    const query = async (store: boolean): Promise<void> => {
      const opened = await openLive({ ...fake.deps, mirror, workingTree: createGitWorkingTree(), digest: createSha256Digest() }, { repo, scope, selected: pathSelection(scope, () => false), store }, async () => undefined);
      assert.ok(opened.ok);
    };
    await query(true);
    writeFileSync(join(repo, "a.ts"), "changed");

    await query(false);
    const afterFirst = copies.length;
    await query(false);

    assert.equal(copies.length, afterFirst);
    assert.deepEqual(fake.syncs, []);
    await query(true);
    assert.deepEqual(fake.syncs, [["a.ts"]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
