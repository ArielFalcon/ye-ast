import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "../../domain/shared/result.ts";
import type { ExportPlan } from "../../ports/vcs.port.ts";
import { createGitVcs, defaultGitDeps, gitEnvironment, type BlobSink, type GitDeps } from "./git-vcs.adapter.ts";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const EVERYTHING: ExportPlan = { write: () => true };

let scratch: string;
let repo: string;
let destination: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ye-ast-"));
  repo = join(scratch, "repo");
  destination = join(scratch, "export");
  mkdirSync(repo);
  mkdirSync(destination);
  git("init", "-q");
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim();
}

function write(path: string, content: string): void {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function commitAll(): string {
  git("add", "-A");
  git("commit", "-q", "-m", "snapshot");
  return git("rev-parse", "HEAD");
}

function blob(content: string): string {
  return execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, env: GIT_ENV, input: content, encoding: "utf8" }).trim();
}

function tree(entries: string[]): string {
  const input = entries.map((entry) => `${entry}\0`).join("");
  return execFileSync("git", ["mktree", "-z"], { cwd: repo, env: GIT_ENV, input, encoding: "utf8" }).trim();
}

function commitTree(treeId: string): string {
  return git("commit-tree", treeId, "-m", "crafted");
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function valueOf<T>(result: Result<T, unknown>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

test("exports the files of the commit at the sha, never the working tree or a later commit", async () => {
  write("src/a.txt", "first");
  const sha = commitAll();
  write("src/a.txt", "second");
  commitAll();
  write("src/untracked.txt", "not committed");

  const exported = valueOf(await createGitVcs().exportCommit(repo, sha, destination, EVERYTHING));

  assert.equal(readFileSync(join(destination, "src/a.txt"), "utf8"), "first");
  assert.deepEqual(exported.files, [{ path: "src/a.txt", blob: git("rev-parse", `${sha}:src/a.txt`), written: true }]);
  assert.equal(existsSync(join(destination, "src/untracked.txt")), false);
});

test("resolveCommit turns a revision into the full sha of its commit", async () => {
  write("a.txt", "a");
  const sha = commitAll();

  assert.deepEqual(await createGitVcs().resolveCommit(repo, "HEAD"), { ok: true, value: sha });
});

test("resolveCommit answers unknown-revision for a revision the repository lacks", async () => {
  write("a.txt", "a");
  commitAll();

  const result = await createGitVcs().resolveCommit(repo, "no-such-branch");

  assert.equal(!result.ok && result.fault.kind, "unknown-revision");
});

test("exportCommit answers unknown-revision for a sha the repository lacks and writes nothing", async () => {
  write("a.txt", "a");
  commitAll();

  const result = await createGitVcs().exportCommit(repo, "0".repeat(40), destination, EVERYTHING);

  assert.equal(!result.ok && result.fault.kind, "unknown-revision");
  assert.deepEqual(readdirSync(destination), []);
});

test("exportCommit refuses a revision that is not a full commit sha, so a snapshot never records a moving name", async () => {
  write("a.txt", "a");
  commitAll();

  const result = await createGitVcs().exportCommit(repo, "HEAD", destination, EVERYTHING);

  assert.equal(!result.ok && result.fault.kind, "unknown-revision");
});

test("a symlink is reported and never written", async () => {
  write("target.txt", "secret");
  symlinkSync("target.txt", join(repo, "link"));
  const sha = commitAll();

  const exported = valueOf(await createGitVcs().exportCommit(repo, sha, destination, EVERYTHING));

  assert.deepEqual(exported.skipped, [{ path: "link", reason: "symlink" }]);
  assert.equal(existsSync(join(destination, "link")), false);
});

test("a submodule is reported and never written", async () => {
  write("a.txt", "a");
  const inner = commitAll();
  git("update-index", "--add", "--cacheinfo", `160000,${inner},vendor/lib`);
  git("commit", "-q", "-m", "submodule");

  const exported = valueOf(await createGitVcs().exportCommit(repo, git("rev-parse", "HEAD"), destination, EVERYTHING));

  assert.deepEqual(exported.skipped, [{ path: "vendor/lib", reason: "submodule" }]);
  assert.equal(existsSync(join(destination, "vendor/lib")), false);
});

test("an entry that climbs out of the export or into a .git directory is reported and never written", async () => {
  const content = blob("payload");
  const escape = tree([`100644 blob ${content}\tescaped.txt`]);
  const hooks = tree([`100644 blob ${content}\tconfig`]);
  const root = tree([`040000 tree ${escape}\t..`, `040000 tree ${hooks}\t.git`, `100644 blob ${content}\tok.txt`]);

  const exported = valueOf(await createGitVcs().exportCommit(repo, commitTree(root), destination, EVERYTHING));

  assert.deepEqual(exported.skipped, [
    { path: "../escaped.txt", reason: "unsafe-path" },
    { path: ".git/config", reason: "unsafe-path" },
  ]);
  assert.deepEqual(exported.files.map((file) => file.path), ["ok.txt"]);
  assert.equal(existsSync(join(scratch, "escaped.txt")), false);
  assert.equal(existsSync(join(destination, ".git")), false);
});

test("paths that differ only in case keep the first in git's order on every host", async () => {
  const first = blob("upper");
  const second = blob("lower");
  const root = tree([`100644 blob ${first}\tREADME.md`, `100644 blob ${second}\tReadme.md`]);

  const exported = valueOf(await createGitVcs().exportCommit(repo, commitTree(root), destination, EVERYTHING));

  assert.deepEqual(exported.files, [{ path: "README.md", blob: first, written: true }]);
  assert.deepEqual(exported.skipped, [{ path: "Readme.md", reason: "collision" }]);
  assert.equal(readFileSync(join(destination, "README.md"), "utf8"), "upper");
});

test("a file and a directory that differ in case, or names that differ in Unicode normalization, collide", async () => {
  const content = blob("x");
  const directory = tree([`100644 blob ${content}\tx`]);
  const root = tree([
    `040000 tree ${directory}\tA`,
    `100644 blob ${content}\ta`,
    `100644 blob ${content}\té`,
    `100644 blob ${content}\té`,
  ]);

  const exported = valueOf(await createGitVcs().exportCommit(repo, commitTree(root), destination, EVERYTHING));

  assert.deepEqual(exported.files.map((file) => file.path), ["A/x", "é"]);
  assert.deepEqual(exported.skipped, [
    { path: "a", reason: "collision" },
    { path: "é", reason: "collision" },
  ]);
});

test("a name that is not valid UTF-8 is reported and never written", async () => {
  const content = blob("x");
  const entries = Buffer.concat([Buffer.from(`100644 blob ${content}\tf`), Buffer.from([0xff]), Buffer.from("\n")]);
  const root = execFileSync("git", ["mktree"], { cwd: repo, env: GIT_ENV, input: entries, encoding: "utf8" }).trim();

  const exported = valueOf(await createGitVcs().exportCommit(repo, commitTree(root), destination, EVERYTHING));

  assert.deepEqual(exported.files, []);
  assert.deepEqual(exported.skipped.map((entry) => entry.reason), ["unsafe-path"]);
});

test("a replace object never changes what the commit exports", async () => {
  write("a.txt", "real");
  const sha = commitAll();
  git("replace", "-f", git("rev-parse", `${sha}:a.txt`), blob("replaced"));

  await createGitVcs().exportCommit(repo, sha, destination, EVERYTHING);

  assert.equal(readFileSync(join(destination, "a.txt"), "utf8"), "real");
});

test("blobs larger than one read chunk arrive whole and in order", async () => {
  const large = Array.from({ length: 300_000 }, (_, index) => String.fromCharCode(97 + (index % 26))).join("");
  write("a-large.txt", large);
  write("b-small.txt", "after");
  const sha = commitAll();

  await createGitVcs().exportCommit(repo, sha, destination, EVERYTHING);

  assert.equal(readFileSync(join(destination, "a-large.txt"), "utf8"), large);
  assert.equal(readFileSync(join(destination, "b-small.txt"), "utf8"), "after");
});

test("a GIT_DIR inherited from the calling process does not redirect the export", async () => {
  write("a.txt", "a");
  const sha = commitAll();
  process.env.GIT_DIR = join(scratch, "elsewhere");
  try {
    const result = await createGitVcs().exportCommit(repo, sha, destination, EVERYTHING);
    assert.ok(result.ok);
  } finally {
    delete process.env.GIT_DIR;
  }
});

test("a git failure while resolving the sha stays a git-failed fault", async () => {
  const result = await createGitVcs().exportCommit(join(scratch, "missing"), "1".repeat(40), destination, EVERYTHING);

  assert.equal(!result.ok && result.fault.kind, "git-failed");
});

test("the repository's own attributes do not hide or rewrite a file", async () => {
  write(".gitattributes", "hidden.txt export-ignore\nsubst.txt export-subst\n");
  write("hidden.txt", "kept");
  write("subst.txt", "$Format:%H$");
  const sha = commitAll();

  await createGitVcs().exportCommit(repo, sha, destination, EVERYTHING);

  assert.equal(readFileSync(join(destination, "hidden.txt"), "utf8"), "kept");
  assert.equal(readFileSync(join(destination, "subst.txt"), "utf8"), "$Format:%H$");
});

test("a git failure after the sha resolves is a git-failed fault", async () => {
  const sha = "1".repeat(40);
  const deps: GitDeps = {
    runGit: async (_repo, args) => {
      if (args.includes("--show-prefix")) return { code: 0, stdout: Buffer.from("\n"), stderr: "" };
      return { code: 0, stdout: Buffer.from(`${sha}\n`), stderr: "" };
    },
    runIsolatedGit: async () => {
      throw new Error("not reached");
    },
    streamRecords: async () => ({ code: 128, stdout: Buffer.alloc(0), stderr: "fatal" }),
    streamLines: async () => {
      throw new Error("not reached");
    },
    streamBlobs: async () => {
      throw new Error("not reached");
    },
  };

  const result = await createGitVcs(deps).exportCommit(repo, sha, destination, EVERYTHING);

  assert.equal(!result.ok && result.fault.kind, "git-failed");
});

const HOSTILE_NAMES = [
  "..\\..\\..\\evil.java",
  ".git.",
  ".git ",
  ".GIT",
  "git~1",
  "GIT~1",
  ".g\u200cit",
];

test("a name that another host would read as a path escape or as the .git directory is reported on every host", async () => {
  const content = blob("payload");
  const hostile = tree(HOSTILE_NAMES.map((name) => `100644 blob ${content}\t${name}`));
  const inside = tree([`100644 blob ${content}\tconfig`]);
  const root = tree([
    `040000 tree ${hostile}\tdir`,
    `040000 tree ${inside}\t.git.`,
    `100644 blob ${content}\tok.txt`,
    `100644 blob ${content}\tgit~12`,
  ]);

  const exported = valueOf(await createGitVcs().exportCommit(repo, commitTree(root), destination, EVERYTHING));

  assert.deepEqual(exported.files.map((file) => file.path), ["git~12", "ok.txt"]);
  assert.deepEqual(
    exported.skipped.map((entry) => entry.reason),
    exported.skipped.map(() => "unsafe-path"),
  );
  assert.equal(exported.skipped.length, HOSTILE_NAMES.length + 1);
  assert.deepEqual(readdirSync(destination).toSorted(), ["git~12", "ok.txt"]);
});

test("a name that Windows cannot hold is reported on every host, a look-alike is exported", async () => {
  const content = blob("x");
  const unholdable = ["a:b", "a<b", "a>b", 'a"b', "a|b", "a?b", "a*b", "a\u0001b", "CON", "nul.txt", "Com1.log", "LPT9", "ends.", "ends "];
  const lookAlikes = ["console", "icon", "COM10", "nullable.txt", "lpt0", "auxiliary"];
  const root = tree([...unholdable, ...lookAlikes].map((name) => `100644 blob ${content}\t${name}`));

  const exported = valueOf(await createGitVcs().exportCommit(repo, commitTree(root), destination, EVERYTHING));

  assert.deepEqual(exported.files.map((file) => file.path).toSorted(), lookAlikes.toSorted());
  assert.deepEqual(exported.skipped.map((entry) => entry.path).toSorted(), unholdable.toSorted());
  assert.ok(exported.skipped.every((entry) => entry.reason === "unsafe-path"));
});

test("a partial clone never fetches a missing blob from its promisor remote, which would run a command from its config", async () => {
  const origin = join(scratch, "origin");
  const clone = join(scratch, "clone");
  const marker = join(scratch, "PWNED-uploadpack");
  mkdirSync(origin);
  const inOrigin = (...args: string[]) => execFileSync("git", args, { cwd: origin, env: GIT_ENV, encoding: "utf8" }).trim();
  inOrigin("init", "-q");
  inOrigin("config", "uploadpack.allowFilter", "true");
  inOrigin("config", "uploadpack.allowAnySHA1InWant", "true");
  writeFileSync(join(origin, "A.java"), "class A {}");
  inOrigin("add", "-A");
  inOrigin("commit", "-q", "-m", "origin");
  const sha = inOrigin("rev-parse", "HEAD");
  const blobId = inOrigin("rev-parse", "HEAD:A.java");
  execFileSync("git", ["clone", "-q", "--no-checkout", "--filter=blob:none", `file://${origin}`, clone], { env: GIT_ENV });
  const inClone = (...args: string[]) => execFileSync("git", args, { cwd: clone, env: GIT_ENV, encoding: "utf8" }).trim();
  inClone("config", "remote.origin.uploadpack", `touch ${marker}; git-upload-pack`);

  const result = await createGitVcs().exportCommit(clone, sha, destination, EVERYTHING);

  assert.equal(existsSync(marker), false);
  const offline = { cwd: clone, env: { ...GIT_ENV, GIT_NO_LAZY_FETCH: "1" } };
  assert.throws(() => execFileSync("git", ["cat-file", "-e", blobId], offline));
  assert.equal(!result.ok && result.fault.kind, "object-missing");
  assert.deepEqual(readdirSync(destination), []);
});

test("a subdirectory of a repository is refused, so the whole repository is never mapped under the subdirectory's name", async () => {
  write("services/orders/A.java", "class A {}");
  const sha = commitAll();
  const subdirectory = join(repo, "services", "orders");

  const resolved = await createGitVcs().resolveCommit(subdirectory, "HEAD");
  const exported = await createGitVcs().exportCommit(subdirectory, sha, destination, EVERYTHING);

  assert.equal(!resolved.ok && resolved.fault.kind, "not-repository-root");
  assert.equal(!exported.ok && exported.fault.kind, "not-repository-root");
  assert.deepEqual(readdirSync(destination), []);
});

test("a file that cannot be written is an export-write-failed fault, not a git failure", async () => {
  write("src/a.txt", "a");
  const sha = commitAll();
  writeFileSync(join(destination, "src"), "in the way");

  const result = await createGitVcs().exportCommit(repo, sha, destination, EVERYTHING);

  assert.equal(!result.ok && result.fault.kind, "export-write-failed");
});

test("an export aborted while blobs stream stops writing before it answers aborted", async () => {
  for (let index = 0; index < 20; index += 1) write(`f${String(index).padStart(2, "0")}.txt`, `content ${index}`);
  const sha = commitAll();
  const interrupt = new AbortController();
  const deps: GitDeps = {
    ...defaultGitDeps,
    streamBlobs: (repoPath, blobs, sink, signal) => {
      let blobIndex = -1;
      return defaultGitDeps.streamBlobs(
        repoPath,
        blobs,
        {
          start: (index, size) => {
            blobIndex = index;
            return sink.start(index, size);
          },
          write: sink.write,
          finish: async () => {
            await sink.finish();
            if (blobIndex === 1) interrupt.abort();
          },
        },
        signal,
      );
    },
  };

  const result = await createGitVcs(deps).exportCommit(repo, sha, destination, EVERYTHING, interrupt.signal);

  assert.equal(!result.ok && result.fault.kind, "aborted");
  const atReturn = readdirSync(destination).toSorted();
  await new Promise((done) => setTimeout(done, 100));
  assert.deepEqual(readdirSync(destination).toSorted(), atReturn);
  assert.deepEqual(atReturn, ["f00.txt", "f01.txt"]);
});

test("an abort that kills any of the git calls answers aborted and never git-failed", async () => {
  write("a.txt", "a");
  const sha = commitAll();
  const GIT_CALLS = 4;
  for (let abortBefore = 0; abortBefore < GIT_CALLS; abortBefore += 1) {
    const interrupt = new AbortController();
    let calls = 0;
    const deps: GitDeps = {
      ...defaultGitDeps,
      runGit: (repoPath, args, signal) => {
        if (calls++ === abortBefore) interrupt.abort();
        return defaultGitDeps.runGit(repoPath, args, signal);
      },
      streamRecords: (repoPath, args, onRecord, signal) => {
        if (calls++ === abortBefore) interrupt.abort();
        return defaultGitDeps.streamRecords(repoPath, args, onRecord, signal);
      },
      streamBlobs: (repoPath, blobs, sink, signal) => {
        if (calls++ === abortBefore) interrupt.abort();
        return defaultGitDeps.streamBlobs(repoPath, blobs, sink, signal);
      },
    };

    const result = await createGitVcs(deps).exportCommit(repo, sha, destination, EVERYTHING, interrupt.signal);

    assert.equal(!result.ok && result.fault.kind, "aborted", `abort before git call ${abortBefore}`);
  }
});

test("aborting kills the git process instead of waiting for it", { skip: process.platform === "win32", timeout: 10_000 }, async () => {
  const bin = join(scratch, "bin");
  const pidFile = join(scratch, "git.pid");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 60\n`, { mode: 0o755 });
  const interrupt = new AbortController();
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const pending = createGitVcs().resolveCommit(repo, "HEAD", interrupt.signal);
    while (!existsSync(pidFile) || readFileSync(pidFile, "utf8").trim() === "") await new Promise((done) => setTimeout(done, 10));
    interrupt.abort();

    const result = await pending;

    assert.equal(!result.ok && result.fault.kind, "aborted");
    const pid = Number(readFileSync(pidFile, "utf8"));
    while (isRunning(pid)) await new Promise((done) => setTimeout(done, 10));
  } finally {
    process.env.PATH = path;
  }
});

const JAVA_ONLY: Pick<ExportPlan, "write"> = { write: (path) => path.endsWith(".java") };

test("streamBlobs announces a blob's size, then hands it over in chunks smaller than the blob", async () => {
  const size = 4 * 1024 * 1024;
  writeFileSync(join(repo, "big.bin"), Buffer.alloc(size, 7));
  commitAll();
  const events: string[] = [];
  let received = 0;
  let largest = 0;
  const sink: BlobSink = {
    start: async (index, announced) => void events.push(`start ${index} ${announced}`),
    write: async (chunk) => {
      received += chunk.length;
      largest = Math.max(largest, chunk.length);
      events.push("write");
    },
    finish: async () => void events.push("finish"),
  };

  const run = await defaultGitDeps.streamBlobs(repo, [git("rev-parse", "HEAD:big.bin")], sink);

  assert.equal(run.code, 0);
  assert.equal(events[0], `start 0 ${size}`);
  assert.equal(events.at(-1), "finish");
  assert.equal(received, size);
  assert.ok(largest < size, `a chunk held ${largest} of ${size} bytes`);
});

test("streamBlobs reports a blob the object store lacks as a null size", async () => {
  const sizes: (number | null)[] = [];
  const sink: BlobSink = { start: async (_index, size) => void sizes.push(size), write: async () => undefined, finish: async () => undefined };
  write("a.txt", "a");
  commitAll();

  await defaultGitDeps.streamBlobs(repo, ["0".repeat(40), git("rev-parse", "HEAD:a.txt")], sink);

  assert.deepEqual(sizes, [null, 1]);
});

test("the export writes each chunk of a blob as it arrives instead of holding the blob", async () => {
  write("a.txt", "abcdef");
  const sha = commitAll();
  const onDisk: number[] = [];
  const deps: GitDeps = {
    ...defaultGitDeps,
    streamBlobs: async (_repo, _blobs, sink) => {
      await sink.start(0, 6);
      for (const chunk of ["ab", "cd", "ef"]) {
        await sink.write(Buffer.from(chunk));
        onDisk.push(statSync(join(destination, "a.txt")).size);
      }
      await sink.finish();
      return { code: 0, stdout: Buffer.alloc(0), stderr: "" };
    },
  };

  const result = await createGitVcs(deps).exportCommit(repo, sha, destination, EVERYTHING);

  assert.ok(result.ok);
  assert.deepEqual(onDisk, [2, 4, 6]);
  assert.equal(readFileSync(join(destination, "a.txt"), "utf8"), "abcdef");
});

test("an empty blob is exported as an empty file", async () => {
  write("empty.txt", "");
  write("after.txt", "next");
  const sha = commitAll();

  const exported = valueOf(await createGitVcs().exportCommit(repo, sha, destination, EVERYTHING));

  assert.equal(readFileSync(join(destination, "empty.txt"), "utf8"), "");
  assert.equal(readFileSync(join(destination, "after.txt"), "utf8"), "next");
  assert.ok(exported.files.every((file) => file.written));
});

test("streamRecords hands over each record of a listing larger than one read chunk and holds none of it", async () => {
  const names = Array.from({ length: 3000 }, (_, index) => `directory-with-a-long-name/file-with-a-long-name-${String(index).padStart(5, "0")}.txt`);
  for (const name of names) write(name, "x");
  commitAll();
  const records: string[] = [];

  const run = await defaultGitDeps.streamRecords(repo, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], (record) => {
    records.push(record.toString("utf8").split("\t")[1]!);
  });

  assert.equal(run.code, 0);
  assert.deepEqual(records, names);
  assert.equal(run.stdout.length, 0);
});

test("a path the plan does not select is listed, classified and reported but never read from git nor written", async () => {
  const java = blob("class A {}");
  const docs = blob("docs");
  const link = blob("README.md");
  const sources = tree([`100644 blob ${java}\tA.java`, `100644 blob ${docs}\tB.kt`]);
  const root = tree([
    `100644 blob ${docs}\tREADME.md`,
    `100644 blob ${blob("other")}\tReadme.md`,
    `120000 blob ${link}\tlink.md`,
    `040000 tree ${sources}\tsrc`,
  ]);
  const requested: string[][] = [];
  const deps: GitDeps = {
    ...defaultGitDeps,
    streamBlobs: (repoPath, blobs, sink, signal) => (requested.push([...blobs]), defaultGitDeps.streamBlobs(repoPath, blobs, sink, signal)),
  };

  const exported = valueOf(await createGitVcs(deps).exportCommit(repo, commitTree(root), destination, JAVA_ONLY));

  assert.deepEqual(
    exported.files.map((file) => [file.path, file.written]),
    [["README.md", false], ["src/A.java", true], ["src/B.kt", false]],
  );
  assert.deepEqual(exported.skipped.toSorted((a, b) => (a.path < b.path ? -1 : 1)), [
    { path: "Readme.md", reason: "collision" },
    { path: "link.md", reason: "symlink" },
  ]);
  assert.deepEqual(requested, [[java]]);
  assert.deepEqual(readdirSync(destination), ["src"]);
});

test("an unselected blob that the object store lacks does not fail the export", async () => {
  const present = blob("class A {}");
  const entries = `100644 blob ${"1".repeat(40)}\tdocs.md\u0000100644 blob ${present}\tA.java\u0000`;
  const root = execFileSync("git", ["mktree", "-z", "--missing"], { cwd: repo, env: GIT_ENV, input: entries, encoding: "utf8" }).trim();

  const exported = valueOf(await createGitVcs().exportCommit(repo, commitTree(root), destination, JAVA_ONLY));

  assert.deepEqual(exported.files.map((file) => [file.path, file.written]), [["A.java", true], ["docs.md", false]]);
  assert.equal(readFileSync(join(destination, "A.java"), "utf8"), "class A {}");
});

test("the entry budget counts every listed entry and stops the export at the first one beyond it", async () => {
  write("a.java", "class A {}");
  write("b.txt", "text");
  symlinkSync("b.txt", join(repo, "c-link"));
  write("d.java", "class D {}");
  write("e.java", "class E {}");
  const sha = commitAll();
  const seen: number[] = [];
  const deps: GitDeps = {
    ...defaultGitDeps,
    streamRecords: (repoPath, args, onRecord, signal) => {
      let count = 0;
      return defaultGitDeps.streamRecords(repoPath, args, (record) => (seen.push(++count), onRecord(record)), signal);
    },
  };

  const exported = valueOf(await createGitVcs(deps).exportCommit(repo, sha, destination, { ...JAVA_ONLY, budget: { maxEntries: 3, maxBytes: 1000 } }));

  assert.deepEqual(exported.stopped, { at: "d.java", limit: 3 });
  assert.deepEqual(exported.files.map((file) => [file.path, file.written]), [["a.java", true], ["b.txt", false]]);
  assert.deepEqual(exported.skipped, [{ path: "c-link", reason: "symlink" }]);
  assert.deepEqual(readdirSync(destination), ["a.java"]);
  assert.deepEqual(seen, [1, 2, 3, 4]);
});

test("a commit with exactly as many entries as the budget is not stopped", async () => {
  write("a.java", "class A {}");
  write("b.java", "class B {}");
  const sha = commitAll();

  const exported = valueOf(await createGitVcs().exportCommit(repo, sha, destination, { ...JAVA_ONLY, budget: { maxEntries: 2, maxBytes: 1000 } }));

  assert.equal(exported.stopped, undefined);
  assert.equal(exported.files.length, 2);
});

test("the byte budget counts the content written, stops before the first selected file that does not fit and exports what came before", async () => {
  write("a.java", "1234");
  write("b.java", "5678");
  write("c.java", "9012");
  write("d.java", "3");
  write("docs.txt", "x".repeat(500));
  const sha = commitAll();
  const exportWith = async (maxBytes: number) => {
    const target = mkdtempSync(join(scratch, "bytes-"));
    return { target, exported: valueOf(await createGitVcs().exportCommit(repo, sha, target, { ...JAVA_ONLY, budget: { maxEntries: 1000, maxBytes } })) };
  };

  const fits = await exportWith(13);
  const over = await exportWith(11);

  assert.equal(fits.exported.stopped, undefined);
  assert.deepEqual(readdirSync(fits.target).toSorted(), ["a.java", "b.java", "c.java", "d.java"]);
  assert.deepEqual(over.exported.stopped, { at: "c.java", limit: 11 });
  assert.deepEqual(over.exported.files.map((file) => [file.path, file.written]), [
    ["a.java", true],
    ["b.java", true],
    ["c.java", false],
    ["d.java", false],
    ["docs.txt", false],
  ]);
  assert.deepEqual(readdirSync(over.target).toSorted(), ["a.java", "b.java"]);
});

test("a selected blob larger than the whole byte budget is never opened for writing", async () => {
  write("big.java", "x".repeat(2000));
  const sha = commitAll();

  const exported = valueOf(await createGitVcs().exportCommit(repo, sha, destination, { ...JAVA_ONLY, budget: { maxEntries: 10, maxBytes: 1999 } }));

  assert.deepEqual(exported.stopped, { at: "big.java", limit: 1999 });
  assert.deepEqual(readdirSync(destination), []);
});

test("a blob cut short by a dying git process leaves no file handle open", { skip: process.platform === "win32" }, async () => {
  write("a.java", "abcdef");
  const sha = commitAll();
  const deps: GitDeps = {
    ...defaultGitDeps,
    streamBlobs: async (_repo, _blobs, sink) => {
      await sink.start(0, 6);
      await sink.write(Buffer.from("ab"));
      return { code: 128, stdout: Buffer.alloc(0), stderr: "fatal" };
    },
  };
  const openDescriptors = () => readdirSync("/dev/fd").length;
  const before = openDescriptors();

  const result = await createGitVcs(deps).exportCommit(repo, sha, destination, EVERYTHING);

  assert.equal(!result.ok && result.fault.kind, "git-failed");
  assert.equal(openDescriptors(), before);
});

test("when both budgets run out the stop reported is the earlier one in git's order", async () => {
  for (const name of ["a", "b", "c", "d", "e"]) write(`${name}.java`, "1234");
  const sha = commitAll();

  const exported = valueOf(await createGitVcs().exportCommit(repo, sha, destination, { ...JAVA_ONLY, budget: { maxEntries: 4, maxBytes: 5 } }));

  assert.deepEqual(exported.stopped, { at: "b.java", limit: 5 });
  assert.deepEqual(exported.files.map((file) => file.path), ["a.java", "b.java", "c.java", "d.java"]);
});

function branchFrom(commit: string, name: string): void {
  git("checkout", "-q", "-b", name, commit);
}

test("the merge base of a branch that forked is the fork point, not the tip of the branch it forked from", async () => {
  write("a.txt", "1\n");
  const fork = commitAll();
  git("branch", "-M", "main");
  branchFrom(fork, "feature");
  write("f.txt", "f\n");
  const feature = commitAll();
  git("checkout", "-q", "main");
  write("a.txt", "2\n");
  const main = commitAll();

  const result = await createGitVcs().mergeBase(repo, main, feature);

  assert.equal(valueOf(result), fork);
});

test("two commits that share no history have no merge base", async () => {
  write("a.txt", "1\n");
  const first = commitAll();
  git("checkout", "-q", "--orphan", "other");
  write("b.txt", "2\n");
  const second = commitAll();

  const result = await createGitVcs().mergeBase(repo, first, second);

  assert.equal(!result.ok && result.fault.kind, "no-merge-base");
});

test("a diff names the new-side lines of each hunk and treats a rename as a deletion and an addition", async () => {
  write("keep.ts", "a\nb\nc\nd\ne\n");
  write("old.ts", "x\ny\nz\n");
  const base = commitAll();
  write("keep.ts", "a\nB\nc\nd\ne\nf\n");
  git("mv", "old.ts", "new.ts");
  write("new.ts", "x\nY\nz\n");
  const head = commitAll();

  const changes = valueOf(await createGitVcs().diffCommits(repo, base, head));

  assert.deepEqual(changes.map((change) => [change.path, change.deleted, change.added, change.removals.map((removal) => removal.after)]), [
    ["keep.ts", false, [{ start: 2, end: 2 }, { start: 6, end: 6 }], []],
    ["new.ts", false, [{ start: 1, end: 3 }], []],
    ["old.ts", true, [], [0]],
  ]);
});

test("a source git would treat as binary, by attribute or by content, still gives its hunks", async () => {
  write(".gitattributes", "marked.ts -diff\n");
  write("marked.ts", "a\nb\n");
  write("nul.ts", "a\0\nb\n");
  const base = commitAll();
  write("marked.ts", "a\nB\n");
  write("nul.ts", "a\0\nB\n");
  const head = commitAll();

  const changes = valueOf(await createGitVcs().diffCommits(repo, base, head));

  assert.deepEqual(changes.map((change) => [change.path, change.binary, change.added]), [
    ["marked.ts", false, [{ start: 2, end: 2 }]],
    ["nul.ts", false, [{ start: 2, end: 2 }]],
  ]);
});

test("the diff command carries every option that could change the hunks", async () => {
  const sha = (digit: string): string => digit.repeat(40);
  let given: readonly string[] = [];
  const deps: GitDeps = {
    ...defaultGitDeps,
    streamLines: async (_repo, args) => {
      given = args;
      return { code: 0, stdout: Buffer.alloc(0), stderr: "" };
    },
  };

  valueOf(await createGitVcs(deps).diffCommits(repo, sha("a"), sha("b")));

  assert.deepEqual(given, [
    ..."diff-tree -r -p --no-ext-diff --no-textconv --no-renames --text --unified=0 --no-color --src-prefix=a/ --dst-prefix=b/".split(" "),
    sha("a"),
    sha("b"),
  ]);
});

test("a diff of anything but full commit shas is refused before git runs", async () => {
  const result = await createGitVcs().diffCommits(repo, "--output=/tmp/x", "HEAD");

  assert.equal(!result.ok && result.fault.kind, "unknown-revision");
});

test("a diff aborted by the caller answers aborted", async () => {
  write("a.ts", "a\n");
  const base = commitAll();
  write("a.ts", "b\n");
  const head = commitAll();
  const controller = new AbortController();
  controller.abort();

  const result = await createGitVcs().diffCommits(repo, base, head, controller.signal);

  assert.equal(!result.ok && result.fault.kind, "aborted");
});

test("the export and the revision lookup keep the user's git configuration, the merge base and the diff run without it", async () => {
  const home = join(scratch, "home");
  mkdirSync(home);
  writeFileSync(join(home, ".gitconfig"), "[alias]\n\tprobe = rev-parse --git-dir\n");
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const kept = await defaultGitDeps.runGit(repo, ["probe"]);
    const isolated = await defaultGitDeps.runIsolatedGit(repo, ["probe"]);
    const isolatedLines = await defaultGitDeps.streamLines(repo, ["probe"], () => undefined);

    assert.equal(kept.code, 0);
    assert.notEqual(isolated.code, 0);
    assert.notEqual(isolatedLines.code, 0);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
});

test("the merge base runs isolated, the revision lookup and the export do not", async () => {
  const sha = (digit: string): string => digit.repeat(40);
  const plain: string[] = [];
  const isolated: string[] = [];
  const deps: GitDeps = {
    ...defaultGitDeps,
    runGit: async (_repo, args) => (plain.push(args[0] ?? ""), { code: 0, stdout: Buffer.from(`${sha("a")}\n`), stderr: "" }),
    runIsolatedGit: async (_repo, args) => (isolated.push(args[0] ?? ""), { code: 0, stdout: Buffer.from(`${sha("a")}\n`), stderr: "" }),
  };
  const vcs = createGitVcs(deps);

  await vcs.mergeBase(repo, sha("a"), sha("b"));
  await vcs.resolveCommit(repo, "HEAD");

  assert.deepEqual(isolated, ["merge-base"]);
  assert.deepEqual(plain, ["rev-parse"]);
});

test("git runs with no ambient GIT_ variable, and an isolated run also has the user and system configuration empty", () => {
  const host = { GIT_DIR: "/elsewhere", GIT_CONFIG_GLOBAL: "/home/x/.gitconfig", GIT_EXTERNAL_DIFF: "evil", PATH: "/bin" };

  const plain = gitEnvironment(host, false);
  const isolated = gitEnvironment(host, true);

  assert.equal(plain.GIT_CONFIG_GLOBAL, undefined);
  assert.equal(plain.GIT_CONFIG_NOSYSTEM, undefined);
  assert.equal(isolated.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(isolated.GIT_CONFIG_NOSYSTEM, "1");
  for (const env of [plain, isolated]) {
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.GIT_EXTERNAL_DIFF, undefined);
    assert.equal(env.PATH, "/bin");
  }
});

function directoryWith(name: string, files: Record<string, string>): string {
  const directory = join(scratch, name);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(directory, path, ".."), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  mkdirSync(directory, { recursive: true });
  return directory;
}

test("two directories differ exactly as the commits holding the same content do", async () => {
  const before = { "keep.ts": "a\nb\nc\n", "gone.ts": "export function removed() {}\n", "src/deep/edit.ts": "x\ny\n", "sp ace.ts": "s\n" };
  const after = { "keep.ts": "a\nb\nc\n", "src/deep/edit.ts": "x\nY\nz\n", "fresh.ts": "export const fresh = 1;\n", "sp ace.ts": "t\n" };
  for (const [path, content] of Object.entries(before)) write(path, content);
  const base = commitAll();
  git("rm", "-q", "gone.ts");
  for (const [path, content] of Object.entries(after)) write(path, content);
  const head = commitAll();
  const vcs = createGitVcs();

  const commits = valueOf(await vcs.diffCommits(repo, base, head));
  const directories = valueOf(await vcs.diffDirectories(directoryWith("before", before), directoryWith("after", after)));

  assert.ok(commits.length > 0);
  assert.deepEqual(directories, commits);
});

test("two equal directories have no change", async () => {
  const files = { "a.ts": "a\n", "d/b.ts": "b\n" };

  const changes = valueOf(await createGitVcs().diffDirectories(directoryWith("one", files), directoryWith("two", files)));

  assert.deepEqual(changes, []);
});

test("directories inside a repository whose attributes mark a file -diff still diff as text", async () => {
  write(".gitattributes", "marked.ts -diff\n");
  write("before/marked.ts", "a\nb\n");
  write("after/marked.ts", "a\nB\n");
  git("add", "-A");

  const changes = valueOf(await createGitVcs().diffDirectories(join(repo, "before"), join(repo, "after")));

  assert.deepEqual(changes.map((change) => [change.path, change.binary, change.added]), [["marked.ts", false, [{ start: 2, end: 2 }]]]);
});

test("the directory diff carries the pinned options and runs outside the repository", async () => {
  let given: readonly string[] = [];
  let ran = "";
  const deps: GitDeps = {
    ...defaultGitDeps,
    streamLines: async (cwd, args) => {
      given = args;
      ran = cwd;
      return { code: 0, stdout: Buffer.alloc(0), stderr: "" };
    },
  };

  valueOf(await createGitVcs(deps).diffDirectories(directoryWith("one", {}), directoryWith("two", {})));

  assert.deepEqual(given, [
    ..."-c core.attributesFile=/dev/null diff --no-index --no-ext-diff --no-textconv --no-renames --text --unified=0 --no-color --src-prefix=a/ --dst-prefix=b/ base/ head/".split(" "),
  ]);
  assert.ok(!ran.startsWith(scratch));
});

test("a directory diff git cannot produce is git-failed and an aborted one answers aborted", async () => {
  const present = directoryWith("present", { "a.ts": "a\n" });
  const controller = new AbortController();
  controller.abort();

  const failed = await createGitVcs().diffDirectories(present, join(scratch, "missing"));
  const aborted = await createGitVcs().diffDirectories(present, present, controller.signal);

  assert.equal(!failed.ok && failed.fault.kind, "git-failed");
  assert.equal(!aborted.ok && aborted.fault.kind, "aborted");
});

test("headBranch names the branch HEAD points at", async () => {
  write("a.txt", "a");
  commitAll();
  git("checkout", "-q", "-b", "feature");

  assert.deepEqual(await createGitVcs().headBranch(repo), { ok: true, value: "feature" });
});

test("headBranch answers undefined on a detached head, which names no line", async () => {
  write("a.txt", "a");
  const sha = commitAll();
  git("checkout", "-q", "--detach", sha);

  assert.deepEqual(await createGitVcs().headBranch(repo), { ok: true, value: undefined });
});

test("headBranch answers git-failed outside a repository", async () => {
  const outside = join(scratch, "outside");
  mkdirSync(outside);

  const result = await createGitVcs().headBranch(outside);

  assert.equal(!result.ok && result.fault.kind, "git-failed");
});
