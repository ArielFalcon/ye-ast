import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { Cut } from "../core/domain/shared/fact.ts";
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

const CONTROLLER = (mappings: string, extra = ""): string => `package shop;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/orders")
class OrderController {
  private final OrderService service;

  OrderController(OrderService service) { this.service = service; }
${mappings}${extra}}
`;

const ONE = `
  @GetMapping("/{id}")
  String one() {
    return service.find();
  }
`;

const SERVICE = `package shop;

interface OrderService {
  String find();
}
`;

const IMPL = `package shop;

import org.springframework.stereotype.Service;

@Service
class OrderServiceImpl implements OrderService {
  public String find() {
    return Util.fmt("x");
  }
}
`;

const UTIL = (body: string): string => `package shop;

class Util {
  static String fmt(String s) {
    return ${body};
  }
}
`;

const SHOP: Readonly<Record<string, string>> = {
  "src/main/java/shop/OrderController.java": CONTROLLER(ONE),
  "src/main/java/shop/OrderService.java": SERVICE,
  "src/main/java/shop/OrderServiceImpl.java": IMPL,
  "src/main/java/shop/Util.java": UTIL("s"),
};

let workspace: string;
let repo: string;
let scratchRoot: string;
let cacheRoot: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-"));
  repo = join(workspace, "shop-service");
  scratchRoot = join(workspace, "scratch");
  cacheRoot = join(workspace, "cache", "ye-ast");
  mkdirSync(repo);
  mkdirSync(scratchRoot);
  git("init", "-q", "-b", "main");
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim();
}

function commit(files: Readonly<Record<string, string>>, message = "change"): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

interface Impact {
  code: number;
  stdout: string;
  stderr: string;
  fact: { status: string; value: ImpactValue; cuts?: Cut[]; reason?: string; inputs?: { content: string; config: string; declaredConfig: { changed?: readonly string[] } } };
}

async function ye(command: string, args: string[], tail: string[] = [], options: { indexCache?: string } = {}): Promise<Impact> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot, ...options })([command, ...args, repo, ...tail], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  const text = stdout.join("\n");
  return { code, stdout: text, stderr: stderr.join("\n"), fact: text === "" ? ({} as Impact["fact"]) : JSON.parse(text) };
}

const impact = (...args: string[]): Promise<Impact> => ye("impact", args);

const place = (symbol: { file: string; symbol: string }): string => `${symbol.file.split("/").pop()}:${symbol.symbol}`;

test("an export-only barrel reports alias consumers without manufacturing symbol seeds or entrypoints", async () => {
  commit({
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@public": ["src/index.ts"] } } }),
    "src/service.ts": "export function notify() { return 'ok'; }\n",
    "src/index.ts": "export { notify } from './service';\n",
    "src/bridge.ts": "export * from '@public';\n",
    "src/consumer.ts": "import { notify } from './bridge';\nexport function run() { return notify(); }\n",
  }, "base");
  commit({ "src/index.ts": "export { notify as send } from './service';\n" });

  const answer = await impact("--base", "HEAD~1", "--changed", "src/index.ts");
  assert.notEqual(answer.fact.status, "unknown", answer.stdout);
  const value = answer.fact.value;
  assert.deepEqual(value.seeds, []);
  assert.deepEqual(value.symbols, []);
  assert.deepEqual(value.entrypoints, []);
  assert.deepEqual(value.modules?.origins, [{ file: "src/index.ts", change: "modified" }]);
  assert.deepEqual(value.modules?.modules.map((module) => [module.snapshot, module.file, module.depth]), [
    ["base", "src/index.ts", 0], ["base", "src/bridge.ts", 1], ["base", "src/consumer.ts", 2],
    ["head", "src/index.ts", 0], ["head", "src/bridge.ts", 1], ["head", "src/consumer.ts", 2],
  ]);
  assert.equal(answer.fact.cuts?.some((cut) => cut.kind === "no-extractor" && cut.at.includes("src/index.ts")) ?? false, false);
});

test("importers includes alias imports and distinguishes reexporters when the graph omits file edges", async () => {
  commit({
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@public": ["src/index.ts"] } } }),
    "src/service.ts": "export class Service {}\n",
    "src/index.ts": "export { Service } from './service';\n",
    "src/consumer.ts": "import { Service } from '@public';\nexport const instance = new Service();\n",
    "src/bridge.ts": "export * from '@public';\n",
    "src/consumer.spec.ts": "import { Service } from '@public';\nexport const testService = new Service();\n",
  });
  const answer = await ye("importers", [], ["src/index.ts"]);
  const value = answer.fact.value as unknown as { files: { file: string; importers: string[]; reexporters?: string[]; users: string[] }[] };
  const file = value.files.find((item) => item.file === "src/index.ts");
  assert.ok(file);
  assert.deepEqual(file.importers, ["src/consumer.spec.ts", "src/consumer.ts"]);
  assert.deepEqual(file.reexporters, ["src/bridge.ts"]);
  assert.ok(file.users.includes("src/bridge.ts"));
  commit({ "src/consumer.spec.ts": "export const unrelated = 1;\n" });
  const changed = await ye("importers", [], ["src/index.ts"], { indexCache: cacheRoot });
  const changedValue = changed.fact.value as unknown as typeof value;
  assert.deepEqual(changedValue.files.find((item) => item.file === "src/index.ts")?.importers, ["src/consumer.ts"]);
  assert.notEqual(answer.fact.inputs?.content, changed.fact.inputs?.content);
});

test("a deleted barrel keeps base consumers and reports unresolved current imports", async () => {
  commit({
    "src/service.ts": "export class Service {}\n",
    "src/index.ts": "export { Service } from './service';\n",
    "src/consumer.ts": "import { Service } from './index';\nexport const instance = new Service();\n",
  }, "base");
  rmSync(join(repo, "src/index.ts"));
  commit({});
  const answer = await impact("--base", "HEAD~1", "--changed", "src/index.ts");
  assert.equal(answer.fact.status, "partial", answer.stdout);
  assert.deepEqual(answer.fact.value.modules?.origins, [{ file: "src/index.ts", change: "deleted" }]);
  assert.ok(answer.fact.value.modules?.modules.some((module) => module.snapshot === "base" && module.file === "src/consumer.ts"));
  assert.equal(answer.fact.value.modules?.modules.some((module) => module.snapshot === "head" && module.file === "src/index.ts"), false);
  assert.ok(answer.fact.cuts?.some((cut) => cut.kind === "unresolved-link" && cut.at.some((place) => place.includes("src/consumer.ts:1"))));
});

