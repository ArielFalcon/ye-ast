import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import { RECORDS_DIRECTORY } from "../core/adapters/fs/trust-record.adapter.ts";
import type { DecisionValue } from "../core/ports/decision-queries.port.ts";
import type { WorkspaceValue } from "../core/ports/workspace-queries.port.ts";
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

test("init records the trust outside the repository, writes the fixed layer, excludes ye-ast's folders and prints the registration", async () => {
  const { code, stdout, stderr } = await cli("init", "--trust", "untrusted", repo);

  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  assert.ok(stdout.some((line) => /^\.ye-ast\/entrypoints\.json: written$/.test(line)));
  assert.ok(stdout.some((line) => /^claude mcp add ye-ast -- npx --yes tsx \S+\/src\/composition\/main\.ts mcp /.test(line) && line.endsWith(` mcp ${repo}`)));
  assert.equal(JSON.parse(readFileSync(join(repo, ".ye-ast", "entrypoints.json"), "utf8")).inputs.trust, "untrusted");
  const [recordName] = readdirSync(join(trustDirectory, RECORDS_DIRECTORY));
  assert.deepEqual(JSON.parse(readFileSync(join(trustDirectory, RECORDS_DIRECTORY, recordName!), "utf8")), { version: 1, repository: realpathSync(repo), trust: "untrusted" });
});

test("init writes nothing in the repository but .ye-ast/ and the local exclude file, and leaves git status clean", async () => {
  const before = readdirSync(repo).sort();
  const tracked = git("ls-files", "-s");

  const { code } = await cli("init", "--trust", "trusted", repo);

  assert.equal(code, EXIT_CODE.ok);
  assert.deepEqual(readdirSync(repo).sort(), [...before, ".ye-ast"].sort());
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(git("ls-files", "-s"), tracked);
  assert.equal(readFileSync(join(repo, ".git", "info", "exclude"), "utf8").endsWith(".ye-ast/\n.ye-ast-graph/\n"), true);
  assert.equal(statSync(trustDirectory).mode & 0o777, 0o700);
});

test("a second install changes nothing: the layer is unchanged and the exclude file is not extended", async () => {
  await cli("init", "--trust", "untrusted", repo);
  const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");

  const { code, stdout } = await cli("init", "--trust", "untrusted", repo);

  assert.equal(code, EXIT_CODE.ok);
  assert.ok(stdout.some((line) => /^\.ye-ast\/entrypoints\.json: unchanged$/.test(line)));
  assert.equal(readFileSync(join(repo, ".git", "info", "exclude"), "utf8"), exclude);
});

test("init of a subdirectory or of a directory without a repository records nothing", async () => {
  const subdirectory = await cli("init", "--trust", "trusted", join(repo, "src"));
  const bare = await cli("init", "--trust", "trusted", workspace);

  assert.equal(subdirectory.code, EXIT_CODE.queryFailed);
  assert.equal(bare.code, EXIT_CODE.queryFailed);
  assert.equal(readdirSync(workspace).includes("config"), false);
  assert.deepEqual(readdirSync(join(repo, "src")), ["OrderController.java"]);
});

test("map reads untrusted without a record, the recorded mode after install, and the new mode after a reinstall", async () => {
  assert.equal(await mapTrust(), "untrusted");

  await cli("init", "--trust", "trusted", repo);
  assert.equal(await mapTrust(), "trusted");

  await cli("init", "--trust", "untrusted", repo);
  assert.equal(await mapTrust(), "untrusted");
  assert.equal(JSON.parse(readFileSync(join(repo, ".ye-ast", "entrypoints.json"), "utf8")).inputs.trust, "untrusted");
});

test("the impact operations read the record too", async () => {
  await cli("init", "--trust", "trusted", repo);

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

  await cli("init", "--trust", "trusted", link);

  assert.equal(await mapTrust(repo), "trusted");
  assert.equal(await mapTrust(other), "untrusted");
});

