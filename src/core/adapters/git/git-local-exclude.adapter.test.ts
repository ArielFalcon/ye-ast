import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitLocalExclude, defaultLocalExcludeDeps } from "./git-local-exclude.adapter.ts";
import { defaultGitDeps } from "./git-vcs.adapter.ts";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
const LINES = [".ye-ast/", ".ye-ast-graph/"];

let scratch: string;
let repo: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ye-ast-exclude-"));
  repo = join(scratch, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

const excludeFile = (): string => join(repo, ".git", "info", "exclude");

test("the lines are appended to info/exclude and answered as added", async () => {
  const added = await createGitLocalExclude().ensure(repo, LINES);

  assert.deepEqual(added, { ok: true, value: LINES });
  assert.deepEqual(readFileSync(excludeFile(), "utf8").split("\n").slice(-3), [...LINES, ""]);
});

test("existing content is kept, and a second run adds nothing", async () => {
  const before = readFileSync(excludeFile(), "utf8");
  const exclude = createGitLocalExclude();
  await exclude.ensure(repo, LINES);
  const once = readFileSync(excludeFile(), "utf8");

  const again = await exclude.ensure(repo, LINES);

  assert.equal(once.startsWith(before), true);
  assert.deepEqual(again, { ok: true, value: [] });
  assert.equal(readFileSync(excludeFile(), "utf8"), once);
});

test("only the absent lines are appended, and a file without a final newline keeps its last line apart", async () => {
  writeFileSync(excludeFile(), "build/\n.ye-ast/");

  const added = await createGitLocalExclude().ensure(repo, LINES);

  assert.deepEqual(added, { ok: true, value: [".ye-ast-graph/"] });
  assert.equal(readFileSync(excludeFile(), "utf8"), "build/\n.ye-ast/\n.ye-ast-graph/\n");
});

test("a CRLF file is matched by line, so its existing lines are not added again", async () => {
  writeFileSync(excludeFile(), ".ye-ast/\r\n.ye-ast-graph/\r\n");

  assert.deepEqual(await createGitLocalExclude().ensure(repo, LINES), { ok: true, value: [] });
});

test("a missing info directory is created", async () => {
  rmSync(join(repo, ".git", "info"), { recursive: true, force: true });

  assert.deepEqual(await createGitLocalExclude().ensure(repo, LINES), { ok: true, value: LINES });
  assert.equal(readFileSync(excludeFile(), "utf8"), ".ye-ast/\n.ye-ast-graph/\n");
});

test("a linked worktree, whose .git is a file, appends to the shared exclude file and leaves git status clean", async () => {
  writeFileSync(join(repo, "a.txt"), "a");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  const worktree = join(scratch, "linked");
  git(repo, "worktree", "add", "-q", worktree);

  const added = await createGitLocalExclude().ensure(worktree, LINES);
  mkdirSync(join(worktree, ".ye-ast"));
  writeFileSync(join(worktree, ".ye-ast", "entrypoints.json"), "{}");

  assert.deepEqual(added, { ok: true, value: LINES });
  assert.equal(readFileSync(excludeFile(), "utf8").includes(".ye-ast/\n"), true);
  assert.equal(git(worktree, "status", "--porcelain"), "");
});

test("a tracked file is never edited", async () => {
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");

  await createGitLocalExclude().ensure(repo, LINES);

  assert.equal(readFileSync(join(repo, ".gitignore"), "utf8"), "node_modules/\n");
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("a directory that is not a repository is a git-failed fault", async () => {
  const result = await createGitLocalExclude().ensure(scratch, LINES);

  assert.equal(result.ok === false && result.fault.kind, "git-failed");
});

test("an exclude file that is a symbolic link is refused and its target is not written", async () => {
  const target = join(scratch, "elsewhere.txt");
  writeFileSync(target, "outside\n");
  rmSync(excludeFile());
  symlinkSync(target, excludeFile());

  const result = await createGitLocalExclude().ensure(repo, LINES);

  assert.equal(result.ok === false && result.fault.kind, "refused");
  assert.equal(readFileSync(target, "utf8"), "outside\n");
});

test("an info directory that leads outside git's common directory is refused and nothing is written there", async () => {
  const outside = join(scratch, "outside");
  mkdirSync(outside);
  rmSync(join(repo, ".git", "info"), { recursive: true, force: true });
  symlinkSync(outside, join(repo, ".git", "info"));

  const result = await createGitLocalExclude().ensure(repo, LINES);

  assert.equal(result.ok === false && result.fault.kind, "refused");
  assert.deepEqual(readdirSync(outside), []);
});

test("the exclude file and git's common directory are found with one run of the user's own git", async () => {
  const runs: Array<readonly string[]> = [];
  const exclude = createGitLocalExclude({
    ...defaultLocalExcludeDeps,
    git: {
      runGit: async (cwd, args, signal) => {
        runs.push(args);
        return defaultGitDeps.runGit(cwd, args, signal);
      },
    },
  });

  assert.deepEqual(await exclude.ensure(repo, LINES), { ok: true, value: LINES });
  assert.equal(runs.length, 1);
});
