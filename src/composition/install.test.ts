import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import { RECORDS_DIRECTORY } from "../core/adapters/fs/trust-record.adapter.ts";
import { composeCli, composeQueries } from "./compose.ts";
import { processHost } from "./process-host.ts";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const CONTROLLER = `package shop;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/orders")
class OrderController {
  @GetMapping("/{id}")
  String one() { return ""; }
}
`;

let workspace: string;
let repo: string;
let trustDirectory: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-install-"));
  repo = join(workspace, "shop-service");
  trustDirectory = join(workspace, "config", "ye-ast");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(workspace, "scratch"));
  git("init", "-q");
  writeFileSync(join(repo, "src", "OrderController.java"), CONTROLLER);
  git("add", "-A");
  git("commit", "-q", "-m", "controller");
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim();
}

async function cli(...argv: string[]): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), trustDirectory, reportTrustFault: (line) => stderr.push(line) })(argv, { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  return { code, stdout, stderr };
}

async function mapTrust(path = repo): Promise<string> {
  const { stdout } = await cli("map", path);
  return JSON.parse(stdout.join("\n")).inputs.trust;
}

test("install records the trust outside the repository, writes the fixed layer, excludes ye-ast's folders and prints the registration", async () => {
  const { code, stdout, stderr } = await cli("install", "--trust", "untrusted", repo);

  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  assert.ok(stdout.some((line) => /^\.ye-ast\/entrypoints\.json: written$/.test(line)));
  assert.ok(stdout.some((line) => /^claude mcp add ye-ast -- npx --yes tsx \S+\/src\/composition\/main\.ts mcp /.test(line) && line.endsWith(` mcp ${repo}`)));
  assert.equal(JSON.parse(readFileSync(join(repo, ".ye-ast", "entrypoints.json"), "utf8")).inputs.trust, "untrusted");
  const [recordName] = readdirSync(join(trustDirectory, RECORDS_DIRECTORY));
  assert.deepEqual(JSON.parse(readFileSync(join(trustDirectory, RECORDS_DIRECTORY, recordName!), "utf8")), { version: 1, repository: realpathSync(repo), trust: "untrusted" });
});

test("install writes nothing in the repository but .ye-ast/ and the local exclude file, and leaves git status clean", async () => {
  const before = readdirSync(repo).sort();
  const tracked = git("ls-files", "-s");

  const { code } = await cli("install", "--trust", "trusted", repo);

  assert.equal(code, EXIT_CODE.ok);
  assert.deepEqual(readdirSync(repo).sort(), [...before, ".ye-ast"].sort());
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(git("ls-files", "-s"), tracked);
  assert.equal(readFileSync(join(repo, ".git", "info", "exclude"), "utf8").endsWith(".ye-ast/\n.ye-ast-graph/\n"), true);
  assert.equal(statSync(trustDirectory).mode & 0o777, 0o700);
});

test("a second install changes nothing: the layer is unchanged and the exclude file is not extended", async () => {
  await cli("install", "--trust", "untrusted", repo);
  const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");

  const { code, stdout } = await cli("install", "--trust", "untrusted", repo);

  assert.equal(code, EXIT_CODE.ok);
  assert.ok(stdout.some((line) => /^\.ye-ast\/entrypoints\.json: unchanged$/.test(line)));
  assert.equal(readFileSync(join(repo, ".git", "info", "exclude"), "utf8"), exclude);
});

test("install of a subdirectory or of a directory without a repository records nothing", async () => {
  const subdirectory = await cli("install", "--trust", "trusted", join(repo, "src"));
  const bare = await cli("install", "--trust", "trusted", workspace);

  assert.equal(subdirectory.code, EXIT_CODE.queryFailed);
  assert.equal(bare.code, EXIT_CODE.queryFailed);
  assert.equal(readdirSync(workspace).includes("config"), false);
  assert.deepEqual(readdirSync(join(repo, "src")), ["OrderController.java"]);
});

test("map reads untrusted without a record, the recorded mode after install, and the new mode after a reinstall", async () => {
  assert.equal(await mapTrust(), "untrusted");

  await cli("install", "--trust", "trusted", repo);
  assert.equal(await mapTrust(), "trusted");

  await cli("install", "--trust", "untrusted", repo);
  assert.equal(await mapTrust(), "untrusted");
  assert.equal(JSON.parse(readFileSync(join(repo, ".ye-ast", "entrypoints.json"), "utf8")).inputs.trust, "untrusted");
});

test("the impact operations read the record too", async () => {
  await cli("install", "--trust", "trusted", repo);

  const { code, stdout, stderr } = await cli("importers", repo, "src/OrderController.java");

  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  assert.equal(JSON.parse(stdout.join("\n")).inputs.trust, "trusted");
});

test("another spelling of the repository's directory reads the same record, and another repository is untouched", async () => {
  const link = join(workspace, "link");
  symlinkSync(repo, link);
  const other = join(workspace, "other");
  mkdirSync(other);
  execFileSync("git", ["init", "-q"], { cwd: other, env: GIT_ENV });
  writeFileSync(join(other, "a.txt"), "a");
  execFileSync("git", ["add", "-A"], { cwd: other, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "a"], { cwd: other, env: GIT_ENV });

  await cli("install", "--trust", "trusted", link);

  assert.equal(await mapTrust(repo), "trusted");
  assert.equal(await mapTrust(other), "untrusted");
});

test("the MCP host reads the record and the query-protocol host ignores it", async () => {
  await cli("install", "--trust", "trusted", repo);
  const host = processHost({ signal: new AbortController().signal, trustDirectory });
  const mapped = async (queries: ReturnType<typeof host.queries>): Promise<string> => {
    const result = await queries.entrypoints.map({ repo, repoId: "shop", revision: "HEAD" });
    assert.ok(result.ok);
    return result.value.inputs.trust;
  };

  assert.equal(await mapped(host.queries({ trustRecord: true })), "trusted");
  assert.equal(await mapped(host.queries()), "untrusted");
});

test("a refused trust record runs the repository untrusted and says so once", async () => {
  await cli("install", "--trust", "trusted", repo);
  chmodSync(trustDirectory, 0o777);
  const lines: string[] = [];
  const queries = composeQueries({ scratchRoot: join(workspace, "scratch"), trustDirectory, reportTrustFault: (line) => lines.push(line) });

  const first = await queries.entrypoints.map({ repo, repoId: "shop", revision: "HEAD" });
  await queries.entrypoints.map({ repo, repoId: "shop", revision: "HEAD" });

  assert.ok(first.ok);
  assert.equal(first.value.inputs.trust, "untrusted");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /refused/);
});

test("an install that stops after the trust was recorded says so and keeps the record", async () => {
  const exclude = join(repo, ".git", "info", "exclude");
  rmSync(exclude);
  symlinkSync(join(workspace, "elsewhere.txt"), exclude);

  const { code, stderr } = await cli("install", "--trust", "trusted", repo);

  assert.equal(code, EXIT_CODE.queryFailed);
  assert.match(stderr[0]!, /recorded/);
  assert.equal(readdirSync(join(trustDirectory, RECORDS_DIRECTORY)).length, 1);
  assert.equal(readdirSync(repo).includes(".ye-ast"), false);
});