test("the MCP host reads the record and the query-protocol host ignores it", async () => {
  await cli("init", "--trust", "trusted", repo);
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
  await cli("init", "--trust", "trusted", repo);
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

test("an init that stops after the trust was recorded says so and keeps the record", async () => {
  const exclude = join(repo, ".git", "info", "exclude");
  rmSync(exclude);
  symlinkSync(join(workspace, "elsewhere.txt"), exclude);

  const { code, stderr } = await cli("init", "--trust", "trusted", repo);

  assert.equal(code, EXIT_CODE.queryFailed);
  assert.match(stderr[0]!, /recorded/);
  assert.equal(readdirSync(join(trustDirectory, RECORDS_DIRECTORY)).length, 1);
  assert.equal(readdirSync(repo).includes(".ye-ast"), false);
});

test("init --workspace persists the manifest under .ye-ast/ and a second run leaves it unchanged", async () => {
  const committed = (path: string): string => {
    mkdirSync(path);
    execFileSync("git", ["init", "-q"], { cwd: path, env: GIT_ENV });
    writeFileSync(join(path, "orders.txt"), "orders");
    execFileSync("git", ["add", "-A"], { cwd: path, env: GIT_ENV });
    execFileSync("git", ["commit", "-q", "-m", "orders"], { cwd: path, env: GIT_ENV });
    return path;
  };
  committed(join(workspace, "orders-service"));
  const billing = committed(join(workspace, "billing-service"));
  const manifest = join(workspace, "workspace.json");
  writeFileSync(manifest, JSON.stringify({ gateways: [{ prefix: "orders-api", repo: "orders" }], repos: [{ path: "../orders-service" }, { path: billing }] }));

  const first = await cli("init", "--trust", "untrusted", "--workspace", manifest, repo);
  const stored = readFileSync(join(repo, ".ye-ast", "workspace.json"), "utf8");
  const second = await cli("init", "--trust", "untrusted", "--workspace", manifest, repo);

  assert.equal(first.code, EXIT_CODE.ok, first.stderr.join("\n"));
  assert.ok(first.stdout.some((line) => /^\.ye-ast\/workspace\.json: written$/.test(line)));
  assert.deepEqual(JSON.parse(stored), { repos: [{ path: "../orders-service" }, { path: billing }], gateways: [{ prefix: "orders-api", repo: "orders" }] });
  assert.ok(second.stdout.some((line) => /^\.ye-ast\/workspace\.json: unchanged$/.test(line)));
  assert.equal(readFileSync(join(repo, ".ye-ast", "workspace.json"), "utf8"), stored);
});

test("init --workspace refuses a repository the query families cannot read, before it records anything", async () => {
  mkdirSync(join(workspace, "not-a-repo"));
  const manifest = join(workspace, "workspace.json");
  writeFileSync(manifest, JSON.stringify({ repos: [{ path: "../not-a-repo" }] }));

  const { code, stderr } = await cli("init", "--trust", "untrusted", "--workspace", manifest, repo);

  assert.equal(code, EXIT_CODE.queryFailed);
  assert.match(stderr.join("\n"), /^ye-ast: git-failed: repos\[0\]\.path: fatal: not a git repository/m);
  assert.equal(existsSync(join(repo, ".ye-ast")), false);
  assert.equal(existsSync(trustDirectory), false);
});

test("a workspace query that names no repositories works over the manifest install persisted", async () => {
  const other = join(workspace, "orders-service");
  mkdirSync(other);
  execFileSync("git", ["init", "-q"], { cwd: other, env: GIT_ENV });
  writeFileSync(join(other, "orders.txt"), "orders");
  execFileSync("git", ["add", "-A"], { cwd: other, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "orders"], { cwd: other, env: GIT_ENV });
  const manifest = join(workspace, "workspace.json");
  writeFileSync(manifest, JSON.stringify({ repos: [{ path: "../orders-service", id: "orders" }] }));
  await cli("init", "--trust", "trusted", "--workspace", manifest, repo);

  const result = await composeQueries({ scratchRoot: join(workspace, "scratch"), trustDirectory }).workspace.outwardNames({ repo: { path: repo, id: "shop" } });

  assert.ok(result.ok);
  assert.notEqual(result.value.fact.status, "unknown");
  assert.deepEqual((result.value.fact as { value: WorkspaceValue }).value.workspace, { repos: ["orders", "shop"], gateways: [], source: "persisted" });
});

const ORDER_PAGE = `import { HttpClient } from "@angular/common/http";
import { inject } from "@angular/core";

export class OrderPage {
  private readonly http = inject(HttpClient);
  open(): void {
    this.http.get("shop-api/orders/7");
  }
}
`;

const CLIENT_CONFIG = ["spring:", "  clients:", "    systems:", "      orders:", "        endpoints:", "          getOrder:", "            url: http://orders-svc:8080/orders/{id}", "            method: GET"].join("\n");

test("a form-shaped answer set persisted by install closes every gap the next query derives", async () => {
  const sibling = (name: string): string => {
    const root = join(workspace, name);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "OrderController.java"), CONTROLLER);
    const run = (...args: string[]): void => {
      execFileSync("git", args, { cwd: root, env: GIT_ENV });
    };
    run("init", "-q");
    run("add", "-A");
    run("commit", "-q", "-m", name);
    return root;
  };
  const siblings = ["orders-a", "orders-b", "orders-svc"].map(sibling);
  mkdirSync(join(repo, "web", "src", "app"), { recursive: true });
  mkdirSync(join(repo, "src", "main", "resources"), { recursive: true });
  writeFileSync(join(repo, "web", "src", "app", "order.page.ts"), ORDER_PAGE);
  writeFileSync(join(repo, "src", "main", "resources", "application.yaml"), CLIENT_CONFIG);
  git("add", "-A");
  git("commit", "-q", "-m", "client");

  const options = { scratchRoot: join(workspace, "scratch"), trustDirectory };
  const gaps = async (ask: { repo: { path: string }; repos?: { path: string }[] }): Promise<string[]> => {
    const result = await composeQueries(options).decisions.decisions(ask);
    assert.ok(result.ok);
    assert.notEqual(result.value.fact.status, "unknown");
    return (result.value.fact as { value: DecisionValue }).value.decisions.map((decision) => decision.id);
  };

  assert.deepEqual(await gaps({ repo: { path: repo }, repos: siblings.map((path) => ({ path })) }), [
    "gateway:shop-api",
    "membership:clone:orders-a",
    "membership:clone:orders-b",
    "membership:name:http://orders-svc:8080/orders/{id}",
    "repository:shop-api",
    "trust:orders-a",
    "trust:orders-b",
    "trust:orders-svc",
    "trust:shop-service",
  ]);

  const manifest = join(workspace, "workspace.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      repos: [
        { path: "../orders-a", id: "orders-a", remote: "https://git.example.test/orders-a.git" },
        { path: "../orders-b", id: "orders-b" },
        { path: "../orders-svc", id: "orders-svc" },
      ],
      gateways: [{ prefix: "shop-api", repo: "orders-a" }],
    }),
  );
  assert.equal((await cli("init", "--trust", "trusted", "--workspace", manifest, repo)).code, EXIT_CODE.ok);
  for (const path of siblings) assert.equal((await cli("init", "--trust", "untrusted", path)).code, EXIT_CODE.ok);
  assert.match(readFileSync(join(repo, ".ye-ast", "workspace.json"), "utf8"), /"remote": "https:\/\/git\.example\.test\/orders-a\.git"/);

  assert.deepEqual(await gaps({ repo: { path: repo } }), []);
});
