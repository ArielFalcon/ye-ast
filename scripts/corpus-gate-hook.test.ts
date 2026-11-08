import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { passMarkerPath } from "./corpus-gate.ts";

const HOOKS = resolve(import.meta.dirname, "..", ".githooks");
const ENVIRONMENT = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const roots: string[] = [];

function run(cwd: string, ...args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8", env: ENVIRONMENT });
}

function git(cwd: string, ...args: string[]): string {
  const result = run(cwd, ...args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commit(repo: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git(repo, "add", "--all");
  git(repo, "commit", "--quiet", "--message", Object.keys(files).join(" "));
  return git(repo, "rev-parse", "HEAD");
}

/** main at a base commit; `core` changes behavior under src/core/, `quiet` changes only docs and a test there. */
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "corpus-gate-hook-"));
  roots.push(repo);
  git(repo, "init", "--quiet", "--initial-branch", "main");
  const base = commit(repo, { "src/core/rule.ts": "1", "docs/a.md": "a" });
  git(repo, "checkout", "--quiet", "-b", "core");
  const core = commit(repo, { "src/core/rule.ts": "2" });
  git(repo, "checkout", "--quiet", "-b", "quiet", base);
  const quiet = commit(repo, { "docs/a.md": "b", "src/core/rule.test.ts": "t", "src/core/fake.testing.ts": "f" });
  git(repo, "config", "core.hooksPath", HOOKS);
  return { repo, base, core, quiet, main: () => git(repo, "rev-parse", "main") };
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("reference-transaction hook", () => {
  it("refuses to move main onto a behavior change no gate passed, by update-ref, by a fetch into main and by a merge", () => {
    const byUpdateRef = fixture();
    assert.notEqual(run(byUpdateRef.repo, "update-ref", "refs/heads/main", byUpdateRef.core).status, 0);
    assert.equal(byUpdateRef.main(), byUpdateRef.base);

    const byFetch = fixture();
    assert.notEqual(run(byFetch.repo, "fetch", "--quiet", ".", "core:main").status, 0);
    assert.equal(byFetch.main(), byFetch.base);

    const byMerge = fixture();
    git(byMerge.repo, "checkout", "--quiet", "main");
    assert.notEqual(run(byMerge.repo, "merge", "--quiet", "--no-ff", "--no-edit", "core").status, 0);
    assert.equal(byMerge.main(), byMerge.base);
  });

  it("lets main move once the gate recorded a pass for exactly that change of tree", () => {
    const { repo, base, core, main } = fixture();
    const marker = passMarkerPath(join(repo, ".git"), git(repo, "rev-parse", `${base}^{tree}`), git(repo, "rev-parse", `${core}^{tree}`));
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, "pass\n");
    assert.equal(run(repo, "update-ref", "refs/heads/main", core).status, 0);
    assert.equal(main(), core);
  });

  it("lets main move without a gate when the change touches only docs and test files under src/core", () => {
    const { repo, quiet, main } = fixture();
    assert.equal(run(repo, "fetch", "--quiet", ".", "quiet:main").status, 0);
    assert.equal(main(), quiet);
  });

  it("never gates a branch other than main", () => {
    const { repo, core } = fixture();
    assert.equal(run(repo, "update-ref", "refs/heads/elsewhere", core).status, 0);
  });
});
