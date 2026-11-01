import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "../../domain/shared/result.ts";
import { createGitWorkingTree } from "./git-working-tree.adapter.ts";

let scratch: string;
let repo: string;
let config: string;
const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };

const IDENTITY = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ye-ast-tree-"));
  repo = join(scratch, "repo");
  config = join(scratch, "config");
  mkdirSync(repo);
  mkdirSync(config);
  process.env.HOME = config;
  process.env.XDG_CONFIG_HOME = config;
  git("init", "-q");
});

afterEach(() => {
  if (saved.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = saved.HOME;
  if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved.XDG;
  rmSync(scratch, { recursive: true, force: true });
});

function git(...args: string[]): string {
  return gitIn(repo, ...args);
}

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...IDENTITY }, encoding: "utf8" }).trim();
}

function write(path: string, content = "x\n"): void {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function valueOf<T>(result: Result<T, unknown>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

async function listed(): Promise<Array<[string, boolean]>> {
  return valueOf(await createGitWorkingTree().list(repo)).paths.map((entry) => [entry.path, entry.submodule]);
}

test("lists tracked, modified and untracked paths, never an ignored one, in git's order", async () => {
  write(".gitignore", "ignored.ts\n");
  write("tracked.ts");
  write("src/modified.ts");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  write("src/modified.ts", "changed\n");
  write("untracked.ts");
  write("ignored.ts");

  assert.deepEqual(await listed(), [
    [".gitignore", false],
    ["src/modified.ts", false],
    ["tracked.ts", false],
    ["untracked.ts", false],
  ]);
});

test("a global ignore file does not drop a path", async () => {
  mkdirSync(join(config, "git"));
  writeFileSync(join(config, "git", "ignore"), "global.ts\n");
  write("global.ts");

  assert.deepEqual(await listed(), [["global.ts", false]]);
});

test("a tracked file deleted from the working tree is still listed", async () => {
  write("gone.ts");
  git("add", "-A");
  rmSync(join(repo, "gone.ts"));

  assert.deepEqual(await listed(), [["gone.ts", false]]);
});

test("a submodule entry and an untracked nested repository are marked submodule", async () => {
  write("a.ts");
  git("add", "a.ts");
  git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor/lib`);
  mkdirSync(join(repo, "nested"));
  gitIn(join(repo, "nested"), "init", "-q");
  writeFileSync(join(repo, "nested", "inside.ts"), "x\n");

  assert.deepEqual(await listed(), [
    ["a.ts", false],
    ["nested", true],
    ["vendor/lib", true],
  ]);
});

test("engine entries are absent at any depth while .gitignore and codegraph.json stay", async () => {
  write(".codegraph/db");
  write(".ye-ast/layer");
  write(".ye-ast-graph/g");
  write("pkg/.codegraph/db");
  write("codegraph.json", "{}\n");
  write(".gitignore", "");
  write("a.ts");

  assert.deepEqual(await listed(), [
    [".gitignore", false],
    ["a.ts", false],
    ["codegraph.json", false],
  ]);
});

test("a listing leaves the user's index byte- and mtime-unchanged", async () => {
  write("a.ts");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  write("b.ts");
  const index = join(repo, ".git", "index");
  const before = { bytes: readFileSync(index), mtime: statSync(index).mtimeMs };
  await new Promise((resolve) => setTimeout(resolve, 20));

  await listed();

  assert.deepEqual(readFileSync(index), before.bytes);
  assert.equal(statSync(index).mtimeMs, before.mtime);
});

test("a subdirectory answers not-repository-root and an aborted signal answers aborted", async () => {
  write("sub/a.ts");
  const controller = new AbortController();
  controller.abort();

  const sub = await createGitWorkingTree().list(join(repo, "sub"));
  const aborted = await createGitWorkingTree().list(repo, controller.signal);

  assert.equal(!sub.ok && sub.fault.kind, "not-repository-root");
  assert.equal(!aborted.ok && aborted.fault.kind, "aborted");
});

test("reports the object format of the repository", async () => {
  assert.equal(valueOf(await createGitWorkingTree().list(repo)).objectFormat, "sha1");
});
