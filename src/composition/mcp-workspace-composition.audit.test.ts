import { resultFields } from "../mcp/test-session.testing.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { composeCli } from "./compose.ts";

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
  String one() {
    String combined = first() + second();
    return "x";
  }
  String first() { return "a"; }
  String second() { return "b"; }
}
`;

const COMPONENT = `import { HttpClient } from "@angular/common/http";
import { inject } from "@angular/core";

export class OrderPage {
  private readonly http = inject(HttpClient);
  open(): void {
    this.http.get("shop-api/orders/7");
  }
  missing(): void {
    this.http.get("shop-api/refunds/7");
  }
}
`;

const SERVER = pathToFileURL(join(import.meta.dirname, "mcp.ts")).href;
const HOST = pathToFileURL(join(import.meta.dirname, "process-host.ts")).href;
const MAIN = `import { runMcp } from ${JSON.stringify(SERVER)};
import { processHost } from ${JSON.stringify(HOST)};
process.exitCode = await runMcp([".", "--repo", "foreign", process.env.FOREIGN_ROOT!], processHost({ signal: new AbortController().signal, trustDirectory: process.env.TRUST_ROOT!, indexCache: process.env.INDEX_ROOT! }));
`;

let workspace: string;
let repo: string;
let frontend: string;
let scratchRoot: string;
let child: ChildProcessWithoutNullStreams;
let id = 0;
type Reply = { id?: number; result?: unknown; error?: unknown };
const replies = new Map<number, (message: Reply) => void>();

function request(method: string, params?: unknown): Promise<Reply> {
  id += 1;
  return new Promise((resolve) => {
    replies.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) })}\n`);
  });
}

before(async () => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-"));
  repo = join(workspace, "shop-service");
  scratchRoot = join(workspace, "scratch");
  mkdirSync(repo);
  mkdirSync(scratchRoot);
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  const controller = join(repo, "src/main/java/shop/OrderController.java");
  mkdirSync(dirname(controller), { recursive: true });
  writeFileSync(controller, CONTROLLER);
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  frontend = join(workspace, "shop-web");
  mkdirSync(join(frontend, "src/app"), { recursive: true });
  writeFileSync(join(frontend, "src/app/order.page.ts"), COMPONENT);
  const gitFrontend = (...args: string[]): string => execFileSync("git", args, { cwd: frontend, env: GIT_ENV, encoding: "utf8" }).trim();
  gitFrontend("init", "-q", "-b", "main");
  const foreignController = join(frontend, "src/main/java/shop/OrderController.java");
  mkdirSync(dirname(foreignController), { recursive: true });
  writeFileSync(foreignController, CONTROLLER.replace("/orders", "/foreign"));
  gitFrontend("add", "-A");
  gitFrontend("commit", "-q", "-m", "init");
  const entry = join(workspace, "main.mts");
  writeFileSync(entry, MAIN);
  child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), entry], {
    cwd: repo,
    env: { ...GIT_ENV, XDG_CACHE_HOME: join(workspace, "cache"), TMPDIR: scratchRoot, FOREIGN_ROOT: frontend, TRUST_ROOT: join(workspace, "trust"), INDEX_ROOT: join(workspace, "index") },
  });
  child.stderr.pipe(process.stderr);
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as Reply;
    if (message.id !== undefined) replies.get(message.id)?.(message);
  });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
});

after(async () => {
  child.stdin.end();
  await new Promise((resolve) => child.once("close", resolve));
  rmSync(workspace, { recursive: true, force: true });
});

test("workspace queries preserve real evidence across execution orders and coordinate transfers", async () => {
  const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf8" }).trim();
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "src/main/java/shop/OrderController.java"), CONTROLLER.replace('return "x"', 'return "changed"'));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "change");
  const head = git(repo, "rev-parse", "HEAD");
  const member = git(frontend, "rev-parse", "HEAD");
  const repos = [{ path: frontend, id: "shop-web", revision: member }];
  const gateways = [{ prefix: "shop-api", repo: "shop-service" }];
  const call = async (name: string, args: object): Promise<any> => {
    const result = (await request("tools/call", { name: `ye_ast_${name}`, arguments: { ...args, mode: "full" } })).result as any;
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return resultFields(result);
  };
  const ws = { revision: head, repos, gateways, offline: true };
  const workspace = () => call("workspace", ws);
  const decisions = () => call("decisions", ws);
  const a = await workspace();
  const b = await decisions();
  assert.deepEqual(await decisions(), b);
  assert.deepEqual(await workspace(), a);
  assert.equal(a.snapshot.sha, head);
  assert.match(JSON.stringify(a), /shop-web/);
  const entries = await call("entrypoints", { revision: head });
  const endpoint = entries.value.entrypoints.value.find((x: any) => JSON.stringify(x).includes("/orders"));
  assert.ok(endpoint, JSON.stringify(entries.value));
  const handler = endpoint.value.handler;
  assert.ok(handler?.path && handler?.symbol, JSON.stringify(endpoint));
  const callers = () => call("callers", { revision: head, targets: [{ file: handler.path, symbol: handler.symbol }], workspace: { repos, gateways }, offline: true });
  const impact = () => call("impact", { base, head, workspace: { repos, gateways }, offline: true });
  const c = await callers();
  const i = await impact();
  assert.deepEqual(await workspace(), a);
  assert.deepEqual(await impact(), i);
  assert.deepEqual(await workspace(), a);
  assert.deepEqual(await callers(), c);
  for (const result of [c, i]) {
    assert.ok(result.value.links.some((item: any) => item.link.from.repo === "shop-web" && item.link.to.repo === "shop-service" && item.link.to.name === "GET /orders/{id}"), JSON.stringify(result.value.links));
    assert.equal(result.value.sections["shop-web"].snapshot.sha, member);
    assert.ok(result.value.sections["shop-web"].value.unmatched.some((x: any) => x.line === 10));
  }
  const foreign = await call("entrypoints", { repo: "foreign", revision: member });
  const foreignHandler = foreign.value.entrypoints.value.find((x: any) => JSON.stringify(x).includes("/foreign")).value.handler;
  const outline = () => call("outline", { repo: foreign.snapshot.repo, revision: foreign.snapshot.sha, files: [foreignHandler.path] });
  const foreignCallers = () => call("callers", { repo: foreign.snapshot.repo, revision: foreign.snapshot.sha, targets: [{ file: foreignHandler.path, symbol: foreignHandler.symbol }] });
  const o = await outline(); const fc = await foreignCallers();
  assert.deepEqual(await foreignCallers(), fc); assert.deepEqual(await outline(), o);
  assert.equal(o.snapshot.sha, member);
  assert.match(JSON.stringify(o.value), /OrderController/);
  assert.deepEqual(await workspace(), a);
  assert.deepEqual(await decisions(), b);
  assert.deepEqual(await callers(), c);
  assert.deepEqual(await callers(), c);
  assert.deepEqual(await decisions(), b);
  assert.deepEqual(await workspace(), a);
  const recovery = c.recovery;
  const replay = await call("callers", recovery.query.arguments);
  assert.deepEqual(replay, c);
});
