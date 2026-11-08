import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Answer } from "./corpus-gate-diff.ts";
import { EXIT, passMarkerPath, runGate } from "./corpus-gate.ts";

const GIT_IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

/**
 * A stand-in engine CLI: lists the repository's files, says whether `init` declared it trusted, echoes the git protocol
 * policy, refuses a workspace without repositories as the engine does, and prints its repository path reversed, a form
 * no normalization recognizes, as an engine that rewrites a path would.
 */
function engineSource(extra: string): string {
  return `import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const [command, ...args] = process.argv.slice(2);
const trustFile = join(process.env.XDG_CONFIG_HOME ?? "", "trusted");
const repo = args.at(-1) ?? "";
if (command === "init") {
  const workspace = args.indexOf("--workspace");
  if (workspace !== -1 && JSON.parse(readFileSync(args[workspace + 1], "utf8")).repos.length === 0) process.exit(1);
  mkdirSync(process.env.XDG_CONFIG_HOME ?? "", { recursive: true });
  appendFileSync(trustFile, repo + "\\n");
  console.log("declared " + repo);
} else {
  const files = execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" }).split("\\n").filter(Boolean);
  const trusted = existsSync(trustFile) && readFileSync(trustFile, "utf8").split("\\n").includes(repo);
  console.log(JSON.stringify({ status: "complete", repo, reversed: [...repo].reverse().join(""), trusted, protocols: process.env.GIT_ALLOW_PROTOCOL, files: [...files, ${extra}] }));
}
`;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_IDENTITY } }).trim();
}

function commit(repo: string, files: Record<string, string>, message: string): string {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content);
  git(repo, "add", "--all");
  git(repo, "commit", "--quiet", "--message", message);
  return git(repo, "rev-parse", "HEAD");
}

describe("corpus gate", () => {
  let root: string;
  let engine: string;
  let corpus: string;
  let manifest: string;
  let store: string;
  const commits: Record<"base" | "same" | "adds" | "lockfile", string> = { base: "", same: "", adds: "", lockfile: "" };

  before(() => {
    root = mkdtempSync(join(tmpdir(), "corpus-gate-test-"));
    corpus = join(root, "corpus", "app");
    mkdirSync(corpus, { recursive: true });
    git(corpus, "init", "--quiet");
    const corpusSha = commit(corpus, { "a.txt": "a", "b.txt": "b" }, "corpus");

    engine = join(root, "engine");
    mkdirSync(engine);
    git(engine, "init", "--quiet");
    writeFileSync(join(engine, ".gitignore"), "node_modules\n");
    symlinkSync(resolve(import.meta.dirname, "..", "node_modules"), join(engine, "node_modules"));
    const packageJson = JSON.stringify({ type: "module", scripts: { cli: "node --import tsx main.ts" } });
    commits.base = commit(engine, { "package.json": packageJson, "main.ts": engineSource("") }, "base");
    commits.same = commit(engine, { "main.ts": `// same behavior\n${engineSource("")}` }, "same");
    commits.adds = commit(engine, { "main.ts": engineSource(`"extra"`) }, "adds");
    git(engine, "checkout", "--quiet", "--detach", commits.base);
    commits.lockfile = commit(engine, { "package-lock.json": "{}" }, "lockfile");
    git(engine, "checkout", "--quiet", "--detach", commits.base);
    store = join(engine, ".git", "corpus-gate");

    manifest = join(root, "manifest", "corpus.json");
    mkdirSync(join(root, "manifest"));
    writeFileSync(manifest, JSON.stringify({
      groups: [{
        id: "g",
        repos: [{ id: "app", path: "../corpus/app", sha: corpusSha }],
        workspace: { launch: "app", members: [] },
        queries: [
          { id: "list", family: "files", argv: ["list", "{repo:app}"] },
          { id: "list-trusted", family: "files", trusted: true, argv: ["list", "{repo:app}"] },
        ],
      }],
    }));
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  function gate(...args: string[]) {
    const out: string[] = [];
    const code = runGate(["--corpus", manifest, "--engine", engine, ...args], { out: (line) => out.push(line), err: () => {} });
    const reportFile = out.find((line) => line.startsWith("report: "))?.slice("report: ".length).replace(/report\.md$/u, "report.json");
    return { code, out, report: reportFile === undefined ? undefined : JSON.parse(readFileSync(reportFile, "utf8")) };
  }

  const tree = (rev: string) => git(engine, "rev-parse", `${rev}^{tree}`);

  it("passes engines that answer alike, shows both the same paths, records the pass, and leaves the corpus untouched", () => {
    const corpusBefore = [git(corpus, "status", "--porcelain", "--ignored"), git(corpus, "for-each-ref"), git(corpus, "worktree", "list")];
    const { code, report, out } = gate("--base", commits.base, "--candidate", commits.same);
    assert.equal(code, EXIT.pass);
    assert.equal(report.counts.differing, 0);
    assert.ok(existsSync(passMarkerPath(join(engine, ".git"), tree(commits.base), tree(commits.same))));
    assert.ok(out.some((line) => line.startsWith("Corpus-Gate: pass ")));
    assert.deepEqual([git(corpus, "status", "--porcelain", "--ignored"), git(corpus, "for-each-ref"), git(corpus, "worktree", "list")], corpusBefore);
    const answers = JSON.parse(readFileSync(join(report.candidate.answers, "answers.json"), "utf8")) as Answer[];
    assert.deepEqual(answers.filter((answer) => answer.exit !== 0).map((answer) => answer.id), []);
    const byId = new Map(answers.map((answer) => [answer.id, answer.stdout as { trusted: boolean; protocols: string; repo: string }]));
    assert.equal(byId.get("g/list")?.trusted, false);
    assert.equal(byId.get("g/list-trusted")?.trusted, true);
    assert.equal(byId.get("g/list")?.protocols, "file");
    assert.equal(git(engine, "worktree", "list").split("\n").length, 1);
  });

  it("fails an added element under none and passes it under its family's +, reusing the answers of the base", () => {
    const failed = gate("--base", commits.base, "--candidate", commits.adds);
    assert.equal(failed.code, EXIT.fail);
    assert.deepEqual(failed.report.violations.map((violation: { rule: string }) => violation.rule), ["undeclared-family", "undeclared-family"]);
    assert.equal(existsSync(passMarkerPath(join(engine, ".git"), tree(commits.base), tree(commits.adds))), false);

    const passed = gate("--base", commits.base, "--candidate", commits.adds, "--expect", "files:+");
    assert.equal(passed.code, EXIT.pass);
    assert.equal(passed.report.base.cached, true);
    assert.equal(passed.report.families[0].added, 2);
  });

  it("refuses a revision whose lockfile is not the installed one, before running anything", () => {
    const { code, report } = gate("--base", commits.base, "--candidate", commits.lockfile);
    assert.equal(code, EXIT.fault);
    assert.equal(report, undefined);
  });

  it("refuses to run while another run holds the lock", () => {
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "lock"), "1\n");
    try {
      assert.equal(gate("--base", commits.base, "--candidate", commits.same).code, EXIT.fault);
    } finally {
      rmSync(join(store, "lock"));
    }
  });
});
