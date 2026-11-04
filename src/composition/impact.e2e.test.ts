import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { Cut } from "../core/domain/shared/fact.ts";
import { composeCli, composeQueries } from "./compose.ts";

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
  fact: { status: string; value: ImpactValue; cuts?: Cut[]; reason?: string; inputs?: { config: string; declaredConfig: { changed?: readonly string[] } } };
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

test("a changed method's real graph seed joins its qualified HTTP call site downstream", async () => {
  const sibling = join(workspace, "orders");
  mkdirSync(sibling);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: sibling, env: GIT_ENV });
  mkdirSync(join(sibling, "src"));
  writeFileSync(join(sibling, "src", "OrderController.java"), `import org.springframework.web.bind.annotation.*;
@RestController class OrderController {
  @GetMapping("/orders") public String get() { return "ok"; }
}`);
  execFileSync("git", ["add", "-A"], { cwd: sibling, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: sibling, env: GIT_ENV });
  const source = (extra: string) => `import { HttpClient } from "@angular/common/http";
export class OrderApi {
  constructor(private http: HttpClient) {}
  checkout() {
    ${extra}
    return this.http.get("orders-api/orders");
  }
}`;
  commit({ "src/app/order.api.ts": source("") }, "base");
  commit({ "src/app/order.api.ts": source("const marker = 1;") }, "change");
  const queries = composeQueries({ scratchRoot });
  const discovery = await queries.workspace.outwardNames({ repo: { path: repo, id: "web" }, repos: [{ path: sibling, id: "orders" }] });
  assert.ok(discovery.ok && discovery.value.fact.status !== "unknown");
  const roots = [{ repo: "orders", path: sibling }, { repo: "web", path: repo }];
  assert.deepEqual(discovery.value.repositoryRoots, roots);
  assert.equal(JSON.stringify(discovery.value.fact).includes(workspace), false);
  assert.deepEqual(discovery.value.fact.value.repositories.find(({ repo: id }) => id === "web")?.callSites.map(({ symbol }) => symbol), ["OrderApi.checkout"]);
  const result = await queries.workspaceImpact.ofChange({ repo: { path: repo, id: "web" }, repos: [{ path: sibling, id: "orders" }], base: "HEAD~1", head: "HEAD", changed: ["src/app/order.api.ts"], budget: { depth: 1 } });
  assert.ok(result.ok);
  assert.deepEqual(result.value.fact.inputs.declaredConfig, { changed: ["src/app/order.api.ts"], walk: { depth: 1 } });
  assert.deepEqual(result.value.repositoryRoots, roots);
  const decisions = await queries.decisions.decisions({ repo: { path: repo, id: "web" }, repos: [{ path: sibling, id: "orders" }] });
  assert.ok(decisions.ok);
  assert.deepEqual(decisions.value.repositoryRoots, roots);
  assert.notEqual(result.value.fact.status, "unknown");
  const value = result.value.fact.status === "unknown" ? undefined : result.value.fact.value;
  const section = value?.sections.web;
  assert.ok(section && section.status !== "unknown");
  assert.ok(section.value.impact?.seeds.some(({ symbol }) => symbol === "checkout"));
  assert.ok(value?.links.some(({ direction, link }) => direction === "downstream" && link.from.repo === "web" && link.to.repo === "orders"));
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