test("a renamed barrel does not conflate dependencies from the two snapshots", async () => {
  commit({
    "src/service.ts": "export class Service {}\n",
    "src/index.ts": "export { Service } from './service';\n",
    "src/consumer.ts": "import { Service } from './index';\nexport const instance = new Service();\n",
  }, "base");
  rmSync(join(repo, "src/index.ts"));
  commit({ "src/public.ts": "export { Service } from './service';\n", "src/consumer.ts": "import { Service } from './public';\nexport const instance = new Service();\n" });
  const answer = await impact("--base", "HEAD~1", "--changed", "src/index.ts", "--changed", "src/public.ts");
  const modules = answer.fact.value.modules;
  assert.deepEqual(modules?.origins, [{ file: "src/index.ts", change: "deleted" }, { file: "src/public.ts", change: "added" }]);
  assert.deepEqual(modules?.modules.filter((module) => module.file === "src/consumer.ts").map((module) => [module.snapshot, module.via?.file, module.origins]), [
    ["base", "src/index.ts", [0]], ["head", "src/public.ts", [1]],
  ]);
  assert.deepEqual(answer.fact.value.seeds, []);
  assert.deepEqual(answer.fact.value.entrypoints, []);
});

test("a literal dynamic module consumer is reached conditionally without declaration seeds", async () => {
  commit({
    "src/service.ts": "export class Service {}\n",
    "src/index.ts": "export { Service } from './service';\n",
    "src/consumer.ts": "export const load = () => import('./index');\n",
  }, "base");
  commit({ "src/index.ts": "export { Service as PublicService } from './service';\n" });
  const answer = await impact("--base", "HEAD~1", "--changed", "src/index.ts");
  assert.equal(answer.fact.status, "complete", answer.stdout);
  assert.deepEqual(answer.fact.value.seeds, []);
  assert.deepEqual(answer.fact.value.entrypoints, []);
  assert.deepEqual(answer.fact.value.modules?.modules.filter((module) => module.file === "src/consumer.ts").map((module) => [module.snapshot, module.via?.form]), [["base", "dynamic-import"], ["head", "dynamic-import"]]);
});

test("module coverage keeps computed same-line references and reports unresolved literals once per snapshot", async () => {
  commit({
    "src/service.ts": "export class Service {}\n",
    "src/index.ts": "export { Service } from './service';\n",
    "src/consumer.ts": "import('./index'); import(name); import('./missing');\n",
  }, "base");
  commit({ "src/index.ts": "export { Service as PublicService } from './service';\n" });
  const answer = await impact("--base", "HEAD~1", "--changed", "src/index.ts");
  assert.equal(answer.fact.status, "partial", answer.stdout);
  const moduleCuts = answer.fact.cuts?.filter((cut) => cut.at[0]?.startsWith("module:")) ?? [];
  assert.equal(moduleCuts.filter((cut) => cut.at.some((place) => place.includes("./missing"))).length, 2);
  assert.equal(moduleCuts.filter((cut) => cut.at.some((place) => place.includes("outside module traversal"))).length, 2);
});

test("JSON changes reach resource consumers, builtin Node imports stay external and resource bytes invalidate facts", async () => {
  commit({
    "src/data.json": '{"value":1}\n',
    "src/consumer.ts": "import data from './data.json'; import 'node:crypto'; export const value = data.value;\n",
  }, "base");
  commit({ "src/data.json": '{"value":2}\n' });
  const answer = await impact("--base", "HEAD~1", "--changed", "src/data.json");
  assert.equal(answer.fact.status, "complete", answer.stdout);
  assert.deepEqual(answer.fact.value.seeds, []);
  assert.deepEqual(answer.fact.value.symbols, []);
  assert.deepEqual(answer.fact.value.modules?.origins, [{ file: "src/data.json", change: "modified" }]);
  assert.deepEqual(answer.fact.value.modules?.modules.filter((module) => module.file === "src/consumer.ts").map((module) => module.snapshot), ["base", "head"]);
  const imported = await ye("importers", [], ["src/data.json"]);
  assert.equal(imported.fact.status, "complete", imported.stdout);
  assert.ok(JSON.stringify(imported.fact.value).includes("src/consumer.ts"));
  commit({ "src/data.json": '{"value":3}\n' });
  const changed = await ye("importers", [], ["src/data.json"], { indexCache: cacheRoot });
  assert.notEqual(imported.fact.inputs?.content, changed.fact.inputs?.content);
});

test("resource modifications keep both snapshots when their first import is added or last import removed", async () => {
  commit({ "src/data.json": '{"value":1}\n', "src/use.ts": "export const value = 1;\n" }, "base");
  commit({ "src/data.json": '{"value":2}\n', "src/use.ts": "import data from './data.json'; export const value = data.value;\n" });
  const added = await impact("--base", "HEAD~1", "--changed", "src/data.json");
  assert.equal(added.fact.status, "complete", added.stdout);
  assert.deepEqual(added.fact.value.modules?.origins, [{ file: "src/data.json", change: "modified" }]);
  assert.deepEqual(added.fact.value.modules?.modules.filter((module) => module.file === "src/use.ts").map((module) => module.snapshot), ["head"]);
  commit({ "src/data.json": '{"value":3}\n', "src/use.ts": "export const value = 3;\n" });
  const removed = await impact("--base", "HEAD~1", "--changed", "src/data.json");
  assert.equal(removed.fact.status, "complete", removed.stdout);
  assert.deepEqual(removed.fact.value.modules?.origins, [{ file: "src/data.json", change: "modified" }]);
  assert.deepEqual(removed.fact.value.modules?.modules.filter((module) => module.file === "src/use.ts").map((module) => module.snapshot), ["base"]);
});

