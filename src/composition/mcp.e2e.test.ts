import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
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
    return "x";
  }
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

test("a real client over stdio lists the tools and reads the entrypoints fact the CLI prints for the same repository", async () => {
  const listed = (await request("tools/list")).result as { tools: { name: string }[] };
  assert.ok(listed.tools.some((tool) => tool.name === "ye_ast_entrypoints"));

  const called = (await request("tools/call", { name: "ye_ast_entrypoints", arguments: { mode: "full" } })).result as {
    isError?: boolean;
    structuredContent: Record<string, unknown>;
    content: { text: string }[];
  };
  assert.equal(called.isError, undefined);

  const printed: string[] = [];
  const code = await composeCli({ scratchRoot })(["map", repo], { out: (line) => printed.push(line), err: () => {} });
  assert.equal(code, 0);
  const { mode, repositoryRoots, ...fact } = called.structuredContent;
  assert.deepEqual(repositoryRoots, [{ repo: "shop-service", path: realpathSync(repo) }]);
  assert.equal(mode, "full");
  assert.deepEqual(fact, JSON.parse(printed.join("\n")));
  assert.match(called.content[0]?.text ?? "", /value\.entrypoints\.value/);
  assert.doesNotMatch(called.content[0]?.text ?? "", /GET \/orders\/\{id\}/);
  const summary = (await request("tools/call", { name: "ye_ast_entrypoints", arguments: {} })).result as {
    isError?: boolean; structuredContent: Record<string, unknown>; content: { text: string }[];
  };
  assert.equal(summary.isError, undefined);
  assert.deepEqual(summary.structuredContent, { mode: "summary", status: fact["status"], snapshot: fact["snapshot"] });
  assert.match(summary.content[0]?.text ?? "", /GET \/orders\/\{id\}.*OrderController\.java:\d+/);
});

test("callers with a workspace joins the call site of another repository to the route the symbol serves, and the answer is the same twice", async () => {
  const ask = (): Promise<Reply> =>
    request("tools/call", {
      name: "ye_ast_callers",
      arguments: { targets: [{ file: "src/main/java/shop/OrderController.java", symbol: "OrderController.one" }], workspace: { repos: [{ path: frontend }] }, mode: "full" },
    });

  const first = (await ask()).result as { isError?: boolean; structuredContent: { mode: string; status: string; snapshot: unknown; value: { links: { link: { basis: string; from: { repo: string; line: number }; to: { repo: string; name: string } } }[]; sections: Record<string, { value: { impact?: { symbols: { symbol: string }[] }; unmatched: { line: number }[] } }> } }; content: { text: string }[] };
  const second = (await ask()).result as typeof first;

  assert.equal(first.isError, undefined);
  assert.deepEqual(
    first.structuredContent.value.links.map(({ link }) => `${link.from.repo}:${link.from.line} -> ${link.to.repo} ${link.to.name} (${link.basis})`),
    ["shop-web:7 -> shop-service GET /orders/{id} (route-overlap)"],
  );
  assert.deepEqual(first.structuredContent.value.sections["shop-web"]?.value.unmatched.map((site) => site.line), [10]);
  assert.ok((first.structuredContent.value.sections["shop-web"]?.value.impact?.symbols ?? []).some((symbol) => symbol.symbol.endsWith("open")));
  assert.deepEqual(first, second);
  assert.match(first.content[0]?.text ?? "", /value\.sections/);
  const args = { targets: [{ file: "src/main/java/shop/OrderController.java", symbol: "OrderController.one" }], workspace: { repos: [{ path: frontend }] } };
  for (const mode of ["summary", "details"] as const) {
    const result = (await request("tools/call", { name: "ye_ast_callers", arguments: { ...args, mode } })).result as { isError?: boolean; structuredContent: Record<string, unknown>; content: { text: string }[] };
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { mode, status: first.structuredContent.status, snapshot: first.structuredContent.snapshot });
    assert.match(result.content[0]?.text ?? "", /shop-web:src\/app\/order\.page\.ts:7/);
  }
  const localArgs = { targets: args.targets };
  const localFull = (await request("tools/call", { name: "ye_ast_callers", arguments: { ...localArgs, mode: "full" } })).result as { isError?: boolean; structuredContent: Record<string, unknown>; content: { text: string }[] };
  assert.equal(localFull.isError, undefined);
  assert.equal(localFull.structuredContent["mode"], "full");
  assert.match(localFull.content[0]?.text ?? "", /value\.seeds/);
  for (const mode of ["summary", "details"] as const) {
    const local = (await request("tools/call", { name: "ye_ast_callers", arguments: { ...localArgs, mode } })).result as { isError?: boolean; structuredContent: Record<string, unknown>; content: { text: string }[] };
    assert.equal(local.isError, undefined);
    assert.deepEqual(local.structuredContent, { mode, status: localFull.structuredContent["status"], snapshot: localFull.structuredContent["snapshot"] });
    assert.match(local.content[0]?.text ?? "", /OrderController\.one/);
  }
});


test("declared foreign repository reads its own snapshot without implicit workspace membership or live trust", async () => {
  const local = (await request("tools/call", { name: "ye_ast_entrypoints", arguments: { mode: "full" } })).result as { structuredContent: Record<string, unknown> };
  const foreign = (await request("tools/call", { name: "ye_ast_entrypoints", arguments: { repo: "foreign", mode: "full" } })).result as { isError?: boolean; structuredContent: Record<string, unknown> };
  assert.equal(foreign.isError, undefined);
  assert.deepEqual(foreign.structuredContent["repositoryRoots"], [{ repo: "foreign", path: realpathSync(frontend) }]);
  const foreignSnapshot = foreign.structuredContent["snapshot"] as { repo: string; sha: string };
  assert.equal(foreignSnapshot.repo, "foreign");
  assert.equal(foreignSnapshot.sha, execFileSync("git", ["rev-parse", "HEAD"], { cwd: frontend, env: GIT_ENV, encoding: "utf8" }).trim());
  assert.match(JSON.stringify(foreign.structuredContent["value"]), /\/foreign/);
  assert.match(JSON.stringify(local.structuredContent["value"]), /\/orders/);
  assert.doesNotMatch(JSON.stringify(local.structuredContent["value"]), /\/foreign/);
  const workspaceResult = (await request("tools/call", { name: "ye_ast_workspace", arguments: { mode: "full" } })).result as { isError?: boolean; structuredContent: { value: { workspace: { repos: string[] } } } };
  assert.equal(workspaceResult.isError, undefined);
  assert.deepEqual(workspaceResult.structuredContent.value.workspace.repos, ["shop-service"]);
  const live = (await request("tools/call", { name: "ye_ast_entrypoints", arguments: { repo: "foreign", live: true } })).result as { isError?: boolean; _meta?: Record<string, { kind: string }> };
  assert.equal(live.isError, true);
  assert.equal(live._meta?.["ye-ast/fault"]?.kind, "live-requires-trusted");
});
