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
  const { mode, repositoryRoots, recovery, ...fact } = called.structuredContent;
  assert.ok(recovery);
  assert.deepEqual(repositoryRoots, [{ repo: "shop-service", path: realpathSync(repo) }]);
  assert.equal(mode, "full");
  assert.deepEqual(fact, JSON.parse(printed.join("\n")));
  assert.match(called.content[0]?.text ?? "", /value\.entrypoints\.value/);
  assert.doesNotMatch(called.content[0]?.text ?? "", /GET \/orders\/\{id\}/);
  const summary = (await request("tools/call", { name: "ye_ast_entrypoints", arguments: {} })).result as {
    isError?: boolean; structuredContent: Record<string, unknown>; content: { text: string }[];
  };
  assert.equal(summary.isError, undefined);
  const { recovery: summaryRecovery, ...summaryReceipt } = summary.structuredContent;
  assert.deepEqual(summaryRecovery, recovery);
  assert.deepEqual(summaryReceipt, { mode: "summary", status: fact["status"], snapshot: fact["snapshot"] });
  assert.match(summary.content[0]?.text ?? "", /GET \/orders\/\{id\}.*OrderController\.java:\d+/);
});

test("callers with a workspace joins the call site of another repository to the route the symbol serves, and the answer is the same twice", async () => {
  const ask = (): Promise<Reply> =>
    request("tools/call", {
      name: "ye_ast_callers",
      arguments: { targets: [{ file: "src/main/java/shop/OrderController.java", symbol: "OrderController.one" }], workspace: { repos: [{ path: frontend }] }, mode: "full" },
    });

  const first = (await ask()).result as { isError?: boolean; structuredContent: { mode: string; status: string; snapshot: unknown; recovery: unknown; value: { links: { link: { basis: string; from: { repo: string; line: number }; to: { repo: string; name: string } } }[]; sections: Record<string, { value: { impact?: { symbols: { symbol: string }[] }; unmatched: { line: number }[] } }> } }; content: { text: string }[] };
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
    assert.deepEqual(result.structuredContent, { mode, status: first.structuredContent.status, snapshot: first.structuredContent.snapshot, recovery: first.structuredContent["recovery"] });
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
    assert.deepEqual(local.structuredContent, { mode, status: localFull.structuredContent["status"], snapshot: localFull.structuredContent["snapshot"], recovery: localFull.structuredContent["recovery"] });
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
  const listed = (await request("tools/list")).result as { tools: { name: string; outputSchema: Parameters<AjvJsonSchemaValidator["getValidator"]>[0] }[] };
  const validate = new AjvJsonSchemaValidator().getValidator(listed.tools.find((tool) => tool.name === "ye_ast_entrypoints")!.outputSchema);
  const recovery = foreign.structuredContent["recovery"] as { version: number; status: string; resultIdentity: string; query: { name: string; arguments: Record<string, unknown> } };
  assert.deepEqual(recovery.query, { name: "ye_ast_entrypoints", arguments: { repo: "foreign", revision: foreignSnapshot.sha } });
  assert.equal(recovery.version, 1);
  assert.equal(recovery.status, "available");
  assert.match(recovery.resultIdentity, /^mcp-r1:[0-9a-f]{64}$/);
  for (const mode of ["summary", "details", "full"] as const) {
    const result = (await request("tools/call", { name: "ye_ast_entrypoints", arguments: { repo: "foreign", mode } })).result as { isError?: boolean; structuredContent: Record<string, unknown>; content: { text: string }[] };
    assert.equal(result.isError, undefined);
    assert.equal(validate(result.structuredContent).valid, true);
    assert.deepEqual(result.structuredContent["recovery"], recovery);
    const textRecovery = result.content[0]!.text.split("\n").find((line) => line.startsWith("recovery: "));
    assert.equal(textRecovery, `recovery: ${JSON.stringify(recovery)}`);
    assert.deepEqual(JSON.parse(textRecovery!.slice("recovery: ".length)), recovery);
  }
  const replay = async () => (await request("tools/call", { name: recovery.query.name, arguments: { ...recovery.query.arguments, mode: "full" } })).result as { structuredContent: Record<string, unknown> };
  const sourceFact = (result: Record<string, unknown>) => {
    const { mode, repositoryRoots, recovery: metadata, ...fact } = result;
    return fact;
  };
  assert.deepEqual(sourceFact((await replay()).structuredContent), sourceFact(foreign.structuredContent));
  writeFileSync(join(frontend, "src/main/java/shop/OrderController.java"), CONTROLLER.replace("/orders", "/changed"));
  execFileSync("git", ["add", "-A"], { cwd: frontend, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "change route"], { cwd: frontend, env: GIT_ENV });
  const current = (await request("tools/call", { name: "ye_ast_entrypoints", arguments: { repo: "foreign", mode: "full" } })).result as { structuredContent: Record<string, unknown> };
  assert.match(JSON.stringify(current.structuredContent["value"]), /\/changed/);
  assert.notDeepEqual(current.structuredContent["recovery"], recovery);
  const old = (await replay()).structuredContent;
  assert.deepEqual(old["recovery"], recovery);
  assert.deepEqual(sourceFact(old), sourceFact(foreign.structuredContent));
  assert.match(JSON.stringify(old["value"]), /\/foreign/);
  const workspaceResult = (await request("tools/call", { name: "ye_ast_workspace", arguments: { mode: "full" } })).result as { isError?: boolean; structuredContent: { value: { workspace: { repos: string[] } } } };
  assert.equal(workspaceResult.isError, undefined);
  assert.deepEqual(workspaceResult.structuredContent.value.workspace.repos, ["shop-service"]);
  const live = (await request("tools/call", { name: "ye_ast_entrypoints", arguments: { repo: "foreign", live: true } })).result as { isError?: boolean; _meta?: Record<string, { kind: string }> };
  assert.equal(live.isError, true);
  assert.equal(live._meta?.["ye-ast/fault"]?.kind, "live-requires-trusted");
});