test("a changed helper reaches the route served through an interface, the same bytes on every run, and leaves no export behind", async () => {
  commit(SHOP, "base");
  commit({ "src/main/java/shop/Util.java": UTIL("s.trim()") });

  const first = await impact("--base", "HEAD~1");
  const second = await impact("--base", "HEAD~1");

  assert.equal(first.code, EXIT_CODE.ok, first.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.deepEqual(readdirSync(scratchRoot), []);
  assert.equal(first.fact.status, "complete");
  assert.deepEqual(first.fact.value.seeds, [{ file: "src/main/java/shop/Util.java", symbol: "fmt", line: 4, endLine: 6, basis: "lines" }]);
  assert.deepEqual(first.fact.value.symbols.map((symbol) => [place(symbol), symbol.depth]), [
    ["Util.java:Util", 0],
    ["Util.java:fmt", 0],
    ["OrderService.java:OrderService", 1],
    ["OrderService.java:find", 1],
    ["OrderServiceImpl.java:OrderServiceImpl", 1],
    ["OrderServiceImpl.java:find", 1],
    ["OrderController.java:OrderController", 2],
    ["OrderController.java:one", 2],
  ]);
  assert.deepEqual(first.fact.value.entrypoints.map((entry) => [entry.kind, entry.name, entry.depth, entry.seeds]), [["http-route", "GET /orders/{id}", 2, [0]]]);
});

test("an impacted symbol carries no seed indexes, while the entrypoint it serves carries them", async () => {
  commit(SHOP, "base");
  commit({ "src/main/java/shop/Util.java": UTIL("s.trim()") });

  const result = await impact("--base", "HEAD~1");

  assert.equal(result.code, EXIT_CODE.ok, result.stderr);
  assert.deepEqual(result.fact.value.entrypoints.map((entry) => [entry.kind, entry.name, entry.seeds]), [["http-route", "GET /orders/{id}", [0]]]);
  assert.deepEqual(result.fact.value.symbols.filter((symbol) => "seeds" in symbol), []);
});

test("the change is read from the merge base: what the base branch did after the fork is not in it", async () => {
  const fork = commit(SHOP, "base");
  git("checkout", "-q", "-b", "feature");
  commit({ "src/main/java/shop/Util.java": UTIL("s.trim()") }, "feature work");
  git("checkout", "-q", "main");
  commit(
    {
      "src/main/java/shop/OrderService.java": SERVICE.replace("find();", "find();\n  String other();"),
      "src/main/java/shop/OrderController.java": CONTROLLER(ONE, '\n  @GetMapping("/later")\n  String later() { return ""; }\n'),
    },
    "base moved on",
  );

  const result = await impact("--base", "main", "--head", "feature");

  assert.equal(result.code, EXIT_CODE.ok, result.stderr);
  assert.equal(result.fact.value.mergeBase, fork);
  assert.deepEqual(result.fact.value.seeds.map(place), ["Util.java:fmt"]);
  assert.deepEqual(result.fact.value.changedEntrypoints, []);
});

test("routes the change adds, removes and alters are reported at depth 0 by the head's name", async () => {
  const mappings = `${ONE}
  @GetMapping("/old")
  String old() { return ""; }
`;
  commit({ ...SHOP, "src/main/java/shop/OrderController.java": CONTROLLER(mappings) }, "base");
  const renamed = ONE.replace("/{id}", "/{orderId}");
  const created = `
  @PostMapping
  String create() { return ""; }
`;
  commit({ "src/main/java/shop/OrderController.java": CONTROLLER(renamed, created) });

  const result = await impact("--base", "HEAD~1");

  assert.equal(result.code, EXIT_CODE.ok, result.stderr);
  assert.deepEqual((result.fact.value.changedEntrypoints ?? []).map((entry) => [entry.change, entry.name, entry.handler.symbol]), [
    ["removed", "GET /orders/old", "OrderController.old"],
    ["altered", "GET /orders/{orderId}", "OrderController.one"],
    ["added", "POST /orders", "OrderController.create"],
  ]);
});

test("changed seeds only the selected changed paths, while a caller in an unselected changed file is still reached", async () => {
  commit(SHOP, "base");
  commit({
    "src/main/java/shop/Util.java": UTIL("s.trim()"),
    "src/main/java/shop/OrderServiceImpl.java": IMPL.replace('return Util.fmt("x");', 'return Util.fmt("x") + Util.fmt("y");'),
  });

  const result = await impact("--base", "HEAD~1", "--changed", "src/main/java/shop/Util.java");

  assert.equal(result.code, EXIT_CODE.ok, result.stderr);
  assert.deepEqual(result.fact.value.seeds.map(place), ["Util.java:fmt"]);
  assert.equal(result.fact.value.symbols.some((symbol) => symbol.file === "src/main/java/shop/OrderServiceImpl.java" && symbol.symbol === "find"), true);
  assert.deepEqual(result.fact.inputs?.declaredConfig.changed, ["src/main/java/shop/Util.java"]);
});

test("a changed glob that selects none of the change's paths fails with the glob named", async () => {
  commit(SHOP, "base");
  commit({ "src/main/java/shop/Util.java": UTIL("s.trim()") });

  const result = await impact("--base", "HEAD~1", "--changed", "src/z/**");

  assert.equal(result.code, EXIT_CODE.queryFailed);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unknown-change-path/);
  assert.match(result.stderr, /src\/z\/\*\*/);
});

test("changed leaves out an entrypoint the change alters in an unselected file", async () => {
  commit(SHOP, "base");
  commit({
    "src/main/java/shop/Util.java": UTIL("s.trim()"),
    "src/main/java/shop/OrderController.java": CONTROLLER(ONE.replace("/{id}", "/{orderId}")),
  });

  const all = await impact("--base", "HEAD~1");
  const selected = await impact("--base", "HEAD~1", "--changed", "src/main/java/shop/Util.java");

  assert.deepEqual((all.fact.value.changedEntrypoints ?? []).map((entry) => entry.change), ["altered"]);
  assert.deepEqual(selected.fact.value.changedEntrypoints, []);
});

