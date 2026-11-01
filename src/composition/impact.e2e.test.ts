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
  fact: { status: string; value: ImpactValue; cuts?: Cut[]; reason?: string };
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

test("a changed helper reaches the route served through an interface, the same bytes on every run, and leaves no export behind", async () => {
  commit(SHOP, "base");
  commit({ "src/main/java/shop/Util.java": UTIL("s.trim()") });

  const first = await impact("--base", "HEAD~1");
  const second = await impact("--base", "HEAD~1");

  assert.equal(first.code, EXIT_CODE.ok, first.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.deepEqual(readdirSync(scratchRoot), []);
  assert.equal(first.fact.status, "complete");
  assert.deepEqual(first.fact.value.seeds, [{ file: "src/main/java/shop/Util.java", symbol: "fmt", line: 4, basis: "lines" }]);
  assert.deepEqual(first.fact.value.symbols.map((symbol) => [place(symbol), symbol.depth]), [
    ["Util.java:Util", 0],
    ["Util.java:fmt", 0],
    ["OrderServiceImpl.java:OrderServiceImpl", 1],
    ["OrderServiceImpl.java:find", 1],
    ["OrderService.java:OrderService", 2],
    ["OrderService.java:find", 2],
    ["OrderController.java:OrderController", 3],
    ["OrderController.java:OrderController", 3],
    ["OrderController.java:one", 3],
  ]);
  assert.deepEqual(first.fact.value.entrypoints.map((entry) => [entry.kind, entry.name, entry.depth, entry.seeds]), [["http-route", "GET /orders/{id}", 3, [0]]]);
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

test("a call the index could not link to the changed method's name cuts the answer there", async () => {
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
  assert.deepEqual(result.fact.cuts, [{ kind: "unresolved-link", at: ["src/main/java/shop/Util.java::fmt", "src/main/java/shop/Stray.java:5"] }]);
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

test("a change to a file no extractor reads is a cut at that file", async () => {
  commit({ ...SHOP, "scripts/tool.py": "print(1)\n" }, "base");
  commit({ "scripts/tool.py": "print(2)\n" });

  const result = await impact("--base", "HEAD~1");

  assert.deepEqual(result.fact.cuts, [{ kind: "no-extractor", at: ["scripts/tool.py"] }]);
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
  constructor(private readonly orders: OrderService) {}
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
});

test("a changed service reaches the component that injects it and the route of the component that uses that one in its template, with no Angular cut", async () => {
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
    ["list.component.ts:ListComponent", 1, 1],
    ["list.component.ts:constructor", 1, 0.9],
    ["page.component.ts:PageComponent", 2, 1],
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
  const list = files["src/app/list.component.ts"]!.replace("OrderService) {}", "OrderService, @Inject(TOKEN) other: unknown) {}").replace("import { Component }", "import { Component, Inject }");
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