test("callers and impact replay real local and persisted workspace facts", async () => {
  const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf8" }).trim();
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "branch", "comparison", base);
  writeFileSync(join(repo, "src/main/java/shop/OrderController.java"), CONTROLLER.replace('return "x"', 'return "changed"'));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "change controller");
  const head = git(repo, "rev-parse", "HEAD");
  const member = git(frontend, "rev-parse", "HEAD");
  const manifest = join(workspace, "workspace.json");
  writeFileSync(manifest, JSON.stringify({ repos: [{ path: "../shop-web", id: "shop-web", revision: "main" }], gateways: [{ prefix: "shop-api", repo: "shop-service" }] }));
  const errors: string[] = [];
  assert.equal(await composeCli({ scratchRoot, trustDirectory: join(workspace, "trust") })(["init", "--trust", "trusted", "--workspace", manifest, repo], { out: () => {}, err: (line) => errors.push(line) }), 0, errors.join("\n"));
  type Result = { isError?: boolean; structuredContent: Record<string, any>; content: { text: string }[]; _meta?: Record<string, any> };
  const call = async (name: string, args: Record<string, unknown>): Promise<Result> => (await request("tools/call", { name, arguments: args })).result as Result;
  const listed = (await request("tools/list")).result as { tools: { name: string; outputSchema: Parameters<AjvJsonSchemaValidator["getValidator"]>[0] }[] };
  const fact = (result: Result) => { const { recovery, mode, repositoryRoots, ...source } = result.structuredContent; return source; };
  const recipes: { name: string; recovery: any; source: Result }[] = [];
  for (const workspaceArgs of [undefined, {}]) {
    for (const [name, args] of [
      ["ye_ast_callers", { targets: [{ file: "src/main/java/shop/OrderController.java", symbol: "OrderController.one" }] }],
      ["ye_ast_impact", { base: "comparison", changed: ["src/main/java/**"] }],
    ] as const) {
      const input = { ...args, scope: { include: ["src/**"] }, budget: { depth: 5, expansions: 100 }, ...(workspaceArgs && { workspace: workspaceArgs }) };
      const source = await call(name, { ...input, mode: "full" });
      assert.equal(source.isError, undefined);
      const recovery = source.structuredContent.recovery;
      assert.equal(recovery.status, "available");
      assert.equal(recovery.query.name, name);
      assert.equal(recovery.query.arguments.repo, "shop-service");
      assert.deepEqual(recovery.query.arguments.scope, input.scope);
      assert.deepEqual(recovery.query.arguments.budget, input.budget);
      if (name === "ye_ast_impact") assert.deepEqual(recovery.query.arguments.changed, ["src/main/java/**"]);
      assert.equal(recovery.query.arguments[name === "ye_ast_impact" ? "head" : "revision"], head);
      if (name === "ye_ast_impact") {
        assert.equal(recovery.query.arguments.base, base);
        assert.equal(workspaceArgs ? source.structuredContent.value.trigger.mergeBase : source.structuredContent.value.mergeBase, base);
        const impact = workspaceArgs ? source.structuredContent.value.sections["shop-service"].value.impact : source.structuredContent.value;
        assert.ok(impact.seeds.length > 0);
      }
      if (workspaceArgs) {
        assert.deepEqual(recovery.query.arguments.workspace, {});
        assert.match(recovery.query.arguments.replay.declaration, /^ws-r1:[0-9a-f]{64}$/);
        assert.deepEqual(recovery.query.arguments.replay.snapshots, [{ repo: "shop-service", kind: "sha", sha: head }, { repo: "shop-web", kind: "sha", sha: member }]);
        assert.equal(source.structuredContent.value.workspace.source, "persisted");
        const section = source.structuredContent.value.sections["shop-web"];
        assert.equal(section.snapshot.sha, member);
        assert.ok(section.value.reads.some((read: any) => read.fact.snapshot.sha === member));
        assert.ok(section.value.callSites.some((site: any) => site.file === "src/app/order.page.ts"));
        assert.ok(source.structuredContent.repositoryRoots.some((root: any) => root.repo === "shop-web" && root.path === realpathSync(frontend)));
      }
      const validate = new AjvJsonSchemaValidator().getValidator(listed.tools.find((tool) => tool.name === name)!.outputSchema);
      for (const mode of ["summary", "details", "full"]) {
        const result = await call(name, { ...input, mode });
        assert.equal(validate(result.structuredContent).valid, true);
        assert.deepEqual(result.structuredContent.recovery, recovery);
        assert.ok(result.content[0]!.text.split("\n").includes(`recovery: ${JSON.stringify(recovery)}`));
      }
      const replayed = await call(name, { ...recovery.query.arguments, mode: "full" });
      assert.deepEqual(replayed.structuredContent.recovery, recovery);
      assert.deepEqual(fact(replayed), fact(source));
      if (workspaceArgs) recipes.push({ name, recovery, source });
    }
  }
  writeFileSync(join(frontend, "src/app/order.page.ts"), COMPONENT.replace("shop-api/orders/7", "other-api/changed"));
  git(frontend, "add", "-A");
  git(frontend, "commit", "-q", "-m", "change call site");
  for (const { name, recovery, source } of recipes) {
    const currentArgs = { ...recovery.query.arguments };
    delete currentArgs.replay;
    const current = await call(name, { ...currentArgs, mode: "full" });
    assert.notDeepEqual(fact(current), fact(source));
    assert.notDeepEqual(current.structuredContent.value.sections["shop-web"].value.callSites, source.structuredContent.value.sections["shop-web"].value.callSites);
    const replayed = await call(name, { ...recovery.query.arguments, mode: "full" });
    assert.deepEqual(replayed.structuredContent.recovery, recovery);
    assert.deepEqual(fact(replayed), fact(source));
  }
  writeFileSync(join(repo, ".ye-ast/workspace.json"), JSON.stringify({ repos: [{ path: "../shop-web", id: "shop-web", revision: "main" }], gateways: [{ prefix: "changed", repo: "shop-service" }] }));
  for (const { name, recovery } of recipes) {
    const changed = await call(name, recovery.query.arguments);
    assert.equal(changed.isError, true);
    assert.equal(changed._meta?.["ye-ast/fault"]?.kind, "result-changed");
    assert.equal(changed._meta?.["ye-ast/fault"]?.stage, "workspace-replay");
    assert.equal(changed.structuredContent, undefined);
  }
});