test("a changed selection covering the whole change answers the same value and records the selection", async () => {
  commit(SHOP, "base");
  commit({ "src/main/java/shop/Util.java": UTIL("s.trim()") });

  const all = await impact("--base", "HEAD~1");
  const selected = await impact("--base", "HEAD~1", "--changed", "src/**");

  assert.deepEqual(selected.fact.value, all.fact.value);
  assert.equal(all.fact.inputs?.declaredConfig.changed, undefined);
  assert.deepEqual(selected.fact.inputs?.declaredConfig.changed, ["src/**"]);
  assert.notEqual(selected.fact.inputs?.config, all.fact.inputs?.config);
});

test("the changed globs are deduplicated and sorted, so the same selection in another order is the same answer", async () => {
  commit(SHOP, "base");
  commit({ "src/main/java/shop/Util.java": UTIL("s.trim()"), "src/main/java/shop/OrderServiceImpl.java": IMPL.replace('Util.fmt("x")', 'Util.fmt("y")') });

  const first = await impact("--base", "HEAD~1", "--changed", "src/main/java/shop/OrderServiceImpl.java", "--changed", "src/main/java/shop/Util.java");
  const second = await impact("--base", "HEAD~1", "--changed", "src/main/java/shop/Util.java", "--changed", "src/main/java/shop/OrderServiceImpl.java", "--changed", "src/main/java/shop/Util.java");

  assert.equal(first.stdout, second.stdout);
  assert.deepEqual(first.fact.inputs?.declaredConfig.changed, ["src/main/java/shop/OrderServiceImpl.java", "src/main/java/shop/Util.java"]);
});

test("a declaration removed in an unselected file raises no cut for the selection", async () => {
  const util = (methods: string): string => `package shop;\n\npublic class Util {\n${methods}}\n`;
  const caller = (extra: string): string => `package shop;\n\npublic class Caller {\n  public String run() { return Util.helper(); }\n${extra}}\n`;
  commit({ "src/main/java/shop/Util.java": util('  public static String helper() { return "x"; }\n'), "src/main/java/shop/Caller.java": caller("") }, "base");
  commit({ "src/main/java/shop/Util.java": util(""), "src/main/java/shop/Caller.java": caller('  public String other() { return ""; }\n') });

  const result = await impact("--base", "HEAD~1", "--changed", "src/main/java/shop/Caller.java");

  assert.equal(result.code, EXIT_CODE.ok, result.stderr);
  assert.deepEqual(result.fact.value.seeds.map((seed) => seed.symbol), ["other"]);
  assert.equal((result.fact.cuts ?? []).some((cut) => cut.kind === "unresolved-link" && cut.at[0]?.includes("Util.java::helper")), false);
});

test("a changed file no extractor reads is a cut only when the selection names it", async () => {
  commit({ ...SHOP, "web/stray.html": "<p>one</p>\n" }, "base");
  commit({ "web/stray.html": "<p>two</p>\n", "src/main/java/shop/Util.java": UTIL("s.trim()") });

  const all = await impact("--base", "HEAD~1");
  const selected = await impact("--base", "HEAD~1", "--changed", "src/main/java/shop/Util.java");

  assert.deepEqual(all.fact.cuts, [{ kind: "no-extractor", at: ["web/stray.html"] }]);
  assert.equal(selected.fact.cuts, undefined);
});

test("a changed file the index could not read stays a cut even when the selection leaves it out", async () => {
  commit({ ...SHOP, "scripts/tool.kt": "fun main() {}\n" }, "base");
  commit({ "scripts/tool.kt": "fun main() { println(2) }\n", "src/main/java/shop/Util.java": UTIL("s.trim()") });

  const selected = await impact("--base", "HEAD~1", "--changed", "src/main/java/shop/Util.java");

  assert.deepEqual(selected.fact.cuts, [{ kind: "no-extractor", at: ["scripts/tool.kt"] }]);
});

test("a test that calls a changed helper is not a caller", async () => {
  const test = `package shop;

class UtilTest {
  void checks() {
    Util.fmt("a");
  }
}
`;
  commit({ ...SHOP, "src/test/java/shop/UtilTest.java": test }, "base");
  commit({ "src/main/java/shop/Util.java": UTIL("s.trim()") });

  const result = await impact("--base", "HEAD~1");

  assert.equal(result.fact.value.symbols.some((symbol) => symbol.file.includes("UtilTest")), false);
  assert.equal(result.fact.value.symbols.some((symbol) => symbol.symbol === "one"), true);
});

test("a call the index could not link cuts the caller's file, never a homonym of the changed method's name", async () => {
  const stray = `package shop;

class Stray {
  void go() {
    Missing.fmt("a");
  }
}
`;
  commit({ ...SHOP, "src/main/java/shop/Stray.java": stray }, "base");
  commit({ "src/main/java/shop/Util.java": UTIL("s.trim()") });

  const result = await impact("--base", "HEAD~1");

  assert.equal(result.fact.status, "partial");
  assert.deepEqual(result.fact.cuts, [{ kind: "unresolved-link", at: ["src/main/java/shop/Stray.java", "src/main/java/shop/Stray.java:5 Missing.fmt"] }]);
});

test("a source file deleted whole leaves no seed, and the caller that still names its method is a cut", async () => {
  commit(SHOP, "base");
  git("rm", "-q", "src/main/java/shop/Util.java");
  git("commit", "-q", "-m", "drop Util");

  const result = await impact("--base", "HEAD~1");

  assert.equal(result.fact.status, "partial");
  assert.deepEqual(result.fact.value.seeds, []);
  assert.deepEqual(result.fact.cuts, [{ kind: "unresolved-link", at: ["src/main/java/shop/Util.java::fmt", "src/main/java/shop/OrderServiceImpl.java:8"] }]);
});

test("a changed Java record, which the index gives no symbol, seeds nothing and cuts the answer at its file", async () => {
  commit({ ...SHOP, "src/main/java/shop/Money.java": "package shop;\n\npublic record Money(int cents) {}\n" }, "base");
  commit({ "src/main/java/shop/Money.java": "package shop;\n\npublic record Money(int cents, String currency) {}\n" });

  const result = await impact("--base", "HEAD~1");

  assert.equal(result.code, EXIT_CODE.ok, result.stderr);
  assert.deepEqual(result.fact.value.seeds, []);
  assert.deepEqual(result.fact.cuts, [{ kind: "no-extractor", at: ["src/main/java/shop/Money.java"] }]);
});

test("a change to a JVM source no extractor reads is a cut at that file, and one in a language no framework reads is not", async () => {
  commit({ ...SHOP, "scripts/tool.kt": "fun main() {}\n", "scripts/tool.py": "print(1)\n" }, "base");
  commit({ "scripts/tool.kt": "fun main() { println(2) }\n", "scripts/tool.py": "print(2)\n" });

  const result = await impact("--base", "HEAD~1");

  assert.deepEqual(result.fact.cuts, [{ kind: "no-extractor", at: ["scripts/tool.kt"] }]);
  assert.deepEqual(result.fact.value.seeds, []);
});

test("a revision the repository lacks fails the query and prints no fact", async () => {
  commit(SHOP, "base");

  const result = await impact("--base", "nope");

  assert.equal(result.code, EXIT_CODE.queryFailed);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unknown-revision/);
});

const ANGULAR_APP = (find: string): Readonly<Record<string, string>> => ({
  "package.json": '{"dependencies":{"@angular/core":"21.0.0","@angular/router":"21.0.0"}}',
  "src/app/order.service.ts": `import { Injectable } from "@angular/core";

@Injectable({ providedIn: "root" })
export class OrderService {
  find(): string {
    return ${find};
  }
}
`,
  "src/app/list.component.ts": `import { Component } from "@angular/core";
import { OrderService } from "./order.service";

@Component({ selector: "app-list", template: "<p>list</p>" })
export class ListComponent {
  protected readonly label: string;

  constructor(private readonly orders: OrderService) {
    this.label = orders.find();
  }
}
`,
  "src/app/page.component.ts": `import { Component } from "@angular/core";
import { ListComponent } from "./list.component";

@Component({ selector: "app-page", standalone: true, imports: [ListComponent], templateUrl: "./page.component.html" })
export class PageComponent {}
`,
  "src/app/page.component.html": "<app-list></app-list>\n",
  "src/app/app.routes.ts": `import { Routes } from "@angular/router";
import { PageComponent } from "./page.component";

export const routes: Routes = [{ path: "page", component: PageComponent }];
`,
  "src/main.ts": `import { provideRouter } from "@angular/router";
import { routes } from "./app/app.routes";

provideRouter(routes);
`,
});

test("a changed service method reaches the component that calls it, the route of the component that renders that one, and no class that only injects the service", async () => {
  commit(ANGULAR_APP('"x"'), "base");
  commit({ "src/app/order.service.ts": ANGULAR_APP('"y"')["src/app/order.service.ts"]! });

  const first = await impact("--base", "HEAD~1");
  const second = await impact("--base", "HEAD~1");

  assert.equal(first.code, EXIT_CODE.ok, first.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.fact.status, "complete", JSON.stringify(first.fact.cuts));
  assert.deepEqual(first.fact.value.symbols.map((symbol) => [place(symbol), symbol.depth, symbol.confidence]), [
    ["order.service.ts:OrderService", 0, 1],
    ["order.service.ts:find", 0, 1],
    ["list.component.ts:ListComponent", 1, 0.9],
    ["list.component.ts:constructor", 1, 0.9],
    ["page.component.ts:PageComponent", 2, 0.9],
    ["app.routes.ts:/page", 3, 0.9],
  ]);
  assert.deepEqual(first.fact.value.entrypoints.map((entry) => [entry.kind, entry.name, entry.depth]), [["ui-route", "/page", 2]]);
});

test("a changed template reaches the components that use its component, and the route past them", async () => {
  commit(ANGULAR_APP('"x"'), "base");
  commit({ "src/app/page.component.html": "<app-list></app-list><span></span>\n" });

  const result = await impact("--base", "HEAD~1");

  assert.equal(result.fact.status, "complete", JSON.stringify(result.fact.cuts));
  assert.deepEqual(result.fact.value.seeds.map((seed) => [seed.symbol, seed.basis]), [["PageComponent", "resource"]]);
  assert.deepEqual(result.fact.value.entrypoints.map((entry) => [entry.kind, entry.name, entry.depth]), [["ui-route", "/page", 0]]);
});

test("a deleted template selected alone seeds its surviving owner from the base snapshot at its head location", async () => {
  const files = ANGULAR_APP('"x"');
  commit(files, "base");
  rmSync(join(repo, "src/app/page.component.html"));
  commit({
    "src/app/page.component.ts": `\n\n${files["src/app/page.component.ts"]!.replace("./page.component.html", "./new.component.html")}`,
    "src/app/new.component.html": "<app-list></app-list>\n",
  });
  const result = await impact("--base", "HEAD~1", "--changed", "src/app/page.component.html");
  assert.equal(result.fact.status, "complete", JSON.stringify(result.fact.cuts));
  assert.deepEqual(result.fact.value.seeds.map((seed) => [seed.file, seed.symbol, seed.basis]), [["src/app/page.component.ts", "PageComponent", "resource"]]);
  assert.deepEqual(result.fact.value.entrypoints.map((entry) => entry.name), ["/page"]);
});

test("a moved component's old template is covered by its selected removal, never by a same-name guess", async () => {
  const component = (resource: string): string => `import { Component } from '@angular/core';\n@Component({ selector: 'app-page', templateUrl: './${resource}' })\nexport class Page {}\n`;
  commit({ "package.json": '{"dependencies":{"@angular/core":"21"}}', "src/page.ts": component("old.html"), "src/old.html": "<p>old</p>" }, "base");
  rmSync(join(repo, "src/page.ts"));
  rmSync(join(repo, "src/old.html"));
  commit({ "src/new/page.ts": component("page.html"), "src/new/page.html": "<p>new</p>" });
  const all = await impact("--base", "HEAD~1");
  assert.equal(all.fact.status, "complete", JSON.stringify(all.fact.cuts));
  assert.deepEqual(all.fact.value.seeds.map((seed) => [seed.file, seed.symbol]), [["src/new/page.ts", "Page"]]);
  const selected = await impact("--base", "HEAD~1", "--changed", "src/old.html");
  assert.equal(selected.fact.status, "partial");
  assert.deepEqual(selected.fact.cuts, [{ kind: "no-extractor", at: ["src/old.html"] }]);
  assert.deepEqual(selected.fact.value.seeds, []);
});