test("stdio workspace live member replays captured mixed snapshots and rejects a changed live state", async () => {
  const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf8" }).trim();
  const errors: string[] = [];
  assert.equal(await composeCli({ scratchRoot, trustDirectory: join(workspace, "trust") })(["init", "--trust", "trusted", frontend], { out: () => {}, err: (line) => errors.push(line) }), 0, errors.join("\n"));
  writeFileSync(join(frontend, "src/app/order.page.ts"), COMPONENT);
  const member = { path: frontend, id: "shop-web", live: true };
  const repos = [member];
  type Wire = { isError?: boolean; structuredContent?: Record<string, any>; _meta?: Record<string, any> };
  const call = async (name: string, args: object): Promise<Wire> => (await request("tools/call", { name, arguments: args })).result as Wire;
  const discovery = await call("ye_ast_workspace", { repos, offline: true, mode: "full" });
  assert.notEqual(discovery.isError, true, JSON.stringify(discovery));
  assert.ok(discovery.structuredContent?.value.repositorySnapshots.some((item: any) => item.repo === "shop-web" && item.snapshot.kind === "live"));
  const recipes: { name: string; arguments: Record<string, unknown>; identity: string }[] = [];
  for (const [name, args] of [
    ["ye_ast_callers", { targets: [{ file: "src/main/java/shop/OrderController.java", symbol: "OrderController.one" }] }],
    ["ye_ast_impact", { base: "comparison" }],
  ] as const) {
    const result = await call(name, { ...args, workspace: { repos }, offline: true, mode: "full" });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const value = result.structuredContent!.value;
    assert.ok(value.links.some((item: any) => item.link.from.repo === "shop-web" && item.link.to.name === "GET /orders/{id}"));
    const recovery = result.structuredContent!.recovery;
    assert.equal(recovery.status, "available", JSON.stringify(recovery));
    const vector = recovery.query.arguments.replay.snapshots;
    assert.equal(vector[0].repo, "shop-service");
    assert.equal(vector[0].kind, "sha");
    assert.equal(vector[0].sha, git(repo, "rev-parse", "HEAD"));
    assert.equal(vector[1].repo, "shop-web");
    assert.equal(vector[1].kind, "live");
    assert.equal(vector[1].head, git(frontend, "rev-parse", "HEAD"));
    assert.ok(vector[1].stateId);
    const replayed = await call(name, { ...recovery.query.arguments, mode: "full" });
    assert.notEqual(replayed.isError, true, JSON.stringify(replayed));
    assert.equal(replayed.structuredContent!.recovery.resultIdentity, recovery.resultIdentity);
    recipes.push({ name, arguments: recovery.query.arguments, identity: recovery.resultIdentity });
  }
  writeFileSync(join(frontend, "src/app/order.page.ts"), COMPONENT.replace("shop-api/orders/7", "changed-api/orders/7"));
  for (const recipe of recipes) {
    const result = await call(recipe.name, recipe.arguments);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.equal(result._meta?.["ye-ast/fault"]?.kind, "result-changed");
    assert.equal(result._meta?.["ye-ast/fault"]?.stage, "workspace-replay");
  }
});