test("an injection the reader cannot resolve cuts the answer at the file the walk reached", async () => {
  const files = ANGULAR_APP('"x"');
  const list = files["src/app/list.component.ts"]!.replace("OrderService) {", "OrderService, @Inject(TOKEN) other: unknown) {").replace("import { Component }", "import { Component, Inject }");
  commit({ ...files, "src/app/list.component.ts": list }, "base");
  commit({ "src/app/order.service.ts": ANGULAR_APP('"y"')["src/app/order.service.ts"]! });

  const result = await impact("--base", "HEAD~1");

  assert.equal(result.fact.status, "partial");
  assert.deepEqual(result.fact.cuts?.map((cut) => [cut.kind, cut.at[0]]), [["unresolved-link", "src/app/list.component.ts"]]);
});

test("a method deleted from a class that survives, with a caller left behind, cuts the answer at the caller", async () => {
  const util = (methods: string): string => `package shop;\n\npublic class Util {\n${methods}}\n`;
  const caller = "package shop;\n\npublic class Caller {\n  public String run() { return Util.helper(); }\n}\n";
  const helper = '  public static String helper() { return "x"; }\n';
  commit({ "src/main/java/shop/Util.java": util(helper), "src/main/java/shop/Caller.java": caller }, "base");
  commit({ "src/main/java/shop/Util.java": util("") });

  const result = await impact("--base", "HEAD~1");

  assert.equal(result.fact.status, "partial");
  assert.deepEqual(result.fact.cuts, [{ kind: "unresolved-link", at: ["src/main/java/shop/Util.java::helper", "src/main/java/shop/Caller.java:4"] }]);
});

test("a method renamed in place, with a caller left behind, cuts the answer at the caller", async () => {
  const util = (name: string): string => `package shop;\n\npublic class Util {\n  public static String ${name}() { return "x"; }\n}\n`;
  const caller = "package shop;\n\npublic class Caller {\n  public String run() { return Util.helper(); }\n}\n";
  commit({ "src/main/java/shop/Util.java": util("helper"), "src/main/java/shop/Caller.java": caller }, "base");
  commit({ "src/main/java/shop/Util.java": util("other") });

  const result = await impact("--base", "HEAD~1");

  assert.equal(result.fact.status, "partial");
  assert.deepEqual(result.fact.cuts, [{ kind: "unresolved-link", at: ["src/main/java/shop/Util.java::helper", "src/main/java/shop/Caller.java:4"] }]);
});

test("an Angular app under a subfolder seeds its component from a changed template and reaches its route", async () => {
  const files = Object.fromEntries(Object.entries(ANGULAR_APP('"x"')).map(([path, content]) => [`frontend/${path}`, content]));
  commit(files, "base");
  commit({ "frontend/src/app/page.component.html": "<app-list></app-list><span></span>\n" });

  const result = await impact("--base", "HEAD~1");

  assert.equal(result.fact.status, "complete", JSON.stringify(result.fact.cuts));
  assert.deepEqual(result.fact.value.seeds.map((seed) => [seed.file, seed.symbol, seed.basis]), [["frontend/src/app/page.component.ts", "PageComponent", "resource"]]);
  assert.deepEqual(result.fact.value.entrypoints.map((entry) => [entry.kind, entry.name, entry.depth]), [["ui-route", "/page", 0]]);
});

test("a changed template that no component names is a cut at the file, never silence", async () => {
  commit({ ...SHOP, "web/stray.html": "<p>one</p>\n" }, "base");
  commit({ "web/stray.html": "<p>two</p>\n" });

  const result = await impact("--base", "HEAD~1");

  assert.deepEqual(result.fact.cuts, [{ kind: "no-extractor", at: ["web/stray.html"] }]);
});

test("callers walks from a symbol and from a line range alike, to the same route, and leaves no export behind", async () => {
  commit(SHOP, "base");

  const bySymbol = await ye("callers", [], ["src/main/java/shop/Util.java:fmt"]);
  const byRange = await ye("callers", [], ["src/main/java/shop/Util.java:5-5"]);

  assert.equal(bySymbol.code, EXIT_CODE.ok, bySymbol.stderr);
  assert.deepEqual(readdirSync(scratchRoot), []);
  assert.deepEqual(bySymbol.fact.value.seeds.map((seed) => [seed.symbol, seed.basis]), [["fmt", "requested"]]);
  assert.deepEqual(byRange.fact.value.seeds.map((seed) => [seed.symbol, seed.basis]), [["fmt", "lines"]]);
  assert.deepEqual(bySymbol.fact.value.entrypoints.map((entry) => entry.name), ["GET /orders/{id}"]);
  assert.deepEqual(byRange.fact.value.entrypoints.map((entry) => entry.name), ["GET /orders/{id}"]);
  assert.equal("mergeBase" in bySymbol.fact.value, false);
});

test("callers of a symbol the revision does not hold fails with the query code and prints no fact", async () => {
  commit(SHOP, "base");
  const result = await ye("callers", [], ["src/main/java/shop/Util.java:gone"]);
  assert.equal(result.code, EXIT_CODE.queryFailed);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unknown-symbol/);
});

test("importers names the files that use a file, and cuts a file no extractor covers", async () => {
  commit(SHOP, "base");
  const result = await ye("importers", [], ["src/main/java/shop/OrderService.java", "README.md"]);
  assert.equal(result.code, EXIT_CODE.ok, result.stderr);
  const value = result.fact.value as unknown as { files: { file: string; users: string[] }[] };
  assert.deepEqual(value.files.map((entry) => entry.file), ["src/main/java/shop/OrderService.java"]);
  assert.ok(value.files[0]?.users.includes("src/main/java/shop/OrderController.java"), JSON.stringify(value));
  assert.deepEqual(result.fact.cuts, [{ kind: "no-extractor", at: ["README.md"] }]);
});

const kept = (): string[] => (existsSync(join(cacheRoot, "indexes")) ? readdirSync(join(cacheRoot, "indexes")) : []);

test("a kept index gives the bytes of a fresh build, cold or warm, for impact, callers and importers, and every query of one revision shares it", async () => {
  commit(SHOP, "base");
  commit({ "src/main/java/shop/Util.java": UTIL("s.trim()") });
  const asks: [string, string[], string[]][] = [
    ["impact", ["--base", "HEAD~1"], []],
    ["callers", [], ["src/main/java/shop/Util.java:fmt"]],
    ["importers", [], ["src/main/java/shop/OrderService.java"]],
  ];
  const run = (indexCache?: string) => Promise.all(asks.map(([command, args, tail]) => ye(command, args, tail, indexCache === undefined ? {} : { indexCache })));

  const fresh = await run();
  assert.equal(kept().length, 0);
  const cold = await run(cacheRoot);
  const warm = await run(cacheRoot);

  for (const [index, answer] of fresh.entries()) {
    assert.equal(answer.code, EXIT_CODE.ok, answer.stderr);
    assert.deepEqual([cold[index]!.code, cold[index]!.stdout, cold[index]!.stderr], [answer.code, answer.stdout, answer.stderr]);
    assert.deepEqual([warm[index]!.code, warm[index]!.stdout, warm[index]!.stderr], [answer.code, answer.stdout, answer.stderr]);
  }
  assert.equal(kept().length, 1);
  assert.deepEqual(readdirSync(scratchRoot), []);
});

test("a commit that changes the staged content is indexed anew, and one that changes nothing in scope reuses the index", async () => {
  commit(SHOP, "base");
  await ye("importers", [], ["src/main/java/shop/Util.java"], { indexCache: cacheRoot });
  commit({ "README.md": "docs" });
  await ye("importers", [], ["src/main/java/shop/Util.java"], { indexCache: cacheRoot });
  assert.equal(kept().length, 1);
  commit({ "src/main/java/shop/Util.java": UTIL("s.trim()") });
  await ye("importers", [], ["src/main/java/shop/Util.java"], { indexCache: cacheRoot });
  assert.equal(kept().length, 2);
});

test("map builds no index and never touches the cache", async () => {
  commit(SHOP, "base");
  const stdout: string[] = [];
  const code = await composeCli({ scratchRoot, indexCache: cacheRoot })(["map", repo], { out: (line) => stdout.push(line), err: () => undefined });
  assert.equal(code, EXIT_CODE.ok);
  assert.equal(existsSync(cacheRoot), false);
});

test("a callback parameter and an unproved same-line call are evaluated separately", async () => {
  commit({ "src/address.ts": "export function resolve() {}\n", "src/use.ts": "export function run() { return new Promise(resolve => resolve(1)); }\n" }, "base");
  commit({ "src/address.ts": "export function other() {}\n" });
  const local = await impact("--base", "HEAD~1", "--changed", "src/address.ts");
  assert.equal((local.fact.cuts ?? []).some((cut) => cut.at[0] === "src/address.ts::resolve"), false, local.stdout);
  commit({ "src/use.ts": "export function run() { new Promise(resolve => resolve(1)); resolve(); }\n" });
  const both = await impact("--base", "HEAD~2", "--changed", "src/address.ts");
  assert.ok((both.fact.cuts ?? []).some((cut) => cut.at[0] === "src/address.ts::resolve" && cut.at.includes("src/use.ts:1")), both.stdout);
});


test("fixed own-member proofs exclude a changed free-function homonym and follow the actual method", async () => {
  commit({
    "package.json": '{"dependencies":{"@angular/core":"21"}}',
    "src/free.ts": "export function write() { return 1; }\n",
    "src/store.ts": "export class Store { write() { return 1; } }\n",
    "src/owner.ts": "import { Injectable, inject } from '@angular/core';\nimport { Store } from './store';\n@Injectable()\nexport class Owner { readonly store = inject(Store); run() { this.store.write(); } }\n",
  }, "base");
  commit({ "src/free.ts": "export function write() { return 2; }\n" });
  const unrelated = await impact("--base", "HEAD~1", "--changed", "src/free.ts");
  assert.equal(unrelated.fact.status, "complete", JSON.stringify(unrelated.fact.cuts));
  assert.deepEqual(unrelated.fact.value.symbols.map(({ file, symbol }) => [file, symbol]), [["src/free.ts", "write"]]);
  const scoped = await impact("--base", "HEAD~1", "--changed", "src/free.ts", "--include", "src/**");
  assert.equal(scoped.fact.status, "partial");
  commit({ "src/store.ts": "export class Store { write() { return 2; } }\n" });
  const actual = await impact("--base", "HEAD~1", "--changed", "src/store.ts");
  assert.ok(actual.fact.value.symbols.some(({ file, symbol }) => file === "src/owner.ts" && symbol === "run"), JSON.stringify(actual.fact));
  assert.equal(actual.fact.value.symbols.some(({ file }) => file === "src/free.ts"), false);
});


test("an inherited call keeps uncertainty when a subclass replaces the field target", async () => {
  commit({
    "package.json": '{"dependencies":{"@angular/core":"21"}}',
    "src/store.ts": "export class Store { write() { return 1; } }\n",
    "src/other.ts": "export class Other { write() { return 1; } }\n",
    "src/owner.ts": "import { inject } from '@angular/core';\nimport { Store } from './store';\nimport { Other } from './other';\nexport class Owner { store = inject(Store); run() { this.store.write(); } }\nexport class Child extends Owner { override store = inject(Other); }\n",
  }, "base");
  commit({ "src/other.ts": "export class Other { write() { return 2; } }\n" });
  const answer = await impact("--base", "HEAD~1", "--changed", "src/other.ts");
  assert.equal(answer.fact.status, "partial", JSON.stringify(answer.fact));
  assert.ok(answer.fact.cuts?.some((cut) => cut.kind === "unresolved-link" && cut.at.some((place) => place.includes("this.store.write"))));
});