test("real callers expose two recorded origins for a reached handler", async () => {
  const args = { targets: ["first", "second"].map((name) => ({ file: "src/main/java/shop/OrderController.java", symbol: `OrderController.${name}` })), mode: "full" };
  const result = (await request("tools/call", { name: "ye_ast_callers", arguments: args })).result as { isError?: boolean; structuredContent: { value: { entrypoints: { handler: unknown; seeds: number[] }[] } } };
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.ok(result.structuredContent.value.entrypoints.some((item) => new Set(item.seeds).size >= 2), JSON.stringify(result.structuredContent.value.entrypoints));
});

test("selected callers pages replay real pinned origins and reject a changed live source", async () => {
  const errors: string[] = [];
  assert.equal(await composeCli({ scratchRoot, trustDirectory: join(workspace, "trust") })(["init", "--trust", "trusted", repo], { out: () => {}, err: (line) => errors.push(line) }), 0, errors.join("\n"));
  const file = join(repo, "src/main/java/shop/OrderController.java");
  const additionalRoutes = Array.from({ length: 8 }, (_, i) => `  @GetMapping("/extra-${i}")\n  String extra${i}() { return first() + second(); }\n`).join("");
  writeFileSync(file, CONTROLLER.replace('  String first() {', `${additionalRoutes}  String first() {`));
  type Wire = { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: Record<string, any>; _meta?: Record<string, any> };
  const call = async (args: object): Promise<Wire> => (await request("tools/call", { name: "ye_ast_callers", arguments: args })).result as Wire;
  const targets = ["first", "second"].map((name) => ({ file: "src/main/java/shop/OrderController.java", symbol: `OrderController.${name}` }));
  const source = await call({ targets, live: true, mode: "full" });
  assert.notEqual(source.isError, true, JSON.stringify(source));
  const { value, recovery } = source.structuredContent!;
  assert.equal(recovery.status, "available");
  const reached = value.entrypoints.find((item: any) => new Set(item.seeds).size >= 2);
  assert.ok(reached, JSON.stringify(value.entrypoints));
  const indexes = [...new Set<number>(reached.seeds)].sort((a, b) => a - b);
  const { path, symbol, line } = reached.handler;
  const details = await call({ ...recovery.query.arguments, mode: "details" });
  assert.notEqual(details.isError, true, JSON.stringify(details));
  const detailText = details.content?.find((part) => part.type === "text")?.text ?? "";
  const exampleText = detailText.match(/complete select example: (\{[^\n]+\})/)?.[1];
  assert.ok(exampleText, detailText);
  const example = JSON.parse(exampleText);
  const rowText = detailText.split("\n").find((row) => row.includes(`handler: ${JSON.stringify({ path, symbol, line })}`));
  assert.ok(rowText);
  const handler = JSON.parse(rowText.match(/handler: (\{[^\n]+\})/)![1]!) as { path: string; symbol: string; line: number };
  assert.ok(detailText.includes(`handler: ${JSON.stringify(handler)}`));
  const select = { kind: example.kind, owner: example.owner, handler };
  const args = { ...recovery.query.arguments, mode: "full", select, page: { limit: 1 }, expect: recovery.resultIdentity };
  const first = await call(args);
  assert.notEqual(first.isError, true, JSON.stringify(first));
  assert.equal(first.structuredContent!.kind, "projection");
  assert.equal(first.structuredContent!.recovery.resultIdentity, recovery.resultIdentity);
  assert.ok(first.structuredContent!.page.nextCursor);
  const selectedText = first.content?.find((part) => part.type === "text")?.text ?? "";
  assert.match(selectedText, /structuredContent\.context, items and page/);
  assert.doesNotMatch(selectedText, /Records:/);
  assert.deepEqual((await call(args)).structuredContent, first.structuredContent);
  const items = [...first.structuredContent!.items];
  let cursor = first.structuredContent!.page.nextCursor;
  const firstCursor = cursor;
  while (cursor) {
    const next = await call({ ...args, page: { limit: 1, cursor } });
    assert.notEqual(next.isError, true, JSON.stringify(next));
    assert.equal(next.structuredContent!.recovery.resultIdentity, recovery.resultIdentity);
    items.push(...next.structuredContent!.items);
    cursor = next.structuredContent!.page.nextCursor;
  }
  assert.deepEqual(items, indexes.map((seedIndex) => ({ seedIndex, seed: value.seeds[seedIndex] })));
  writeFileSync(file, CONTROLLER.replace('return "x"', 'return "changed-live"'));
  const changed = await call({ ...args, page: { limit: 1, cursor: firstCursor } });
  assert.equal(changed.isError, true);
  assert.equal(changed.structuredContent, undefined);
  assert.equal(changed._meta?.["ye-ast/fault"]?.kind, "result-changed");
});