test("inline class injection reaches only its actual caller and retains an unresolved neighbor", async () => {
  commit({
    "package.json": '{"dependencies":{"@angular/core":"21"}}',
    "src/svc.ts": "export class Svc { hit() { return 1; } }\n",
    "src/setup.ts": "import { inject } from '@angular/core';\nimport { Svc } from './svc';\nexport function boot() { return inject(Svc).hit(); }\nexport function peer() { return 0; }\n",
  }, "base");
  commit({ "src/svc.ts": "export class Svc { hit() { return 2; } }\n" });
  const answer = await impact("--base", "HEAD~1", "--changed", "src/svc.ts");
  assert.ok(answer.fact.value.symbols.some(({ file, symbol }) => file === "src/setup.ts" && symbol === "boot"), JSON.stringify(answer.fact));
  assert.equal(answer.fact.value.symbols.some(({ symbol }) => symbol === "peer"), false);
  assert.equal(answer.fact.status, "complete", JSON.stringify(answer.fact.cuts));
  const scoped = await impact("--base", "HEAD~1", "--changed", "src/svc.ts", "--include", "src/**");
  assert.equal(scoped.fact.status, "partial", JSON.stringify(scoped.fact));
  assert.equal(scoped.fact.value.symbols.some(({ symbol }) => symbol === "boot"), false);
  commit({ "src/svc.ts": "export class Svc { hit() { return 3; } }\n", "src/setup.ts": "import { inject } from '@angular/core';\nimport { Svc } from './svc';\nexport function boot() { inject(Svc).hit(); other().hit(); }\nexport function peer() { return 0; }\n" });
  const neighbor = await impact("--base", "HEAD~1", "--changed", "src/svc.ts");
  assert.equal(neighbor.fact.status, "partial");
  assert.ok(neighbor.fact.value.symbols.some(({ symbol }) => symbol === "boot"));
  assert.ok(neighbor.fact.cuts?.some((cut) => cut.at.some((place) => place.includes("other().hit"))));
});


test("source-visible field mutation cannot be settled by the previous field origin", async () => {
  commit({
    "package.json": '{"dependencies":{"@angular/core":"21"}}',
    "src/store.ts": "export class Store { write() { return 1; } }\n",
    "src/other.ts": "export class Other { write() { return 1; } }\n",
    "src/owner.ts": "import { inject } from '@angular/core';\nimport { Store } from './store';\nimport { Other } from './other';\nexport class Owner { store = inject(Store); run() { this.store.write(); } }\nexport function replace(owner: Owner) { owner.store = new Other(); }\n",
  }, "base");
  commit({ "src/other.ts": "export class Other { write() { return 2; } }\n" });
  const answer = await impact("--base", "HEAD~1", "--changed", "src/other.ts");
  assert.equal(answer.fact.status, "partial", JSON.stringify(answer.fact));
  assert.ok(answer.fact.cuts?.some((cut) => cut.kind === "unresolved-link" && cut.at.some((place) => place.includes("this.store.write"))));
  commit({ "src/store.ts": "export class Store { write() { return 2; } }\n" });
  const initialTarget = await impact("--base", "HEAD~1", "--changed", "src/store.ts");
  assert.ok(initialTarget.fact.value.symbols.some(({ symbol }) => symbol === "run"), JSON.stringify(initialTarget.fact));
  assert.equal(initialTarget.fact.status, "partial", JSON.stringify(initialTarget.fact));
  assert.ok(initialTarget.fact.cuts?.some((cut) => cut.kind === "unresolved-link" && cut.at.some((place) => place.includes("this.store.write"))));
});


test("a reassigned injection local retains uncertainty instead of certifying its initial method", async () => {
  commit({
    "package.json": '{"dependencies":{"@angular/core":"21"}}',
    "src/store.ts": "export class Store { hit() { return 1; } }\n",
    "src/other.ts": "export class Other { hit() { return 1; } }\n",
    "src/setup.ts": "import { inject } from '@angular/core';\nimport { Store } from './store';\nimport { Other } from './other';\nexport function boot() { let svc = inject(Store); svc = inject(Other); svc.hit(); }\n",
  }, "base");
  commit({ "src/store.ts": "export class Store { hit() { return 2; } }\n" });
  const answer = await impact("--base", "HEAD~1", "--changed", "src/store.ts");
  assert.equal(answer.fact.status, "partial", JSON.stringify(answer.fact));
  assert.equal(answer.fact.value.symbols.some(({ symbol }) => symbol === "boot"), false);
});


test("a constant injection local reaches its real method caller through exact evidence", async () => {
  commit({
    "package.json": '{"dependencies":{"@angular/core":"21"}}',
    "src/store.ts": "export class Store { hit() { return 1; } }\n",
    "src/setup.ts": "import { inject } from '@angular/core';\nimport { Store } from './store';\nexport function boot() { const svc = inject(Store); return svc.hit(); }\nexport function peer() { return 0; }\n",
  }, "base");
  commit({ "src/store.ts": "export class Store { hit() { return 2; } }\n" });
  const answer = await impact("--base", "HEAD~1", "--changed", "src/store.ts");
  assert.equal(answer.fact.status, "complete", JSON.stringify(answer.fact));
  assert.ok(answer.fact.value.symbols.some(({ symbol }) => symbol === "boot"));
  assert.equal(answer.fact.value.symbols.some(({ symbol }) => symbol === "peer"), false);
});

test("a bound constant local retains potential callers of an overloaded method despite unrelated mutation", async () => {
  const errors = (value: number): string => `export class ErrorService {\n  notify(code: string): void;\n  notify(code: number): void;\n  notify(code: string | number) { const changed = ${value}; }\n}\n`;
  commit({
    "package.json": '{"dependencies":{"@angular/core":"21"}}',
    "src/errors.ts": errors(1),
    "src/guard.ts": "import { inject } from '@angular/core';\nimport { ErrorService } from './errors';\nexport function guard() { const errors = inject(ErrorService); errors.notify('missing'); }\nexport function peer() {}\n",
    "src/cache.ts": "export function cache() { return Object.assign({}, { value: 1 }); }\n",
  }, "base");
  commit({ "src/errors.ts": errors(2) });
  const answer = await impact("--base", "HEAD~1", "--changed", "src/errors.ts");
  assert.ok(answer.fact.value.symbols.some(({ symbol }) => symbol === "guard"), JSON.stringify(answer.fact));
  assert.equal(answer.fact.value.symbols.some(({ symbol }) => symbol === "peer"), false);
  assert.equal(answer.fact.status, "partial", JSON.stringify(answer.fact));
  assert.ok(answer.fact.cuts?.some((cut) => cut.at.some((place) => place.includes("errors.notify"))), JSON.stringify(answer.fact.cuts));
});
