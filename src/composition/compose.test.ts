import { afterEach, beforeEach, test } from "node:test";
import type { TraceQueries } from "../core/ports/trace-queries.port.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { EXIT_CODE } from "../cli/main.ts";
import { REDACTED } from "../core/ports/redaction.port.ts";
import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import { createRemoteRefresh, defaultRemoteRefreshDeps } from "../core/adapters/git/remote-refresh.adapter.ts";
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import type { DecisionValue } from "../core/ports/decision-queries.port.ts";
import type { WorkspaceValue } from "../core/ports/workspace-queries.port.ts";
import { composeCli, composeQueries, mcpCommandFor } from "./compose.ts";
import { installedVersion } from "./installed-versions.ts";
import { createMcpServer, RESULT_JSON_LABEL } from "../mcp/server.ts";
import { openSession } from "../mcp/test-session.testing.ts";

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

const ORDER_PAGE = `import { HttpClient } from "@angular/common/http";
import { inject } from "@angular/core";

export class OrderPage {
  private readonly http = inject(HttpClient);
  open(): void {
    this.http.get("shop-api/orders/7");
  }
}
`;

let workspace: string;
let repo: string;
let scratchRoot: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-"));
  repo = join(workspace, "shop-service");
  scratchRoot = join(workspace, "scratch");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(scratchRoot);
  git("init", "-q");
  writeFileSync(join(repo, "src", "OrderController.java"), CONTROLLER);
  git("add", "-A");
  git("commit", "-q", "-m", "controller");
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim();
}

test("composed workspace reads a trusted live trigger alongside a committed member", async () => {
  const member = join(workspace, "member");
  mkdirSync(member);
  const memberGit = (...args: string[]): string => execFileSync("git", args, { cwd: member, env: GIT_ENV, encoding: "utf8" }).trim();
  memberGit("init", "-q");
  writeFileSync(join(member, "index.ts"), "export function member() {}\n");
  memberGit("add", "-A");
  memberGit("commit", "-q", "-m", "member");
  const sha = memberGit("rev-parse", "HEAD");
  const trustDirectory = join(workspace, "trust");
  const cacheDirectory = join(workspace, "cache");
  const quiet = { out: () => undefined, err: () => undefined };
  assert.equal(await composeCli({ scratchRoot, trustDirectory, cacheDirectory })(["init", "--trust", "trusted", repo], quiet), EXIT_CODE.ok);
  writeFileSync(join(repo, "src", "OrderController.java"), CONTROLLER.replace('/{id}', '/live/{id}'));
  const liveRepo = { path: repo, id: "shop-service", live: true as const };
  const queries = composeQueries({ scratchRoot, trustDirectory, cacheDirectory });
  const request = { repo: liveRepo, repos: [{ path: member, id: "member", revision: sha }] };
  const result = await queries.workspace.outwardNames(request);
  assert.ok(result.ok);
  assert.notEqual(result.value.fact.status, "unknown");
  if (result.value.fact.status === "unknown") return;
  const vector = result.value.fact.value.repositorySnapshots;
  assert.deepEqual(vector.map(({ repo: id }) => id), ["member", "shop-service"]);
  assert.deepEqual(vector[0]?.snapshot, { repo: "member", kind: "sha", sha });
  const liveSnapshot = vector[1]?.snapshot;
  assert.equal(liveSnapshot?.kind, "live");
  assert.ok(result.value.fact.value.repositories.find((item) => item.repo === "shop-service")?.entrypoints.some((item) => item.status === "complete" && item.value.kind === "http-route" && item.value.path === "/orders/live/{id}" && item.evidence.some(({ path }) => path === "src/OrderController.java")));
  const callers = await queries.workspaceImpact.callers({ ...request, targets: [{ file: "src/OrderController.java", symbol: "OrderController.one" }] });
  const change = await queries.workspaceImpact.ofChange({ ...request, base: "HEAD" });
  const decisions = await queries.decisions.decisions(request);
  assert.ok(callers.ok && change.ok && decisions.ok);
  assert.notEqual(callers.value.fact.status, "unknown");
  assert.notEqual(change.value.fact.status, "unknown");
  assert.notEqual(decisions.value.fact.status, "unknown");
  if (callers.value.fact.status === "unknown" || change.value.fact.status === "unknown" || decisions.value.fact.status === "unknown") return;
  for (const answer of [callers.value.fact.value, change.value.fact.value]) {
    assert.deepEqual(answer.repositorySnapshots, vector);
    const section = answer.sections["shop-service"];
    assert.ok(section && section.status !== "unknown");
    assert.deepEqual(section.value.reads.map(({ kind }) => kind), ["discovery", "trigger"]);
    assert.deepEqual(section.value.reads.map(({ fact }) => fact.snapshot), [liveSnapshot, liveSnapshot]);
    assert.ok(section.value.impact?.entrypoints.some(({ name }) => name === "GET /orders/live/{id}"));
  }
  const changed = change.value.fact.value.sections["shop-service"];
  assert.ok(changed && changed.status !== "unknown" && changed.value.impact?.changedEntrypoints?.some(({ name }) => name === "GET /orders/live/{id}"));
  assert.deepEqual(decisions.value.fact.value.repositories, vector);
});

test("composed workspace rejects invalid live choices and an untrusted live repository", async () => {
  const queries = composeQueries({ scratchRoot, trustDirectory: join(workspace, "empty-trust"), cacheDirectory: join(workspace, "cache") });
  const invalid = { path: repo, live: true, revision: undefined };
  const rejected = await queries.workspace.outwardNames({ repo: invalid as unknown as Parameters<typeof queries.workspace.outwardNames>[0]["repo"] });
  assert.ok(!rejected.ok);
  assert.equal(rejected.fault.kind, "git-failed");
  const untrusted = await queries.workspace.outwardNames({ repo: { path: repo, live: true } });
  assert.ok(!untrusted.ok);
  assert.equal(untrusted.fault.kind, "live-requires-trusted");
});

test("the MCP registration names the published package when it runs from an installed one, and tsx from a source checkout", () => {
  assert.deepEqual(mcpCommandFor("/work/ye-ast/src/composition/main.ts"), ["npx", "--yes", "tsx", "/work/ye-ast/src/composition/main.ts"]);
  assert.deepEqual(mcpCommandFor("/app/node_modules/ye-ast-mcp/dist/composition/main.js"), ["npx", "--yes", "ye-ast-mcp"]);
});

test("map prints the route of a committed Spring controller and removes its temporary export", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const cli = composeCli({ scratchRoot });

  const code = await cli(["map", repo], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });

  assert.equal(code, EXIT_CODE.ok);
  assert.deepEqual(stderr, []);
  const map = JSON.parse(stdout.join("\n"));
  assert.equal(map.status, "complete");
  assert.equal(map.snapshot.repo, "shop-service");
  assert.deepEqual(map.inputs.declaredScope, { languages: ["java", "typescript"], frameworks: ["angular", "spring"], include: [], exclude: [] });
  const items = map.value.entrypoints.value;
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "complete");
  assert.equal(items[0].value.method, "GET");
  assert.equal(items[0].value.path, "/orders/{id}");
  assert.equal(items[0].value.handler.path, "src/OrderController.java");
  assert.deepEqual(readdirSync(scratchRoot), []);
});

test("map with --exclude over a real repository leaves the excluded controller out of the facts and declares the glob", async () => {
  const stdout: string[] = [];
  const cli = composeCli({ scratchRoot });

  const code = await cli(["map", "--exclude", "src/**", repo], { out: (line) => stdout.push(line), err: () => undefined });

  assert.equal(code, EXIT_CODE.ok);
  const map = JSON.parse(stdout.join("\n"));
  assert.equal(map.status, "complete");
  assert.deepEqual(map.value.entrypoints.value, []);
  assert.deepEqual(map.inputs.declaredScope.exclude, ["src/**"]);
});

test("map prints a route whose path holds a token with the token redacted", async () => {
  const token = `ghp_${"a1B2".repeat(9)}`;
  writeFileSync(join(repo, "src", "OrderController.java"), CONTROLLER.replace('"/{id}"', `"/hooks/${token}"`));
  git("commit", "-q", "-am", "token in a path");
  const stdout: string[] = [];

  const code = await composeCli({ scratchRoot })(["map", repo], { out: (line) => stdout.push(line), err: () => undefined });

  assert.equal(code, EXIT_CODE.ok);
  assert.equal(stdout.join("\n").includes(token), false);
  assert.equal(JSON.parse(stdout.join("\n")).value.entrypoints.value[0].value.path, `/orders/hooks/${REDACTED}`);
});

test("map cuts the entrypoints by a submodule and by a Kotlin source, which no extractor reads", async () => {
  git("update-index", "--add", "--cacheinfo", `160000,${git("rev-parse", "HEAD")},services/orders`);
  writeFileSync(join(repo, "src", "Billing.kt"), "class Billing");
  git("add", "src/Billing.kt");
  git("commit", "-q", "-m", "submodule and kotlin");
  const stdout: string[] = [];

  const code = await composeCli({ scratchRoot })(["map", repo], { out: (line) => stdout.push(line), err: () => undefined });

  assert.equal(code, EXIT_CODE.ok);
  const section = JSON.parse(stdout.join("\n")).value.entrypoints;
  assert.equal(section.status, "partial");
  assert.deepEqual(section.cuts, [
    { kind: "not-exported", at: ["services/orders"] },
    { kind: "no-extractor", at: ["src/Billing.kt"] },
  ]);
  assert.equal(section.value.length, 1);
});

test("map of a subdirectory fails with the query code and prints no fact", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const code = await composeCli({ scratchRoot })(["map", join(repo, "src")], {
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  });

  assert.equal(code, EXIT_CODE.queryFailed);
  assert.deepEqual(stdout, []);
  assert.equal(stderr.length, 1);
  assert.deepEqual(readdirSync(scratchRoot), []);
});

async function mapOf(options: Parameters<typeof composeCli>[0] = {}) {
  const stdout: string[] = [];
  const code = await composeCli({ scratchRoot, ...options })(["map", repo], { out: (line) => stdout.push(line), err: () => undefined });
  assert.equal(code, EXIT_CODE.ok);
  return JSON.parse(stdout.join("\n"));
}

test("map of a commit that grows a Kotlin source and then a submodule never repeats a content digest", async () => {
  const digests = [(await mapOf()).inputs.content];
  mkdirSync(join(repo, "src", "main", "kotlin"), { recursive: true });
  writeFileSync(join(repo, "src", "main", "kotlin", "Billing.kt"), "class Billing");
  git("add", "-A");
  git("commit", "-q", "-m", "kotlin");
  digests.push((await mapOf()).inputs.content);
  git("update-index", "--add", "--cacheinfo", `160000,${git("rev-parse", "HEAD")},services/orders`);
  git("commit", "-q", "-m", "submodule");
  digests.push((await mapOf()).inputs.content);

  assert.equal(new Set(digests).size, 3);
});

function pomWith(groupId: string, artifactId: string): string {
  return `<project>\n  <build>\n    <plugins>\n      <plugin>\n        <groupId>${groupId}</groupId>\n        <artifactId>${artifactId}</artifactId>\n      </plugin>\n    </plugins>\n  </build>\n</project>\n`;
}

test("map reads the build files of the commit: a declared source generator makes the delegate implementation unknown items, and changes the content digest", async () => {
  writeFileSync(
    join(repo, "src", "PetsServiceImpl.java"),
    "package shop;\n\nimport com.acme.gen.PetsApiService;\nimport org.springframework.stereotype.Service;\n\n@Service\nclass PetsServiceImpl implements PetsApiService {\n  public String list() { return \"\"; }\n}\n",
  );
  writeFileSync(join(repo, "pom.xml"), pomWith("org.springframework.boot", "spring-boot-maven-plugin"));
  git("add", "-A");
  git("commit", "-q", "-m", "service and pom");
  const without = await mapOf();
  writeFileSync(join(repo, "pom.xml"), pomWith("org.openapitools", "openapi-generator-maven-plugin"));
  git("commit", "-q", "-am", "generator");

  const withGenerator = await mapOf();

  assert.deepEqual(without.value.entrypoints.value.map((item: { status: string }) => item.status), ["complete"]);
  assert.deepEqual(
    withGenerator.value.entrypoints.value.map((item: { status: string; reason?: string }) => `${item.status}:${item.reason ?? ""}`),
    ["complete:", "unknown:no-extractor"],
  );
  assert.deepEqual(withGenerator.value.entrypoints.value[1].evidence.map((span: { path: string; line: number }) => `${span.path}:${span.line}`), [
    "src/PetsServiceImpl.java:8",
    "src/PetsServiceImpl.java:7",
    "pom.xml:6",
  ]);
  assert.notEqual(withGenerator.inputs.content, without.inputs.content);
});

test("map under a budget the commit exceeds is partial with a caller-budget cut and still removes its export", async () => {
  const map = await mapOf({ exportBudget: { maxEntries: 0, maxBytes: Number.MAX_SAFE_INTEGER } });

  assert.equal(map.status, "partial");
  assert.deepEqual(map.value.entrypoints.cuts, [{ kind: "caller-budget", at: ["src/OrderController.java"], limit: 0 }]);
  assert.deepEqual(map.value.entrypoints.value, []);
  assert.deepEqual(readdirSync(scratchRoot), []);
});

test("map without a budget option takes the whole commit: only a host sets a budget", async () => {
  const unbudgeted = await mapOf();

  assert.deepEqual(unbudgeted.inputs.declaredConfig, {});
  assert.equal(unbudgeted.inputs.config, createSha256Digest().of(canonicalJson({})));
});

const APP_ROUTES = `import { Routes } from '@angular/router';
import { Home } from './home';

export const routes: Routes = [
  { path: 'home', component: Home },
  { path: 'orders', loadChildren: () => import('./orders/orders.routes') },
  { path: 'by-hand', matcher: urlMatcher, component: Home },
];
`;

function addAngularApp(): void {
  mkdirSync(join(repo, "web", "src", "app", "orders"), { recursive: true });
  writeFileSync(join(repo, "web", "package.json"), JSON.stringify({ dependencies: { "@angular/router": "21.0.0" } }));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { "@angular/router": "21.0.0" } }));
  writeFileSync(join(repo, "web", "src", "app", "app.routes.ts"), APP_ROUTES);
  writeFileSync(join(repo, "web", "src", "main.ts"), `import { provideRouter } from '@angular/router';\nimport { routes } from './app/app.routes';\nprovideRouter(routes);\n`);
  writeFileSync(join(repo, "web", "src", "app", "home.ts"), "@Component({})\nexport class Home {}\n");
  writeFileSync(join(repo, "web", "src", "app", "orders", "orders.routes.ts"), "export default [{ path: ':id', component: Detail }] as Routes;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "angular app");
}

test("map names the routes of an Angular app beside the Spring routes of the same commit, ordered by evidence and identical on two runs", async () => {
  addAngularApp();

  const first = await mapOf();
  const second = await mapOf();

  assert.equal(JSON.stringify(second), JSON.stringify(first));
  const items = first.value.entrypoints.value;
  assert.deepEqual(
    items.map((item: { status: string; value?: { name: string }; reason?: string; evidence: { path: string; line: number }[] }) => `${item.evidence[0]?.path}:${item.evidence[0]?.line} ${item.value?.name ?? item.reason}`),
    ["src/OrderController.java:10 GET /orders/{id}", "web/src/app/app.routes.ts:5 /home", "web/src/app/app.routes.ts:7 no-extractor", "web/src/app/orders/orders.routes.ts:1 /orders/:id"],
  );
  assert.deepEqual(items[1].value.component, { path: "web/src/app/home.ts", symbol: "Home", line: 2 });
  assert.equal(first.inputs.engines.typescript, installedVersion("typescript"));
  assert.deepEqual(Object.keys(first.inputs.engines).toSorted(), ["tree-sitter-java", "typescript", "web-tree-sitter"]);
});

test("map of a commit that changes only a TypeScript route changes the content digest, and a spec file beside it changes nothing", async () => {
  addAngularApp();
  const before = (await mapOf()).inputs.content;
  writeFileSync(join(repo, "web", "src", "app", "home.spec.ts"), "describe('home', () => {});\n");
  git("add", "-A");
  git("commit", "-q", "-m", "spec");
  const withSpec = (await mapOf()).inputs.content;
  writeFileSync(join(repo, "web", "src", "app", "app.routes.ts"), APP_ROUTES.replace("'home'", "'start'"));
  git("commit", "-q", "-am", "rename route");

  assert.equal(withSpec, before);
  assert.notEqual((await mapOf()).inputs.content, before);
});

test("map of a commit that changes only a template a component names changes the content digest and no entrypoint", async () => {
  addAngularApp();
  writeFileSync(join(repo, "web", "src", "app", "home.html"), "<p>one</p>\n");
  git("add", "-A");
  git("commit", "-q", "-m", "template");
  const before = await mapOf();
  writeFileSync(join(repo, "web", "src", "app", "home.html"), "<p>two</p>\n");
  git("commit", "-q", "-am", "edit template");
  const after = await mapOf();

  assert.notEqual(after.inputs.content, before.inputs.content);
  const names = (fact: typeof before): unknown[] => fact.value.entrypoints.value.map((item: { value?: unknown }) => item.value);
  assert.deepEqual(names(after), names(before));
});

test("an importers fact declares no template engine and a callers fact declares it, since only callers reads Angular templates", async () => {
  const { impact } = composeQueries({ scratchRoot });
  const request = { repo, repoId: "shop-service", revision: "HEAD" };

  const importers = await impact.importers({ ...request, files: ["README.md"] });
  const callers = await impact.callers({ ...request, targets: [{ file: "README.md", start: 1, end: 1 }] });

  assert.ok(importers.ok && callers.ok);
  assert.equal("@angular/compiler" in importers.value.inputs.engines, false);
  assert.equal(callers.value.inputs.engines["@angular/compiler"], installedVersion("@angular/compiler"));
});

test("the decisions family answers over a composed workspace read: an outward name no clone serves is a free-text decision", async () => {
  const frontend = join(workspace, "shop-web");
  mkdirSync(join(frontend, "src/app"), { recursive: true });
  writeFileSync(join(frontend, "src/app/order.page.ts"), ORDER_PAGE);
  const inFrontend = (...args: string[]): string => execFileSync("git", args, { cwd: frontend, env: GIT_ENV, encoding: "utf8" }).trim();
  inFrontend("init", "-q");
  inFrontend("add", "-A");
  inFrontend("commit", "-q", "-m", "page");

  const result = await composeQueries({ scratchRoot }).decisions.decisions({ repo: { path: repo }, repos: [{ path: frontend }] });

  assert.ok(result.ok);
  assert.equal(result.value.fact.status, "complete");
  const value = (result.value.fact as { value: DecisionValue }).value;
  assert.deepEqual(
    value.repositories.map(({ repo: name }) => name),
    ["shop-service", "shop-web"],
  );
  const unserved = value.decisions.find((decision) => decision.id === "repository:shop-api");
  assert.ok(unserved !== undefined);
  assert.equal(unserved.allowsFreeText, true);
  assert.deepEqual(unserved.options, []);
  assert.deepEqual(unserved.evidence, [{ repo: "shop-web", path: "src/app/order.page.ts", line: 7, endLine: 7 }]);
  assert.deepEqual(
    value.decisions.filter((decision) => decision.kind === "trust").map((decision) => decision.id),
    ["trust:shop-service", "trust:shop-web"],
  );
});

test("a trusted sibling whose remote is passed is read at the remote's sha, and the answer carries the resolution and the freshness", async () => {
  const cacheDirectory = join(workspace, "cache", "ye-ast");
  const trustDirectory = join(workspace, "config", "ye-ast");
  const origin = join(workspace, "orders-origin");
  mkdirSync(origin);
  const inOrigin = (...args: string[]): string => execFileSync("git", args, { cwd: origin, env: GIT_ENV, encoding: "utf8" }).trim();
  inOrigin("init", "-q", "-b", "main");
  writeFileSync(join(origin, "ORDERS.md"), "orders\n");
  inOrigin("add", "-A");
  inOrigin("commit", "-q", "-m", "orders");
  const remoteSha = inOrigin("rev-parse", "HEAD");
  const url = pathToFileURL(origin).href;

  const sibling = join(workspace, "orders-svc");
  execFileSync("git", ["clone", "-q", url, sibling], { env: GIT_ENV });
  writeFileSync(join(sibling, "LOCAL.md"), "a local commit the remote does not hold\n");
  execFileSync("git", ["add", "-A"], { cwd: sibling, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "local"], { cwd: sibling, env: GIT_ENV });
  const localSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sibling, env: GIT_ENV, encoding: "utf8" }).trim();
  assert.notEqual(localSha, remoteSha);

  const manifest = join(workspace, "workspace.json");
  writeFileSync(manifest, JSON.stringify({ repos: [{ path: "../orders-svc", id: "orders", remote: url }] }));
  const install = composeCli({ scratchRoot, trustDirectory });
  const quiet = { out: () => undefined, err: () => undefined };
  assert.equal(await install(["init", "--trust", "trusted", sibling], quiet), EXIT_CODE.ok);
  assert.equal(await install(["init", "--trust", "trusted", "--workspace", manifest, repo], quiet), EXIT_CODE.ok);

  const digest = createSha256Digest();
  const refresh = createRemoteRefresh({ ...defaultRemoteRefreshDeps, cacheDirectory, digest, protocols: "file" });
  const result = await composeQueries({ scratchRoot, trustDirectory, refresh }).workspace.outwardNames({ repo: { path: repo, id: "shop-service" } });

  assert.ok(result.ok);
  const read = result.value;
  assert.deepEqual(read.refresh?.freshness, [{ repo: "orders", url, freshness: { status: "verified" } }]);
  assert.equal(read.refresh?.resolution[0]?.sha, remoteSha);
  assert.notEqual(read.fact.status, "unknown");
  const value = (read.fact as { value: WorkspaceValue }).value;
  const snapshot = value.repositorySnapshots.find(({ repo: id }) => id === "orders")?.snapshot;
  assert.equal(snapshot?.kind === "sha" ? snapshot.sha : "", remoteSha);
  assert.equal(read.repositorySources?.find(({ repo: id }) => id === "orders")?.path, join(cacheDirectory, "remotes", digest.of(url)));

  const { version, entrypoints, impact, outline, trace, workspace: workspaceQueries, workspaceImpact, decisions, redaction } = composeQueries({ scratchRoot, trustDirectory, refresh });
  const session = await openSession(createMcpServer({ version, entrypoints, impact, outline, trace, workspace: workspaceQueries, workspaceImpact, decisions, digest: createSha256Digest(), redaction, repository: { path: repo, repoId: "shop-service" } }));
  try {
    const answer = await session.callTool("ye_ast_callers", { targets: [{ file: "src/OrderController.java", symbol: "OrderController.one" }], workspace: {}, mode: "full" });
    assert.notEqual(answer.isError, true);
    assert.equal(answer.structuredContent, undefined);
    const content = answer.content.map(block => block.text).join("\n");
    const marker = `\n${RESULT_JSON_LABEL}`;
    const at = content.lastIndexOf(marker);
    assert.ok(at >= 0);
    const structured = JSON.parse(content.slice(at + marker.length)) as Record<string, unknown>;
    assert.equal(structured["mode"], "full");
    assert.deepEqual(structured["freshness"], redaction.redactValue([{ repo: "orders", url, freshness: { status: "verified" } }]));
    assert.equal((structured["resolution"] as { sha?: string }[])[0]?.sha, remoteSha);
    const { mode: _mode, freshness: _freshness, resolution: _resolution, repositoryRoots: _roots, live: _live, ...fact } = structured;
    assert.equal("freshness" in (structured["value"] as Record<string, unknown>) || "resolution" in (structured["value"] as Record<string, unknown>), false, "the sidecar stays outside the fact");
    assert.equal(JSON.stringify(fact).includes(url), false, "the remote URL never reaches a fact");
  } finally {
    await session.close();
  }
});

test("a composed decisions answer offers the origin URL of a clone the request declares without a remote, and keeps it out of the workspace fact", async () => {
  const origin = join(workspace, "orders-origin");
  mkdirSync(origin);
  const inOrigin = (...args: string[]): string => execFileSync("git", args, { cwd: origin, env: GIT_ENV, encoding: "utf8" }).trim();
  inOrigin("init", "-q", "-b", "main");
  writeFileSync(join(origin, "ORDERS.md"), "orders\n");
  inOrigin("add", "-A");
  inOrigin("commit", "-q", "-m", "orders");
  const url = pathToFileURL(origin).href;
  const sibling = join(workspace, "orders-svc");
  execFileSync("git", ["clone", "-q", url, sibling], { env: GIT_ENV });

  const queries = composeQueries({ scratchRoot });
  const request = { repo: { path: repo, id: "shop-service" }, repos: [{ path: sibling, id: "orders" }] };
  const read = await queries.workspace.outwardNames(request);
  assert.ok(read.ok);
  assert.equal(JSON.stringify(read.value.fact).includes(url), false, "the remote URL never reaches the workspace fact");

  const result = await queries.decisions.decisions(request);
  assert.ok(result.ok);
  const value = (result.value.fact as { value: DecisionValue }).value;

  const remote = value.decisions.find((decision) => decision.id === "remote:orders");
  assert.deepEqual(remote?.options.map((option) => `${option.value}(${option.basis},${option.recommended})`), [`${url}(origin,false)`]);
  assert.deepEqual(remote?.options[0]?.evidence, [{ repo: "orders", path: ".git/config", line: 1, via: "origin" }]);
  assert.equal(value.decisions.some((decision) => decision.id === "remote:shop-service"), false, "the bound repository declares nothing to confirm");
});


test("the traversal families stamp the producer every other family stamps, so compositions can derive across them", async () => {
  const { impact, version } = composeQueries({ scratchRoot });
  const answer = await impact.importers({ repo, repoId: "shop-service", revision: "HEAD", files: ["README.md"] });
  assert.ok(answer.ok);
  assert.deepEqual(answer.value.producer, { name: "ye-ast", version });
});

test("a trusted remote consumer is walked from its mirror with the declared clone's trust", async () => {
  const origin = join(workspace, "web-origin");
  const sibling = join(workspace, "shop-web");
  const trustDirectory = join(workspace, "trust");
  const cacheDirectory = join(workspace, "cache");
  mkdirSync(origin);
  const atOrigin = (...args: string[]): string => execFileSync("git", args, { cwd: origin, env: GIT_ENV, encoding: "utf8" }).trim();
  atOrigin("init", "-q", "-b", "main");
  writeFileSync(join(origin, "README.md"), "web");
  atOrigin("add", "-A");
  atOrigin("commit", "-q", "-m", "base");
  const url = pathToFileURL(origin).href;
  execFileSync("git", ["clone", "-q", url, sibling], { env: GIT_ENV });
  mkdirSync(join(origin, "src"));
  writeFileSync(join(origin, "src", "order.page.ts"), ORDER_PAGE);
  atOrigin("add", "-A");
  atOrigin("commit", "-q", "-m", "client call");
  const sha = atOrigin("rev-parse", "HEAD");
  const manifest = join(workspace, "workspace.json");
  writeFileSync(manifest, JSON.stringify({ repos: [{ path: "../shop-web", id: "web", remote: url }], gateways: [{ prefix: "shop-api", repo: "shop-service" }] }));
  const install = composeCli({ scratchRoot, trustDirectory });
  const quiet = { out: () => undefined, err: () => undefined };
  assert.equal(await install(["init", "--trust", "trusted", sibling], quiet), EXIT_CODE.ok);
  assert.equal(await install(["init", "--trust", "trusted", "--workspace", manifest, repo], quiet), EXIT_CODE.ok);
  const refresh = createRemoteRefresh({ ...defaultRemoteRefreshDeps, cacheDirectory, digest: createSha256Digest(), protocols: "file" });
  const { workspaceImpact } = composeQueries({ scratchRoot, trustDirectory, refresh });
  const result = await workspaceImpact.callers({ repo: { path: repo, id: "shop-service" }, targets: [{ file: "src/OrderController.java", symbol: "OrderController.one" }] });
  assert.ok(result.ok && result.value.fact.status !== "unknown");
  const section = result.value.fact.value.sections.web;
  assert.ok(section && section.status !== "unknown");
  assert.deepEqual(section.snapshot, { repo: "web", kind: "sha", sha });
  assert.ok(section.value.reads.some(({ kind }) => kind === "upstream"));
  assert.ok(section.value.reads.every(({ fact }) => fact.inputs.trust === "trusted"), JSON.stringify(section.value.reads.map(({ kind, fact }) => [kind, fact.inputs.trust])));
  assert.equal(section.value.impact?.seeds[0]?.symbol, "open");
});


test("composed canonical repository root returns the worktree path, not its name", async () => {
  const result = await composeQueries().canonicalRepositoryRoot(repo);
  assert.deepEqual(result, { ok: true, value: realpathSync(repo) });
});

test("composed canonical repository root forwards cancellation", async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await composeQueries().canonicalRepositoryRoot(repo, controller.signal);

  assert.equal(!result.ok && result.fault.kind, "aborted");
});

test("workspace impact replays persisted moving members from their original content", async () => {
  const member = join(workspace, "shop-web");
  const trustDirectory = join(workspace, "trust-replay");
  mkdirSync(join(member, "src"), { recursive: true });
  const memberGit = (...args: string[]) => execFileSync("git", args, { cwd: member, env: GIT_ENV, encoding: "utf8" }).trim();
  memberGit("init", "-q", "-b", "main");
  writeFileSync(join(member, "src", "order.page.ts"), ORDER_PAGE);
  memberGit("add", "-A");
  memberGit("commit", "-q", "-m", "old client");
  const old = memberGit("rev-parse", "HEAD");
  const base = git("rev-parse", "HEAD");
  const manifest = join(workspace, "replay-workspace.json");
  writeFileSync(manifest, JSON.stringify({ repos: [{ path: "../shop-web", id: "web", revision: "main" }], gateways: [{ prefix: "shop-api", repo: "shop-service" }] }));
  const quiet = { out: () => undefined, err: () => undefined };
  assert.equal(await composeCli({ scratchRoot, trustDirectory })(["init", "--trust", "trusted", "--workspace", manifest, repo], quiet), EXIT_CODE.ok);
  const { workspaceImpact } = composeQueries({ scratchRoot, trustDirectory });
  const callers = { repo: { path: repo, id: "shop-service" }, targets: [{ file: "src/OrderController.java", symbol: "OrderController.one" }] };
  const change = { repo: { ...callers.repo, revision: base }, base };
  const first = await workspaceImpact.callers(callers);
  const firstChange = await workspaceImpact.ofChange(change);
  assert.ok(first.ok && first.value.workspaceReplay && first.value.fact.status !== "unknown");
  assert.ok(firstChange.ok && firstChange.value.workspaceReplay);
  assert.equal(first.value.fact.value.workspace.source, "persisted");
  const firstSection = first.value.fact.value.sections.web;
  assert.ok(firstSection && firstSection.status !== "unknown");
  assert.equal(firstSection.snapshot.kind === "sha" && firstSection.snapshot.sha, old);
  assert.ok(firstSection.value.callSites.some((site) => site.file === "src/order.page.ts"));
  const upstream = firstSection.value.reads.find(({ kind }) => kind === "upstream");
  assert.deepEqual(upstream?.fact.snapshot, { repo: "web", kind: "sha", sha: old });
  assert.ok(first.value.repositoryRoots?.some((entry) => entry.repo === "web" && entry.path === member));
  writeFileSync(join(member, "src", "order.page.ts"), ORDER_PAGE.replace("shop-api/orders/7", "other-api/changed"));
  memberGit("add", "-A");
  memberGit("commit", "-q", "-m", "new client");
  const current = await workspaceImpact.callers(callers);
  assert.ok(current.ok);
  assert.notDeepEqual(current.value.fact, first.value.fact);
  assert.notEqual(current.value.fact.status, "unknown");
  if (current.value.fact.status === "unknown") throw new Error("missing current fact");
  const currentSection = current.value.fact.value.sections.web;
  assert.ok(currentSection && currentSection.status !== "unknown");
  assert.notDeepEqual(currentSection.value.callSites, firstSection.value.callSites);
  const replayed = await workspaceImpact.callers({ ...callers, replay: first.value.workspaceReplay });
  const replayedChange = await workspaceImpact.ofChange({ ...change, replay: firstChange.value.workspaceReplay });
  assert.ok(replayed.ok && replayedChange.ok);
  assert.deepEqual(replayed.value.fact, first.value.fact);
  assert.deepEqual(replayedChange.value.fact, firstChange.value.fact);
  assert.deepEqual(replayed.value.workspaceReplay, first.value.workspaceReplay);
  assert.deepEqual(replayed.value.repositoryRoots, first.value.repositoryRoots);
  writeFileSync(join(repo, ".ye-ast", "workspace.json"), JSON.stringify({ repos: [{ path: "../shop-web", id: "web", revision: "main" }], gateways: [{ prefix: "changed", repo: "shop-service" }] }));
  const mismatch = await workspaceImpact.callers({ ...callers, replay: first.value.workspaceReplay });
  assert.ok(!mismatch.ok && mismatch.fault.kind === "workspace-replay-mismatch");
});

test("a measured map writes its export, materialize and entrypoint stages before its query line", async () => {
  const lines: string[] = [];
  await mapOf({ measure: (line) => lines.push(line) });

  const records = lines.map((line) => JSON.parse(line).ye_ast as { event: string; stage?: string });
  assert.deepEqual(records.filter((record) => record.event !== "cache").map((record) => record.stage ?? record.event), ["export", "materialize", "entrypoints", "query"]);
});

test("a repeated map lists the commit again but writes none of its files when the snapshot data is kept", async () => {
  const lines: string[] = [];
  const queries = composeQueries({ scratchRoot, measure: (line) => lines.push(line) });
  const request = { repo, repoId: "shop", revision: "HEAD" };
  const first = await queries.entrypoints.map(request);
  const firstLines = lines.length;
  const second = await queries.entrypoints.map(request);

  assert.deepEqual(second, first);
  const repeated = lines.slice(firstLines).map((line) => JSON.parse(line).ye_ast as { event: string; stage?: string });
  assert.deepEqual(repeated.filter((record) => record.event !== "cache").map((record) => record.stage ?? record.event), ["export", "query"]);
});

test("a measured composition writes cache lines for the snapshot data it keeps, and none when measurement is off", async () => {
  const lines: string[] = [];
  const request = { repo, repoId: "shop", revision: "HEAD" };
  const measured = composeQueries({ scratchRoot, measure: (line) => lines.push(line) });
  await measured.entrypoints.map(request);
  await measured.entrypoints.map(request);
  const quiet = composeQueries({ scratchRoot });
  await quiet.entrypoints.map(request);

  const outcomes = lines.map((line) => JSON.parse(line).ye_ast as { event: string; outcome: string }).filter((record) => record.event === "cache").map((record) => record.outcome);
  assert.equal(outcomes[0], "miss");
  assert.ok(outcomes.includes("admitted"));
  assert.equal(outcomes.at(-1), "hit");
});

test("a measured live map attributes its lock, listing and reconcile as stages", async () => {
  const trustDirectory = join(workspace, "trust-live-stages");
  const quiet = { out: () => undefined, err: () => undefined };
  assert.equal(await composeCli({ scratchRoot, trustDirectory })(["init", "--trust", "trusted", repo], quiet), EXIT_CODE.ok);
  const lines: string[] = [];

  await composeQueries({ scratchRoot, trustDirectory, measure: (line) => lines.push(line) }).entrypoints.map({ repo, repoId: "shop", live: true });

  const stages = lines.map((line) => JSON.parse(line).ye_ast as { event: string; stage?: string }).flatMap((record) => (record.event === "stage" && record.stage?.startsWith("live-") ? [record.stage] : []));
  for (const stage of ["live-lock", "live-read-state", "live-list", "live-reconcile", "live-touch", "live-release", "live-usage"]) assert.ok(stages.includes(stage), stage);
});

test("a trace over a real index charges an anonymous callback to its encloser, defers a named one passed as a value, and never reaches an unused nested function", async () => {
  writeFileSync(join(repo, "src", "flow.ts"), [
    "export function run(items: number[]): number[] {",
    "  function unused(): void {}",
    "  const named = (value: number): number => value + 1;",
    "  items.forEach((item) => helper(item));",
    "  return items.map(named);",
    "}",
    "export function helper(value: number): number {",
    "  return value * 2;",
    "}",
    "",
  ].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "flow");
  const { trace } = composeQueries({ scratchRoot });

  const answer = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/flow.ts", symbol: "run" }] });

  assert.ok(answer.ok);
  assert.equal(answer.value.status, "complete");
  assert.deepEqual(answer.value.status === "complete" && answer.value.value.steps, [{
    id: 0, depth: 0, file: "src/flow.ts", symbol: "run", kind: "function", line: 1, endLine: 6,
    leaves: [{ symbol: "helper", file: "src/flow.ts", start: 7, end: 9 }, { symbol: "named", file: "src/flow.ts", start: 3, end: 3, deferred: true }],
    external: [{ kind: "global", names: ["items.forEach", "items.map"] }],
  }]);
});

test("a trace over a real index follows a call to an object literal's function, and keeps a member call named after a top-level function a cut", async () => {
  writeFileSync(join(repo, "src", "table.ts"), [
    "export const table = { pick: (value: number): number => value };",
    "export function format(value: number): string {",
    "  return String(value);",
    "}",
    "export function run(price: number): number {",
    "  price.toFixed(2).format();",
    "  return table.pick(price);",
    "}",
    "",
  ].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "table");
  const { trace } = composeQueries({ scratchRoot });

  const answer = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/table.ts", symbol: "run" }] });

  assert.ok(answer.ok);
  assert.equal(answer.value.status, "partial");
  assert.deepEqual(answer.value.status === "partial" && answer.value.value.steps[0]?.leaves, [{ symbol: "pick", file: "src/table.ts", start: 1, end: 1 }]);
  assert.deepEqual(answer.value.status === "partial" && answer.value.value.steps[0]?.external, [{ kind: "unnamed", names: ["price.toFixed"] }]);
  assert.deepEqual(answer.value.status === "partial" && answer.value.cuts.map((cut) => cut.at), [["src/table.ts:6 price.toFixed().format", "src/table.ts::format"]]);
});

test("callers and a trace at one snapshot read the relations once, under the one retained key", async () => {
  writeFileSync(join(repo, "src", "shared.ts"), ["export function shared(items: number[]): void {", "  items.forEach(String);", "}", ""].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "shared");
  const lines: string[] = [];
  const { impact, trace } = composeQueries({ scratchRoot, measure: (line) => lines.push(line) });
  const relationReads = (): number => lines.filter((line) => { const record = JSON.parse(line).ye_ast as { event: string; stage?: string }; return record.event === "stage" && record.stage === "relations"; }).length;
  const target = { file: "src/shared.ts", symbol: "shared" };

  assert.ok((await impact.callers({ repo, repoId: "shop-service", revision: "HEAD", targets: [target] })).ok);
  assert.equal(relationReads(), 1);
  assert.ok((await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [target] })).ok);

  assert.equal(relationReads(), 1);
});

test("a trace over a real index leaves a library global's member call as a global leaf, and keeps it a cut where a local shadows the global", async () => {
  writeFileSync(join(repo, "src", "clamp.ts"), ["export function clamp(value: number): number {", "  return Math.max(value, 0);", "}", "export function max(value: number): number {", "  return value;", "}", ""].join("\n"));
  writeFileSync(join(repo, "src", "shadow.ts"), ["import { max } from './clamp';", "export function shadowed(value: number): number {", "  const Math = { max };", "  return Math.max(value);", "}", ""].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "roots");
  const { trace } = composeQueries({ scratchRoot });

  const [plain, shadowed] = await Promise.all([
    trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/clamp.ts", symbol: "clamp" }] }),
    trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/shadow.ts", symbol: "shadowed" }] }),
  ]);

  assert.ok(plain.ok && shadowed.ok);
  assert.equal(plain.value.status, "complete");
  assert.deepEqual(plain.value.status === "complete" && plain.value.value.steps[0]?.external, [{ kind: "global", names: ["Math.max"] }]);
  assert.equal(shadowed.value.status, "partial");
  assert.deepEqual(shadowed.value.status === "partial" && shadowed.value.cuts.map((cut) => cut.at[0]), ["src/shadow.ts:4 Math.max"]);
});

/** Whether a trace answered steps or folded leaves at a declaration named `symbol`. */
function reaches(fact: Awaited<ReturnType<TraceQueries["walk"]>>, symbol: string): boolean {
  if (!fact.ok || fact.value.status === "unknown") return true;
  return fact.value.value.steps.some((step) => step.symbol === symbol || (step.leaves ?? []).some((leaf) => leaf.symbol === symbol));
}

test("a trace over a real index never takes a class's method as what runs on a type a sibling also fits through a brand both inherit", async () => {
  writeFileSync(join(repo, "src", "kinds.ts"), ["export abstract class Base { protected brand = 0; }", "export class Plain extends Base { save(): number { return 1; } }", "export class Twin extends Base { save(): number { return 2; } }", "export function use(p: Plain): number { return p.save(); }", "use(new Twin());", ""].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "siblings");
  const { trace } = composeQueries({ scratchRoot });

  const fact = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/kinds.ts", symbol: "use" }] });

  assert.ok(fact.ok);
  assert.equal(fact.value.status, "partial");
  assert.equal(reaches(fact, "save"), false);
});

test("a trace over a real index takes no method as what runs on a receiver it sees only through a wrapper, a cast, an index, an optional chain, a comma, a condition or a call", async () => {
  const forms: Record<string, string> = {
    paren: "(p).save()",
    bang: "p!.save()",
    satisfied: "(p satisfies Plain).save()",
    cast: "(p as Plain).save()",
    angle: "(<Plain>p).save()",
    element: "[p][0].save()",
    optional: "p?.save()",
    comma: "(0, p).save()",
    conditional: "(p ? p : p).save()",
    called: "(() => p)().save()",
  };
  writeFileSync(join(repo, "src", "forms.ts"), [
    "export class Plain { save(): number { return 1; } }",
    "export class Twin { save(): number { return 2; } }",
    ...Object.entries(forms).map(([name, call]) => `export function ${name}(p: Plain): number { return ${call}; }`),
    "export class Holder { field: Plain = new Plain(); run(): number { return (this.field).save(); } }",
    "",
  ].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "forms");
  const { trace } = composeQueries({ scratchRoot });

  const indexed = ["paren", "bang", "satisfied", "cast", "angle", "optional", "Holder.run"];
  for (const name of [...Object.keys(forms), "Holder.run"]) {
    const fact = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/forms.ts", symbol: name }] });
    assert.equal(reaches(fact, "save"), false, name);
    if (indexed.includes(name)) assert.ok(fact.ok && fact.value.status === "partial", name);
  }
  const proven: Record<string, boolean> = { paren: true, bang: true, satisfied: true, cast: false, angle: false, optional: false, constructedCast: false, constructedAngle: false };
  writeFileSync(join(repo, "src", "branded.ts"), [
    "export class Branded { private id = 0; save(): number { return this.id; } }",
    "export class Twin { save(): number { return 2; } }",
    ...Object.keys(proven).map((name) => `export function ${name}(p: Branded): number { return ${{ ...forms, constructedCast: "(new Branded() as Branded).save()", constructedAngle: "(<Branded>new Branded()).save()" }[name]}; }`),
    "",
  ].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "branded");
  for (const [name, step] of Object.entries(proven)) {
    const fact = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/branded.ts", symbol: name }] });
    assert.equal(reaches(fact, "save"), step, `branded ${name}`);
  }
});

const JAVA_ORDERS = [
  "package shop;",
  "",
  "import java.util.Collections;",
  "import java.util.List;",
  "import org.springframework.web.client.RestTemplate;",
  "",
  "class Orders {",
  "  private final RestTemplate rest;",
  "  Orders(RestTemplate rest) { this.rest = rest; }",
  "  List<String> run(List<String> items) {",
  "    items.add(\"a\");",
  "    this.rest.getForObject(\"/x\", String.class);",
  "    return Collections.emptyList();",
  "  }",
  "}",
  "",
].join("\n");

/** Repository methods named like the platform members `Orders.run` calls, so a call settled by its name alone is a cut. */
const JAVA_HOMONYMS = ["package shop;", "", "class Store {", "  void add(String value) {}", "  String getForObject(String url, Class<?> type) { return \"\"; }", "  java.util.List<String> emptyList() { return null; }", "}", ""];

test("a Java trace over a real index leaves a call on a platform-typed parameter or private field, or on a platform class, as a leaf under its package, and keeps the typed calls cuts once a lambda may implement any platform type", async () => {
  writeFileSync(join(repo, "src", "Orders.java"), JAVA_ORDERS);
  writeFileSync(join(repo, "src", "Store.java"), JAVA_HOMONYMS.join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "orders");
  const { trace } = composeQueries({ scratchRoot });
  const target = { file: "src/Orders.java", symbol: "Orders.run" };

  const typed = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [target] });
  writeFileSync(join(repo, "src", "Store.java"), JAVA_HOMONYMS.join("\n").replace("class Store {", "class Store {\n  Runnable task = () -> {};"));
  git("add", "-A");
  git("commit", "-q", "-m", "lambda");
  const lambda = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [target] });

  assert.ok(typed.ok && lambda.ok);
  assert.equal(typed.value.status, "complete");
  assert.deepEqual(typed.value.status === "complete" && typed.value.value.steps[0]?.external, [
    { kind: "import", module: "java.util", names: ["Collections.emptyList", "items.add"] },
    { kind: "import", module: "org.springframework.web.client", names: ["rest.getForObject"] },
  ]);
  assert.equal(lambda.value.status, "partial");
  assert.deepEqual(lambda.value.status === "partial" && lambda.value.cuts.map((cut) => cut.at[0]), ["src/Orders.java:11 items.add", "src/Orders.java:12 rest.getForObject"]);
});

/** The cuts a Java trace of `Use.entry` gives over a fresh repository holding `files`. */
async function javaTraceCuts(name: string, files: Readonly<Record<string, string>>): Promise<readonly (readonly string[])[]> {
  const root = join(workspace, name);
  mkdirSync(root);
  const run = (...args: string[]): string => execFileSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf8" }).trim();
  run("init", "-q");
  for (const [file, content] of Object.entries(files)) writeFileSync(join(root, file), content);
  run("add", "-A");
  run("commit", "-q", "-m", name);
  const answer = await composeQueries({ scratchRoot }).trace.walk({ repo: root, repoId: name, revision: "HEAD", targets: [{ file: "Use.java", symbol: "Use.entry" }] });
  assert.ok(answer.ok);
  return answer.value.status === "partial" ? answer.value.cuts.map((cut) => [cut.kind, ...cut.at]) : [];
}

test("a Java trace keeps a call a cut when a dynamic proxy may implement its platform type, when a JVM source no extractor reads may, or when the call reads a platform class's field", async () => {
  const proxy = ["import java.lang.Runnable;", "import java.beans.EventHandler;", "public class Use {", "  public void run() { System.out.println(\"REPOSITORY_RUN\"); }", "  public void entry(Runnable task) { task.run(); }", "  public static void main(String[] args) { Use owner = new Use(); owner.entry(EventHandler.create(Runnable.class, owner, \"run\")); }", "}", ""].join("\n");
  const field = ["import java.lang.Runnable;", "public class Use {", "  private Runnable task;", "  public void run() { System.out.println(\"REPOSITORY_RUN\"); }", "  public void entry() { this.task.run(); }", "}", ""].join("\n");
  const wiring = ["import java.lang.Runnable;", "import java.beans.EventHandler;", "import java.lang.reflect.Field;", "public class Wiring {", "  public static void main(String[] args) throws Exception {", "    Use owner = new Use();", "    Field field = Use.class.getDeclaredField(\"task\");", "    field.setAccessible(true);", "    field.set(owner, EventHandler.create(Runnable.class, owner, \"run\"));", "  }", "}", ""].join("\n");
  const system = ["import java.lang.System;", "public class Use {", "  public void entry() { System.out.println(\"x\"); }", "  public static void main(String[] args) { System.setOut(new RepoStream()); new Use().entry(); }", "}", "class RepoStream extends java.io.PrintStream {", "  RepoStream() { super(new java.io.ByteArrayOutputStream()); }", "  public void println(String text) { System.err.println(\"REPOSITORY_PRINTLN\"); }", "}", ""].join("\n");
  const kotlin = ["import java.lang.Runnable;", "class Use { void entry(Runnable task) { task.run(); } }", "class Other { void run() {} }", ""].join("\n");

  assert.deepEqual(await javaTraceCuts("eventhandler", { "Use.java": proxy }), [["unresolved-link", "Use.java:5 task.run", "Use.java::Use.run"]]);
  assert.deepEqual(await javaTraceCuts("reflectproxy", { "Use.java": field, "Wiring.java": wiring }), [["unresolved-link", "Use.java:5 task.run", "Use.java::Use.run"]]);
  assert.deepEqual(await javaTraceCuts("systemout", { "Use.java": system }), [["unresolved-link", "Use.java:3 System.out.println", "Use.java::RepoStream.println"]]);
  assert.deepEqual(await javaTraceCuts("kotlin", { "Use.java": kotlin, "Repo.kt": "class Repo: Runnable { override fun run() { println(\"repo\") } }\n" }), [["unresolved-link", "Use.java:2 task.run", "Use.java::Other.run"], ["no-extractor", "Repo.kt"]]);
});

/** A fresh repository under the workspace holding `files` in one commit. */
function committedRepository(name: string, files: Readonly<Record<string, string>>): string {
  const root = join(workspace, name);
  mkdirSync(root);
  const run = (...args: string[]): string => execFileSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf8" }).trim();
  run("init", "-q");
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  run("add", "-A");
  run("commit", "-q", "-m", name);
  return root;
}

/** The status, the symbols at depth one or more and the cuts the callers query gives for `target` over a fresh repository holding `files`. */
async function callersOf(name: string, files: Readonly<Record<string, string>>, target: { file: string; symbol: string }) {
  const answer = await composeQueries({ scratchRoot }).impact.callers({ repo: committedRepository(name, files), repoId: name, revision: "HEAD", targets: [target] });
  assert.ok(answer.ok);
  const { status } = answer.value;
  return { status, callers: status === "unknown" ? [] : answer.value.value.symbols.filter((symbol) => symbol.depth > 0).map((symbol) => symbol.symbol), cuts: status === "partial" ? answer.value.cuts.map((cut) => [cut.kind, ...cut.at]) : [] };
}

/** The status, cuts and steps (symbol and external calls) a trace of `target` gives over a fresh repository holding `files`. */
async function traceOf(name: string, files: Readonly<Record<string, string>>, target = { file: "Use.java", symbol: "Use.entry" }) {
  const answer = await composeQueries({ scratchRoot }).trace.walk({ repo: committedRepository(name, files), repoId: name, revision: "HEAD", targets: [target] });
  assert.ok(answer.ok);
  const { status } = answer.value;
  return { status, cuts: status === "partial" ? answer.value.cuts.map((cut) => [cut.kind, ...cut.at]) : [], steps: status === "unknown" ? [] : answer.value.value.steps.map((step) => [step.symbol, step.external ?? null]) };
}

test("a Java trace never settles a call by a root it reads past, whether the graph resolved the call or left it pending", async () => {
  const stream = ["class RepoStream extends java.io.PrintStream {", "  RepoStream() { super(new java.io.ByteArrayOutputStream()); }", "  public void println(String text) { System.err.println(\"REPOSITORY_PRINTLN\"); }", "}", ""];
  const qualified = ["import java.lang.System;", "public class Use {", "  public void entry() { java.lang.System.out.println(\"x\"); }", "  public static void main(String[] args) {", "    System.setOut(new RepoStream());", "    new Use().entry();", "  }", "}", ...stream].join("\n");
  const field = ["public class Use {", "  public void entry() { java.util.Collections.EMPTY_LIST.size(); }", "}", "class Other { int size() { return 1; } }", ""].join("\n");
  const alias = ["public class Use {", "  public void entry() { var o = System.out; o.println(\"x\"); }", "  public static void main(String[] args) { System.setOut(new RepoStream()); new Use().entry(); }", "}", ...stream].join("\n");

  assert.deepEqual(await traceOf("qualified", { "Use.java": qualified }), { status: "partial", cuts: [["unresolved-link", "Use.java:11 System.err.println", "Use.java::RepoStream.println"]], steps: [["entry", null], ["println", null]] });
  assert.deepEqual(await traceOf("qualifiedfield", { "Use.java": field }), { status: "complete", cuts: [], steps: [["entry", null]] });
  assert.deepEqual(await traceOf("varalias", { "Use.java": alias }), { status: "complete", cuts: [], steps: [["entry", null], ["println", null], ["println", null]] });
});

/** The status, cuts and steps (symbol, place, parent, via, the step it repeats and its leaves) of a trace of `Use.entry` over a fresh repository holding `files`. */
async function javaTrace(name: string, files: Readonly<Record<string, readonly string[]>>) {
  const answer = await composeQueries({ scratchRoot }).trace.walk({
    repo: committedRepository(name, Object.fromEntries(Object.entries(files).map(([file, lines]) => [file, [...lines, ""].join("\n")]))),
    repoId: name,
    revision: "HEAD",
    targets: [{ file: "Use.java", symbol: "Use.entry" }],
  });
  assert.ok(answer.ok);
  const { status } = answer.value;
  return {
    status,
    cuts: status === "partial" ? answer.value.cuts.map((cut) => [cut.kind, ...cut.at]) : [],
    steps: status === "unknown" ? [] : answer.value.value.steps.map((step) => [`${step.file}:${step.line} ${step.symbol}`, step.parent ?? null, step.via ?? null, step.seen ?? null, step.leaves?.map((leaf) => `${leaf.file}:${leaf.start} ${leaf.symbol}`) ?? null]),
  };
}

/** A port with one implementation, and a homonym of each of its methods, so a call settled by its name is a cut. */
const REPO_PORT: Readonly<Record<string, readonly string[]>> = {
  "Repo.java": ["public interface Repo {", "  void save(String value);", "  Repo find();", "}"],
  "JdbcRepo.java": ["public class JdbcRepo implements Repo {", "  public void save(String value) {}", "  public Repo find() { return this; }", "}"],
  "Other.java": ["class Other {", "  void save(String value) {}", "  Repo find() { return null; }", "}"],
};

test("a Java call on what a repository method declares it returns steps at the method of that declared type, and dispatch expands the one body below it", async () => {
  const use = ["public class Use {", "  public void entry(Repo param) {", "    param.find().save(\"c\");", "  }", "}"];

  assert.deepEqual(await javaTrace("chained", { ...REPO_PORT, "Use.java": use }), {
    status: "complete",
    cuts: [],
    steps: [
      ["Use.java:2 entry", null, null, null, null],
      ["Repo.java:3 find", 0, "call", null, ["JdbcRepo.java:3 find"]],
      ["Repo.java:2 save", 0, "call", null, ["JdbcRepo.java:2 save"]],
    ],
  });
});

test("a Java call the index resolved on a parameter steps at the method the parameter's declared type names, with a cut at a subclass that overrides it, and is a cut when the declared hierarchy proves nothing", async () => {
  const use = ["public class Use {", "  public void entry(Plain p) {", "    p.save();", "  }", "}"];
  const plain = ["class Plain {", "  void save() {}", "}"];
  const twin = ["class Twin extends Plain {", "  void save() {}", "}"];

  assert.deepEqual(await javaTrace("overridden", { "Use.java": use, "Plain.java": plain, "Twin.java": twin }), {
    status: "partial",
    cuts: [["unresolved-link", "Plain.java:2 save", "Twin.java::Twin.save"]],
    steps: [
      ["Use.java:2 entry", null, null, null, null],
      ["Plain.java:2 save", 0, "call", null, null],
    ],
  });
  const kotlin = "class Twin : Plain() { override fun save() { System.exit(1) } }\n";
  assert.deepEqual(await javaTrace("kotlin", { "Use.java": use, "Plain.java": plain, "Twin.kt": [kotlin] }), {
    status: "partial",
    cuts: [["unresolved-link", "Use.java:3 save", "Plain.java::Plain.save"], ["no-extractor", "Twin.kt"]],
    steps: [["Use.java:2 entry", null, null, null, null]],
  });
});

test("a Java call on a parameter whose declared type is a record steps at the record's method, which the index holds as a function of no container", async () => {
  const use = ["public class Use {", "  public void entry(Order order) {", "    order.total();", "  }", "}"];
  const order = ["public record Order(int amount) {", "  public int total() { return amount; }", "}"];
  const other = ["class Other {", "  int total() { return 0; }", "}"];

  assert.deepEqual(await javaTrace("record", { "Use.java": use, "Order.java": order, "Other.java": other }), {
    status: "complete",
    cuts: [],
    steps: [["Use.java:2 entry", null, null, null, ["Order.java:2 total"]]],
  });
});

test("a Java method that names a parameter type like an inherited one's, from another package, is an overload: the call through the declared type is not proven to run it", async () => {
  const files = {
    "Use.java": ["class Factory {", " b.Sub get() { return new b.Sub(); }", "}", "class Use {", " void entry(Factory f, a.X x) { f.get().save(x); }", "}"],
    "a/Base.java": ["package a;", "public class Base {", " public void save(X arg) { baseBody(); }", " void baseBody() {}", "}"],
    "a/X.java": ["package a;", "public class X {}"],
    "b/Sub.java": ["package b;", "public class Sub extends a.Base {", " public void save(X arg) { subBody(); }", " void subBody() {}", "}"],
    "b/X.java": ["package b;", "public class X {}"],
  };

  const answer = await javaTrace("homonym-signature", files);

  assert.equal(answer.status, "partial");
  assert.ok(!answer.steps.some(([place]) => place === "b/Sub.java:3 save"));
});

test("a Java call the index resolved on a non-private field or a var local stays a step under an aspect, since nothing falsifies the declared type", async () => {
  const use = ["public class Use {", "  Plain field;", "  public void entry() {", "    field.save();", "    var local = new Plain();", "    local.save();", "  }", "}"];
  const plain = ["class Plain {", "  void save() {}", "}"];
  const aspect = ["@org.aspectj.lang.annotation.Aspect", "class Logging {}"];

  assert.deepEqual(await javaTrace("aspect", { "Use.java": use, "Plain.java": plain, "Logging.java": aspect }), {
    status: "complete",
    cuts: [],
    steps: [["Use.java:3 entry", null, null, null, ["Plain.java:2 save", "Plain.java:1 Plain"]]],
  });
});

test("a TypeScript trace settles a call by its package or global root only when the call reads one member below it", async () => {
  const manifest = JSON.stringify({ name: "use", dependencies: { "other-lib": "1.0.0" } });
  const logger = ["import * as other from \"other-lib\";", "class Sink {", "  flush(): void { console.log(\"REPOSITORY_FLUSH\"); }", "}", "export function entry(): void {", "  other.setLogger(new Sink());", "  other.logger.flush();", "}", ""].join("\n");
  const dom = ["export function entry(node: Node): void {", "  document.body.appendChild(node);", "}", ""].join("\n");

  assert.deepEqual(await traceOf("tslogger", { "package.json": manifest, "use.ts": logger }, { file: "use.ts", symbol: "entry" }), { status: "partial", cuts: [["unresolved-link", "use.ts:7 other.logger.flush", "use.ts::Sink.flush"]], steps: [["entry", [{ kind: "import", module: "other-lib", names: ["other.setLogger"] }]]] });
  assert.deepEqual(await traceOf("tsdom", { "package.json": manifest, "use.ts": dom }, { file: "use.ts", symbol: "entry" }), { status: "complete", cuts: [], steps: [["entry", [{ kind: "unnamed", names: ["document.body.appendChild"] }]]] });
});

test("callers never settles a call by a package, global or platform root the call reads past", async () => {
  const stream = ["class RepoStream extends java.io.PrintStream {", "  RepoStream() { super(new java.io.ByteArrayOutputStream()); }", "  public void println(String text) { System.err.println(\"REPOSITORY_PRINTLN\"); }", "}", ""];
  const qualified = ["import java.lang.System;", "public class Use {", "  public void entry() { java.lang.System.out.println(\"x\"); }", "  public static void main(String[] args) {", "    System.setOut(new RepoStream());", "    new Use().entry();", "  }", "}", ...stream].join("\n");
  const manifest = JSON.stringify({ name: "use", dependencies: { "other-lib": "1.0.0" } });
  const logger = ["import * as other from \"other-lib\";", "class Sink {", "  flush(): void { console.log(\"REPOSITORY_FLUSH\"); }", "}", "export function entry(): void {", "  other.setLogger(new Sink());", "  other.logger.flush();", "}", ""].join("\n");

  assert.deepEqual(await callersOf("callersqualified", { "Use.java": qualified }, { file: "Use.java", symbol: "RepoStream.println" }), { status: "partial", callers: ["Use", "entry"], cuts: [["unresolved-link", "Use.java", "Use.java:11 System.err.println", "Use.java:6 new Use().entry"]] });
  assert.deepEqual(await callersOf("callerslogger", { "package.json": manifest, "use.ts": logger }, { file: "use.ts", symbol: "Sink.flush" }), { status: "partial", callers: [], cuts: [["unresolved-link", "use.ts", "use.ts:7 other.logger.flush"]] });
});

test("importers counts as a user a file whose call reads past a platform root into a repository override", async () => {
  const files = {
    "Boot.java": ["public class Boot {", "  public static void main(String[] args) { System.setOut(new RepoStream()); new Use().entry(); }", "}", ""].join("\n"),
    "RepoStream.java": ["class RepoStream extends java.io.PrintStream {", "  RepoStream() { super(new java.io.ByteArrayOutputStream()); }", "  public void println(String text) { System.err.println(\"REPOSITORY_PRINTLN\"); }", "}", ""].join("\n"),
    "Use.java": ["public class Use {", "  public void entry() { java.lang.System.out.println(\"x\"); }", "}", ""].join("\n"),
  };
  const answer = await composeQueries({ scratchRoot }).impact.importers({ repo: committedRepository("importerspastroot", files), repoId: "importerspastroot", revision: "HEAD", files: ["RepoStream.java"] });

  assert.ok(answer.ok);
  assert.deepEqual(answer.value.status === "unknown" ? undefined : answer.value.value.files.map((entry) => entry.users), [["Boot.java", "Use.java"]]);
});

/** Repository functions named like library members, so a member call settled by its name alone is a cut. */
const HOMONYMS = ["export function push(): void {}", "export function test(): void {}", "export function set(): void {}", "export function save(): void {}", "export class Other {", "  save(): void {}", "}", ""].join("\n");

test("a trace over a real index settles a member call on a local every store binds to one literal type, one library class or one repository class", async () => {
  writeFileSync(join(repo, "src", "homonyms.ts"), HOMONYMS);
  writeFileSync(join(repo, "src", "store.ts"), ["export class Store {", "  save(): void {", "    Date.now();", "  }", "}", ""].join("\n"));
  writeFileSync(join(repo, "src", "locals.ts"), [
    "import { Store } from './store';",
    "class Local {",
    "  save(): void {",
    "    Date.now();",
    "  }",
    "}",
    "export function locals(flag: boolean): void {",
    "  let parts = ['a'];",
    "  if (flag) parts = [];",
    "  parts.push('b');",
    "  const pattern = /x/;",
    "  pattern.test('x');",
    "  const label = `x`;",
    "  label.toString();",
    "  const cache = new Map();",
    "  cache.set('k', 1);",
    "  let local;",
    "  local = new Local();",
    "  local.save();",
    "  let store;",
    "  store = new Store();",
    "  store.save();",
    "}",
    "",
  ].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "locals");
  const { trace } = composeQueries({ scratchRoot });

  const answer = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/locals.ts", symbol: "locals" }] });

  assert.ok(answer.ok);
  assert.equal(answer.value.status, "complete");
  const [root, ...steps] = answer.value.status === "complete" ? answer.value.value.steps : [];
  assert.deepEqual(root?.external, [{ kind: "global", names: ["Map", "cache.set", "label.toString", "parts.push", "pattern.test"] }]);
  assert.deepEqual(steps.map(({ file, symbol, at }) => [file, symbol, at?.line]), [["src/locals.ts", "save", 19], ["src/store.ts", "save", 22]]);
});

test("a trace over a real index keeps a member call on a local a cut when a store disagrees, the value escapes or is written through, or the binding is not the file's own", async () => {
  writeFileSync(join(repo, "src", "homonyms.ts"), HOMONYMS);
  writeFileSync(join(repo, "src", "guarded.ts"), [
    "import { other, patch } from './other';",
    "export function guarded(param: string[]): void {",
    "  let mixed = new Map();",
    "  mixed = other();",
    "  mixed.set('k', 1);",
    "  let counted = 'a';",
    "  counted += 'b';",
    "  counted.test();",
    "  const leaked: string[] = [];",
    "  patch(leaked);",
    "  leaked.push('a');",
    "  const patched: string[] = [];",
    "  patched.push = other;",
    "  patched.push('a');",
    "  param.push('a');",
    "  const [first] = [[]];",
    "  first.push('a');",
    "  exported.push('a');",
    "}",
    "export const exported: string[] = [];",
    "",
  ].join("\n"));
  writeFileSync(join(repo, "src", "other.ts"), ["export function other(): any { return new Map(); }", "export function patch(value: unknown): void {}", ""].join("\n"));
  writeFileSync(join(repo, "src", "script.ts"), ["var shared = [];", "function scripted(scope) {", "  shared.push('a');", "  var dynamic = [];", "  with (scope) { dynamic = other; }", "  dynamic.push('a');", "}", ""].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "guarded");
  const { trace } = composeQueries({ scratchRoot });

  const [guarded, scripted] = await Promise.all([
    trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/guarded.ts", symbol: "guarded" }] }),
    trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/script.ts", symbol: "scripted" }] }),
  ]);

  assert.ok(guarded.ok && scripted.ok);
  assert.deepEqual(guarded.value.status === "partial" && guarded.value.cuts.map((cut) => cut.at[0]), [
    "src/guarded.ts:11 leaked.push",
    "src/guarded.ts:14 patched.push",
    "src/guarded.ts:17 first.push",
    "src/guarded.ts:18 exported.push",
    "src/guarded.ts:5 mixed.set",
    "src/guarded.ts:8 counted.test",
  ]);
  assert.deepEqual(guarded.value.status === "partial" && guarded.value.value.steps.flatMap((step) => (step.external ?? []).flatMap((group) => group.names.map((name) => `${group.kind} ${name}`))).sort(), ["global Map", "global Map", "global param.push"]);
  assert.deepEqual(scripted.value.status === "partial" && scripted.value.cuts.map((cut) => cut.at[0]), ["src/script.ts:3 shared.push", "src/script.ts:6 dynamic.push"]);
});

test("a trace over a real index keeps a member call to a namespace's function a cut, never a false external", async () => {
  writeFileSync(join(repo, "src", "space.ts"), [
    "export namespace N { export function nsMethod() {} }",
    "export function runNamespace(x: any) { x.nsMethod(); }",
    "export function entry() { runNamespace(N); }",
    "",
  ].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "namespace");
  const { trace } = composeQueries({ scratchRoot });

  const answer = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/space.ts", symbol: "entry" }] });

  assert.ok(answer.ok);
  assert.equal(answer.value.status, "partial");
  assert.deepEqual(answer.value.status === "partial" && answer.value.cuts.map((cut) => [cut.kind, cut.at[0]]), [["unresolved-link", "src/space.ts:2 x.nsMethod"]]);
});

test("a requested range over a top-level statement after a template literal that opens a comment selects every top-level declaration, never nothing", async () => {
  writeFileSync(join(repo, "src", "marker.ts"), ["const marker = \"`\";", "const template = `", "/*", "`;", "register();", "export function f() {}", ""].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "marker");
  const { impact, trace } = composeQueries({ scratchRoot });

  const callers = await impact.callers({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/marker.ts", start: 5, end: 5 }] });
  const traced = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/marker.ts", start: 5, end: 5 }] });

  assert.ok(callers.ok && traced.ok);
  assert.deepEqual(callers.value.status !== "unknown" && callers.value.value.seeds.map((seed) => [seed.symbol, seed.basis]), [["marker", "top-level"], ["template", "top-level"], ["f", "top-level"]]);
  assert.deepEqual(traced.value.status !== "unknown" && traced.value.value.steps.map((step) => step.symbol), ["marker", "template", "f"]);
});

test("a trace over a real index keeps a member call to a wrapped callable constant or variable a cut, never a false external", async () => {
  writeFileSync(join(repo, "src", "wrapped.ts"), [
    "type Handler = () => void;",
    "export namespace N {",
    "  export const wrapped = (() => {});",
    "  export let wrappedVar = (function() {});",
    "  export const asserted = (() => {}) as Handler;",
    "  export const checked = (() => {}) satisfies Handler;",
    "}",
    "export function invoke(x: typeof N) {",
    "  x.wrapped();",
    "  x.wrappedVar();",
    "  x.asserted();",
    "  x.checked();",
    "}",
    "export function entry() { invoke(N); }",
    "",
  ].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "wrapped");
  const { trace } = composeQueries({ scratchRoot });

  const answer = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/wrapped.ts", symbol: "entry" }] });

  assert.ok(answer.ok);
  assert.equal(answer.value.status, "partial");
  assert.deepEqual(answer.value.status === "partial" && answer.value.cuts.map((cut) => cut.at[0]), ["src/wrapped.ts:10 x.wrappedVar", "src/wrapped.ts:11 x.asserted", "src/wrapped.ts:12 x.checked", "src/wrapped.ts:9 x.wrapped"]);
});

test("a trace over a real index never folds an interface method: it stays a step with a cut listing every declaration of its name below it, an interface re-declaration included", async () => {
  const files: Record<string, string[]> = {
    "Repo.java": ["public interface Repo {", "  void save(String s);", "}"],
    "RepoImpl.java": ["public class RepoImpl implements Repo {", "  public void save(String s) {}", "  public void flush() {}", "}"],
    "AuditRepo.java": ["public class AuditRepo implements Repo {", "  public void save(String s) {}", "}"],
    "Port.java": ["public interface Port {", "  void send(String s);", "}"],
    "LoudPort.java": ["public interface LoudPort extends Port {", "  void send(String s);", "}"],
    "Service.java": [
      "public class Service {",
      "  private final Repo repo;",
      "  private final Port port;",
      "  public Service(Repo repo, Port port) { this.repo = repo; this.port = port; }",
      "  public void create(String s) {",
      "    repo.save(s);",
      "    port.send(s);",
      "  }",
      "}",
    ],
  };
  for (const [name, lines] of Object.entries(files)) writeFileSync(join(repo, "src", name), [...lines, ""].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "ports");
  const { trace } = composeQueries({ scratchRoot });

  const answer = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/Service.java", symbol: "Service.create" }] });

  assert.ok(answer.ok);
  assert.equal(answer.value.status, "partial");
  const { value, cuts } = answer.value.status === "partial" ? answer.value : assert.fail("a body-less callee leaves the trace partial");
  assert.deepEqual(value.steps.map(({ symbol, file, parent, leaves }) => ({ symbol, file, parent, leaves })), [
    { symbol: "create", file: "src/Service.java", parent: undefined, leaves: undefined },
    { symbol: "save", file: "src/Repo.java", parent: 0, leaves: undefined },
    { symbol: "send", file: "src/Port.java", parent: 0, leaves: undefined },
  ]);
  assert.deepEqual(cuts.map((cut) => [cut.kind, ...cut.at]), [
    ["unresolved-link", "src/Port.java:2 send", "src/LoudPort.java::LoudPort.send"],
    ["unresolved-link", "src/Repo.java:2 save", "src/AuditRepo.java::AuditRepo.save", "src/RepoImpl.java::RepoImpl.save"],
  ]);
});

const PAGE = [
  "export function save(value: string): void {}",
  "export function form<T>(model: T, options: { action: () => void }): T {",
  "  return model;",
  "}",
  "export class Page {",
  "  readonly label = \"page\";",
  "  readonly stamp = Date.now();",
  "  readonly submitForm = form(this.label, {",
  "    action: () => {",
  "      save(\"x\");",
  "    },",
  "  });",
  "  open(): void {",
  "    save(this.label);",
  "  }",
  "}",
  "",
].join("\n");

function commitPage(): void {
  writeFileSync(join(repo, "src", "page.ts"), PAGE);
  git("add", "-A");
  git("commit", "-q", "-m", "page");
}

test("a trace over a real index roots at a property whose initializer makes calls, by symbol or by a range inside it, never at one that makes none", async () => {
  commitPage();
  const { trace } = composeQueries({ scratchRoot });
  const walk = (target: { file: string; symbol: string } | { file: string; start: number; end: number }) => trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [target] });

  const [submit, stamp, range, label] = await Promise.all([
    walk({ file: "src/page.ts", symbol: "Page.submitForm" }),
    walk({ file: "src/page.ts", symbol: "Page.stamp" }),
    walk({ file: "src/page.ts", start: 9, end: 11 }),
    walk({ file: "src/page.ts", symbol: "Page.label" }),
  ]);

  assert.ok(submit.ok && submit.value.status === "complete");
  assert.deepEqual(submit.value.value.steps.map(({ symbol, kind, leaves }) => ({ symbol, kind, leaves: leaves?.map((leaf) => leaf.symbol) })), [{ symbol: "submitForm", kind: "property", leaves: ["form", "save"] }]);
  assert.ok(stamp.ok && stamp.value.status === "complete");
  assert.deepEqual(stamp.value.value.steps.map(({ symbol, external }) => ({ symbol, external })), [{ symbol: "stamp", external: [{ kind: "global", names: ["Date.now"] }] }]);
  assert.ok(range.ok && range.value.status === "complete");
  assert.deepEqual(range.value.value.steps.map(({ symbol }) => symbol), ["submitForm"]);
  assert.ok(!label.ok && label.fault.kind === "unknown-symbol");
});

test("a trace over a real index expands a class root into its members that have a body or an initializer that makes calls, in source order", async () => {
  commitPage();
  const { trace } = composeQueries({ scratchRoot });

  const answer = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/page.ts", symbol: "Page" }] });

  assert.ok(answer.ok && answer.value.status === "complete");
  assert.deepEqual(answer.value.value.steps.map(({ symbol, parent, via, at, leaves }) => ({ symbol, parent, via, at, leaves: leaves?.map((leaf) => leaf.symbol) })), [
    { symbol: "Page", parent: undefined, via: undefined, at: undefined, leaves: undefined },
    { symbol: "stamp", parent: 0, via: "member", at: undefined, leaves: undefined },
    { symbol: "submitForm", parent: 0, via: "member", at: undefined, leaves: ["form", "save"] },
    { symbol: "open", parent: 0, via: "member", at: undefined, leaves: ["save"] },
  ]);
});

test("a trace over a real index never expands the initializer of a property a call reaches: the call runs its value, a cut at the property; an arrow-valued property still expands", async () => {
  writeFileSync(join(repo, "src", "owner.ts"), [
    "export function emptyOwnerForm(): () => string { return () => \"x\"; }",
    "export function render(): void {}",
    "export class OwnerPage {",
    "  readonly owner = emptyOwnerForm();",
    "  readonly refresh = () => { render(); };",
    "  ownerForm(): void {",
    "    this.owner();",
    "    this.refresh();",
    "  }",
    "}",
    "",
  ].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "owner");
  const { trace } = composeQueries({ scratchRoot });

  const [call, root] = await Promise.all([
    trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/owner.ts", symbol: "OwnerPage.ownerForm" }] }),
    trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/owner.ts", symbol: "OwnerPage.owner" }] }),
  ]);

  assert.ok(call.ok && call.value.status === "partial");
  assert.deepEqual(call.value.value.steps.map(({ symbol, kind, parent, leaves }) => ({ symbol, kind, parent, leaves: leaves?.map((leaf) => leaf.symbol) })), [
    { symbol: "ownerForm", kind: "method", parent: undefined, leaves: undefined },
    { symbol: "owner", kind: "property", parent: 0, leaves: undefined },
    { symbol: "refresh", kind: "method", parent: 0, leaves: ["render"] },
  ]);
  assert.deepEqual(call.value.cuts.map((cut) => [cut.kind, ...cut.at]), [["unresolved-link", "src/owner.ts:4 owner"]]);
  assert.ok(root.ok && root.value.status === "complete");
  assert.deepEqual(root.value.value.steps.map(({ symbol, leaves }) => ({ symbol, leaves: leaves?.map((leaf) => leaf.symbol) })), [{ symbol: "owner", leaves: ["emptyOwnerForm"] }]);
});

test("a trace over a real index expands a class root into its members even when an earlier root reached the class below it, and a later call still sees the first expansion", async () => {
  writeFileSync(join(repo, "src", "make.ts"), ["export function make() { return new Page(); }", "export class Page { work() { unknown(); } }", "export function again() { return new Page(); }", ""].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "make");
  const { trace } = composeQueries({ scratchRoot });

  const answer = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/make.ts", symbol: "make" }, { file: "src/make.ts", symbol: "Page" }, { file: "src/make.ts", symbol: "again" }] });

  assert.ok(answer.ok && answer.value.status === "partial");
  assert.deepEqual(answer.value.value.steps.map(({ symbol, parent, via, seen, leaves }) => ({ symbol, parent, via, seen, leaves: leaves?.map((leaf) => leaf.symbol) })), [
    { symbol: "make", parent: undefined, via: undefined, seen: undefined, leaves: ["Page"] },
    { symbol: "Page", parent: undefined, via: undefined, seen: undefined, leaves: undefined },
    { symbol: "work", parent: 1, via: "member", seen: undefined, leaves: undefined },
    { symbol: "again", parent: undefined, via: undefined, seen: undefined, leaves: ["Page"] },
  ]);
  assert.deepEqual(answer.value.cuts.map((cut) => cut.at[0]), ["src/make.ts:2 unknown"]);
});

test("a trace over a real index reads dispatch from syntax: a body expands, static or unoverridden ones settle, a body-less method expands the one body its declared hierarchy proves", async () => {
  const files: Record<string, string[]> = {
    "Defaults.java": ["public interface Defaults {", "  default void run() { helper(); }", "  static void helper() {}", "}"],
    "Base.java": ["public abstract class Base {", "  @Deprecated", "  abstract void area();", "  final void fixed() { area(); }", "}"],
    "Sq.java": ["public class Sq extends Base {", "  void area() {}", "}"],
  };
  for (const [name, lines] of Object.entries(files)) writeFileSync(join(repo, "src", name), [...lines, ""].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "dispatch");
  const { trace } = composeQueries({ scratchRoot });
  const walk = (symbol: string, file: string) => trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file, symbol }] });

  const [helper, run, fixed] = await Promise.all([walk("Defaults.helper", "src/Defaults.java"), walk("Defaults.run", "src/Defaults.java"), walk("Base.fixed", "src/Base.java")]);

  assert.ok(helper.ok && helper.value.status === "complete");
  assert.ok(run.ok && run.value.status === "complete");
  assert.deepEqual(run.value.value.steps.map(({ symbol, leaves }) => ({ symbol, leaves: leaves?.map((leaf) => leaf.symbol) })), [{ symbol: "run", leaves: ["helper"] }]);
  assert.ok(fixed.ok && fixed.value.status === "complete");
  assert.deepEqual(fixed.value.value.steps.map(({ symbol, parent, leaves, alternatives }) => ({ symbol, parent, leaves: leaves?.map((leaf) => `${leaf.file}:${leaf.start}`), alternatives })), [
    { symbol: "fixed", parent: undefined, leaves: undefined, alternatives: undefined },
    { symbol: "area", parent: 0, leaves: ["src/Sq.java:2"], alternatives: [{ symbol: "area", file: "src/Sq.java", start: 2, end: 2 }] },
  ]);
});

test("a trace over a real index expands an overridable method with a body and cuts it at the overriders below its owner", async () => {
  const files: Record<string, string[]> = {
    "Greeter.java": ["public interface Greeter {", "  default void greet() { hello(); }", "  static void hello() {}", "}"],
    "Loud.java": ["public class Loud implements Greeter {", "  public void greet() {}", "  public static void hello() {}", "}"],
  };
  for (const [name, lines] of Object.entries(files)) writeFileSync(join(repo, "src", name), [...lines, ""].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "greeter");
  const { trace } = composeQueries({ scratchRoot });

  const answer = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/Greeter.java", symbol: "Greeter.greet" }] });

  assert.ok(answer.ok && answer.value.status === "partial");
  assert.deepEqual(answer.value.value.steps.map(({ symbol, leaves }) => ({ symbol, leaves: leaves?.map((leaf) => leaf.symbol) })), [{ symbol: "greet", leaves: ["hello"] }]);
  assert.deepEqual(answer.value.cuts.map((cut) => [cut.kind, ...cut.at]), [["unresolved-link", "src/Greeter.java:2 greet", "src/Loud.java::Loud.greet"]]);
});

test("a trace over a real index matches a decorated method to its syntax from the decorator to its name", async () => {
  writeFileSync(join(repo, "src", "deco.ts"), [
    "function dec(): MethodDecorator { return () => {}; }",
    "export class Base {",
    "  @dec()",
    "  run(): void {}",
    "}",
    "export class Child extends Base {",
    "  run(): void {}",
    "}",
    "",
  ].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "deco");
  const { trace } = composeQueries({ scratchRoot });

  const answer = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/deco.ts", symbol: "Base.run" }] });

  assert.ok(answer.ok && answer.value.status === "partial");
  assert.deepEqual(answer.value.cuts.map((cut) => [cut.kind, ...cut.at]), [["unresolved-link", "src/deco.ts:4 run", "src/deco.ts::Child.run"]]);
});

test("a trace over a real index lists an implementation below a parameterized supertype the index left unresolved when a lambda may implement the functional owner", async () => {
  writeFileSync(join(repo, "src", "Generic.java"), [
    "interface GPort<T> { void send(T x); }",
    "interface GSub extends GPort<String> { void send(String x); }",
    "class GImpl implements GSub { public void send(String x) {} }",
    "class GUse { void go(GPort<String> p) { p.send(\"x\"); } }",
    "class GLambda { Runnable task = () -> {}; }",
    "",
  ].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "generic");
  const { trace } = composeQueries({ scratchRoot });

  const answer = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/Generic.java", symbol: "GUse.go" }] });

  assert.ok(answer.ok && answer.value.status === "partial");
  assert.deepEqual(answer.value.cuts.map((cut) => [cut.kind, ...cut.at]), [["unresolved-link", "src/Generic.java:1 send", "src/Generic.java::GImpl.send", "src/Generic.java::GSub.send"]]);
});

test("a trace over a real index keeps a member call a cut when a module exports a value under that name, renamed or re-exported", async () => {
  writeFileSync(join(repo, "src", "other.ts"), ["export function other(): void {}", ""].join("\n"));
  writeFileSync(join(repo, "src", "ns.ts"), [
    "function local(): void {}",
    "export { local as exportedAlias };",
    "export { other as reexportedAlias } from \"./other\";",
    "export type { Shape as typeOnlyAlias } from \"./shape\";",
    "",
  ].join("\n"));
  writeFileSync(join(repo, "src", "shape.ts"), ["export interface Shape { area(): number }", ""].join("\n"));
  writeFileSync(join(repo, "src", "run.ts"), [
    "import * as ns from \"./ns\";",
    "export function run(x: typeof ns, y: { typeOnlyAlias(): void }): void {",
    "  x.exportedAlias();",
    "  x.reexportedAlias();",
    "  y.typeOnlyAlias();",
    "}",
    "",
  ].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "aliases");
  const { trace } = composeQueries({ scratchRoot });

  const answer = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/run.ts", symbol: "run" }] });

  assert.ok(answer.ok && answer.value.status === "partial");
  assert.deepEqual(answer.value.cuts.map((cut) => [cut.kind, ...cut.at]), [
    ["unresolved-link", "src/run.ts:3 x.exportedAlias", "src/ns.ts::exportedAlias"],
    ["unresolved-link", "src/run.ts:4 x.reexportedAlias", "src/ns.ts::reexportedAlias"],
  ]);
  assert.deepEqual(answer.value.value.steps[0]?.external, [{ kind: "unnamed", names: ["y.typeOnlyAlias"] }]);
});

test("a trace over a real index keeps a library member call a cut when its receiver names a function value the code declares", async () => {
  writeFileSync(join(repo, "src", "Values.java"), [
    "import java.util.function.Supplier;",
    "public class Values {",
    "  private final Supplier<Integer> supply = () -> helper();",
    "  private final Runnable task = this::work;",
    "  static int helper() { return 1; }",
    "  void work() {}",
    "  int go() {",
    "    task.run();",
    "    return this.supply.get();",
    "  }",
    "}",
  ].join("\n"));
  writeFileSync(join(repo, "src", "values.ts"), [
    "export function helper(): void {}",
    "const fn = () => helper();",
    "let handler: () => void;",
    "handler = function () { helper(); };",
    "export function go(): void {",
    "  fn.call(undefined);",
    "  handler.apply(undefined, []);",
    "}",
    "",
  ].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "values");
  const { trace } = composeQueries({ scratchRoot });
  const walk = (file: string, symbol: string) => trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file, symbol }] });

  const [java, typescript] = await Promise.all([walk("src/Values.java", "Values.go"), walk("src/values.ts", "go")]);

  assert.ok(java.ok && java.value.status === "partial");
  assert.deepEqual(java.value.cuts.map((cut) => [cut.kind, ...cut.at]), [
    ["unresolved-link", "src/Values.java:8 task.run", "src/Values.java::task"],
    ["unresolved-link", "src/Values.java:9 supply.get", "src/Values.java::supply"],
  ]);
  assert.ok(typescript.ok && typescript.value.status === "partial");
  assert.deepEqual(typescript.value.cuts.map((cut) => [cut.kind, ...cut.at]), [
    ["unresolved-link", "src/values.ts:6 fn.call", "src/values.ts::fn"],
    ["unresolved-link", "src/values.ts:7 handler.apply", "src/values.ts::handler"],
  ]);
});

test("a trace over a real index binds a var receiver at its function scope, wherever in the function's blocks it is declared", async () => {
  writeFileSync(join(repo, "src", "hoisted.ts"), ["export function entry(): void {", "  if (Date.now() > 0) { var cb = () => console.log(\"x\"); }", "  cb.call(null);", "}", ""].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "hoisted");
  const { trace } = composeQueries({ scratchRoot });

  const answer = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/hoisted.ts", symbol: "entry" }] });

  assert.ok(answer.ok && answer.value.status === "partial", JSON.stringify(answer));
  assert.deepEqual(answer.value.cuts.map((cut) => [cut.kind, ...cut.at]), [["unresolved-link", "src/hoisted.ts:3 cb.call", "src/hoisted.ts::cb"]]);
});

test("a trace over a real index sees a function value through every wrapper expression and either branch of a choice", async () => {
  writeFileSync(join(repo, "src", "Wrapped.java"), [
    "import java.util.function.Supplier;",
    "public class Wrapped {",
    "  String go(boolean flag, Supplier<String> other) {",
    "    Supplier<String> paren = (() -> \"x\");",
    "    Supplier<String> cast = (Supplier<String>) () -> \"x\";",
    "    Supplier<String> chosen = flag ? other : () -> \"x\";",
    "    return paren.get() + cast.get() + chosen.get();",
    "  }",
    "}",
  ].join("\n"));
  writeFileSync(join(repo, "src", "wrapped-values.ts"), [
    "export function go(flag: boolean, other: unknown): void {",
    "  const chosen = flag ? other : () => 1;",
    "  const fallback = other ?? (() => 1);",
    "  const either = other || (() => 1);",
    "  chosen.call(null);",
    "  fallback.call(null);",
    "  either.call(null);",
    "}",
    "",
  ].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "wrapped values");
  const { trace } = composeQueries({ scratchRoot });
  const walk = (file: string, symbol: string) => trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file, symbol }] });

  const [java, typescript] = await Promise.all([walk("src/Wrapped.java", "Wrapped.go"), walk("src/wrapped-values.ts", "go")]);

  assert.ok(java.ok && java.value.status === "partial", JSON.stringify(java));
  assert.deepEqual(java.value.cuts.map((cut) => cut.at[0]), ["src/Wrapped.java:7 cast.get", "src/Wrapped.java:7 chosen.get", "src/Wrapped.java:7 paren.get"]);
  assert.ok(typescript.ok && typescript.value.status === "partial", JSON.stringify(typescript));
  assert.deepEqual(typescript.value.cuts.map((cut) => cut.at[0]), ["src/wrapped-values.ts:5 chosen.call", "src/wrapped-values.ts:6 fallback.call", "src/wrapped-values.ts:7 either.call"]);
});

test("a trace over a real index binds a receiver through every declaration of its name and through wrappers around it", async () => {
  writeFileSync(join(repo, "src", "receivers.ts"), [
    "export function redeclared(): void {",
    "  var f;",
    "  { var f = () => 1; }",
    "  f.call(null);",
    "}",
    "export function wrapped(): void {",
    "  const g = () => 1;",
    "  (g).call(null);",
    "  (g as () => number).apply(null);",
    "  g!.bind(null);",
    "}",
    "",
  ].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "receivers");
  const { trace } = composeQueries({ scratchRoot });
  const walk = (symbol: string) => trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/receivers.ts", symbol }] });

  const [redeclared, wrapped] = await Promise.all([walk("redeclared"), walk("wrapped")]);

  for (const answer of [redeclared, wrapped]) assert.ok(answer.ok && answer.value.status === "partial", JSON.stringify(answer));
  assert.deepEqual([redeclared, wrapped].flatMap((answer) => (answer.ok && answer.value.status === "partial" ? answer.value.cuts.map((cut) => cut.at[0]) : [])), [
    "src/receivers.ts:4 f.call",
    "src/receivers.ts:10 g.bind",
    "src/receivers.ts:8 g.call",
    "src/receivers.ts:9 g.apply",
  ]);
});

test("a trace over a real index binds a receiver in its own file, so a function value of that name in another file leaves an unrelated call as R6 decides", async () => {
  writeFileSync(join(repo, "src", "holder.ts"), ["export const value = () => 1;", ""].join("\n"));
  writeFileSync(join(repo, "src", "use.ts"), ["export function use(value: { describe(): void }): void {", "  value.describe();", "}", ""].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "binding");
  const { trace } = composeQueries({ scratchRoot });

  const answer = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/use.ts", symbol: "use" }] });

  assert.ok(answer.ok && answer.value.status === "complete");
  assert.deepEqual(answer.value.value.steps[0]?.external, [{ kind: "unnamed", names: ["value.describe"] }]);
});

test("a trace over a real index never follows an edge whose name a package binds to a repository homonym: the call leaves under the package, and a repository import still expands", async () => {
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", dependencies: { pkg: "1.0.0" } }));
  writeFileSync(join(repo, "src", "model.ts"), ["export class Base {}", "export function evaluate(value: number): number {", "  return value;", "}", ""].join("\n"));
  writeFileSync(join(repo, "src", "uses-package.ts"), [
    "import * as pkg from \"pkg\";",
    "import { evaluate } from \"pkg\";",
    "export function make(): unknown {",
    "  return new pkg.Base();",
    "}",
    "export function pass(): unknown {",
    "  return [1].map(evaluate);",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(repo, "src", "uses-repo.ts"), ["import { Base, evaluate } from \"./model\";", "export function real(): unknown {", "  return [new Base(), evaluate(1)];", "}", ""].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "homonyms");
  const { trace } = composeQueries({ scratchRoot });
  const walk = (symbol: string, file: string) => trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file, symbol }] });

  const [make, pass, real] = await Promise.all([walk("make", "src/uses-package.ts"), walk("pass", "src/uses-package.ts"), walk("real", "src/uses-repo.ts")]);

  const shape = (answer: typeof make) => {
    assert.ok(answer.ok && answer.value.status === "complete", JSON.stringify(answer));
    return answer.value.value.steps.map(({ symbol, leaves, external }) => ({ symbol, leaves: leaves?.map((leaf) => leaf.file), external }));
  };
  assert.deepEqual(shape(make), [{ symbol: "make", leaves: undefined, external: [{ kind: "import", module: "pkg", names: ["Base"] }] }]);
  assert.deepEqual(shape(pass), [{ symbol: "pass", leaves: undefined, external: [{ kind: "import", module: "pkg", names: ["evaluate"] }] }]);
  assert.deepEqual(shape(real), [{ symbol: "real", leaves: ["src/model.ts", "src/model.ts"], external: undefined }]);
});

test("a trace over a real index counts every same-named declaration below an overridable method's owner, interfaces included, as a replacement", async () => {
  const files: Record<string, string[]> = {
    "Parent.java": ["public interface Parent {", "  default void greet() {}", "}"],
    "Child.java": ["public interface Child extends Parent {", "  default void greet() { System.exit(1); }", "}"],
    "Use.java": ["public class Use implements Child {", "  void entry(Parent p) { p.greet(); }", "}"],
  };
  for (const [name, lines] of Object.entries(files)) writeFileSync(join(repo, "src", name), [...lines, ""].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "descendants");
  const { trace } = composeQueries({ scratchRoot });
  const walk = (file: string, symbol: string) => trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file, symbol }] });

  const [entry, greet] = await Promise.all([walk("src/Use.java", "Use.entry"), walk("src/Parent.java", "Parent.greet")]);

  assert.ok(entry.ok && entry.value.status === "partial");
  assert.deepEqual(entry.value.value.steps.map(({ symbol, leaves }) => ({ symbol, leaves })), [{ symbol: "entry", leaves: undefined }, { symbol: "greet", leaves: undefined }]);
  assert.deepEqual(entry.value.cuts.map((cut) => [cut.kind, ...cut.at]), [["unresolved-link", "src/Parent.java:2 greet", "src/Child.java::Child.greet"]]);
  assert.ok(greet.ok && greet.value.status === "partial");
});

test("a trace over a real index cuts a call its function's own parameter binds, never following it into a repository homonym", async () => {
  writeFileSync(join(repo, "src", "redact.ts"), ["export function redact(text: string): string {", "  return text;", "}", ""].join("\n"));
  writeFileSync(join(repo, "src", "clean.ts"), ["export function clean(text: string, redact: (value: string) => string): string {", "  return redact(text);", "}", ""].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "parameter");
  const { trace } = composeQueries({ scratchRoot });

  const answer = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/clean.ts", symbol: "clean" }] });

  assert.ok(answer.ok && answer.value.status === "partial", JSON.stringify(answer));
  assert.deepEqual(answer.value.value.steps.map(({ symbol, leaves, external }) => ({ symbol, leaves, external })), [{ symbol: "clean", leaves: undefined, external: undefined }]);
  assert.deepEqual(answer.value.cuts.map((cut) => [cut.kind, ...cut.at]), [["unresolved-link", "src/clean.ts:2 redact", "src/redact.ts::redact"]]);
});

test("a trace over a real index reaches the declaration an import proves a name binds, not the homonym the index matched", async () => {
  writeFileSync(join(repo, "src", "parts.ts"), ["export const cutOwner = 1;", ""].join("\n"));
  writeFileSync(join(repo, "src", "other.ts"), ["function cutOwner(): number {", "  return 2;", "}", "export const x = cutOwner();", ""].join("\n"));
  writeFileSync(join(repo, "src", "schema.ts"), ["import { cutOwner } from \"./parts.ts\";", "", "export function shape(): unknown {", "  return [cutOwner];", "}", ""].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "redirect");
  const { trace } = composeQueries({ scratchRoot });

  const answer = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/schema.ts", symbol: "shape" }] });

  assert.ok(answer.ok && answer.value.status === "complete", JSON.stringify(answer));
  assert.deepEqual(answer.value.value.steps.map(({ symbol, leaves }) => ({ symbol, leaves })), [{ symbol: "shape", leaves: [{ symbol: "cutOwner", file: "src/parts.ts", start: 1, end: 1, deferred: true }] }]);
});

test("a trace over a real index keeps the call site as the place of a redirected step that expands", async () => {
  writeFileSync(join(repo, "src", "parts.ts"), ["export function compute(): number {", "  return Date.now();", "}", "export const cutOwner = compute();", ""].join("\n"));
  writeFileSync(join(repo, "src", "other.ts"), ["function cutOwner(): number {", "  return 2;", "}", "export const x = cutOwner();", ""].join("\n"));
  writeFileSync(join(repo, "src", "schema.ts"), ["import { cutOwner } from \"./parts.ts\";", "", "export function shape(): unknown {", "  const first = 1;", "  return [first, cutOwner];", "}", ""].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "redirect at");
  const { trace } = composeQueries({ scratchRoot });

  const answer = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/schema.ts", symbol: "shape" }] });

  assert.ok(answer.ok && answer.value.status === "complete", JSON.stringify(answer));
  assert.deepEqual(answer.value.value.steps.slice(1).map(({ file, symbol, at, via, deferred }) => ({ file, symbol, at, via, deferred })), [
    { file: "src/parts.ts", symbol: "cutOwner", at: { line: 5, column: 18 }, via: "reference", deferred: true },
    { file: "src/parts.ts", symbol: "compute", at: { line: 4, column: 25 }, via: "call", deferred: undefined },
  ]);
});

const PARAMETER_FILES: Record<string, string[]> = {
  "callback.ts": ["export function callback(): number {", "  return 1;", "}", ""],
  "runners.ts": [
    "export function defaultRun(callback: () => number, other = 0): number {",
    "  return callback() + other;",
    "}",
    "export function capture(callback: () => number): () => number {",
    "  return () => callback();",
    "}",
    "export function nested(callback: () => number): unknown {",
    "  return [1].map(() => () => callback());",
    "}",
    "",
  ],
};

function writeParameterFiles(): void {
  for (const [name, lines] of Object.entries(PARAMETER_FILES)) writeFileSync(join(repo, "src", name), lines.join("\n"));
}

test("a trace over a real index cuts a call through a parameter of a function around it, beside a defaulted parameter or from a closure", async () => {
  writeParameterFiles();
  git("add", "-A");
  git("commit", "-q", "-m", "parameters");
  const { trace } = composeQueries({ scratchRoot });
  const walk = (symbol: string) => trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/runners.ts", symbol }] });

  const answers = await Promise.all(["defaultRun", "capture", "nested"].map(walk));

  for (const [index, line] of [2, 5, 8].entries()) {
    const answer = answers[index]!;
    assert.ok(answer.ok && answer.value.status === "partial", JSON.stringify(answer));
    assert.deepEqual(answer.value.value.steps.flatMap(({ leaves }) => leaves ?? []), []);
    assert.deepEqual(answer.value.cuts.map((cut) => [cut.kind, ...cut.at]), [["unresolved-link", `src/runners.ts:${line} callback`, "src/callback.ts::callback"]]);
  }
});

test("callers and impact over a real index never count a call through a parameter of a function around it as a use of a repository homonym", async () => {
  writeParameterFiles();
  git("add", "-A");
  git("commit", "-q", "-m", "parameters");
  writeFileSync(join(repo, "src", "callback.ts"), ["export function callback(): number {", "  return 2;", "}", ""].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "change callback");
  const { impact } = composeQueries({ scratchRoot });
  const symbols = (answer: Awaited<ReturnType<typeof impact.callers>>) => {
    assert.ok(answer.ok && answer.value.status !== "unknown", JSON.stringify(answer));
    return answer.value.value.symbols.map(({ symbol }) => symbol);
  };

  const [callers, change] = await Promise.all([
    impact.callers({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/callback.ts", symbol: "callback" }] }),
    impact.ofChange({ repo, repoId: "shop-service", base: "HEAD~1", head: "HEAD" }),
  ]);

  assert.deepEqual(symbols(callers), ["callback"]);
  assert.deepEqual(symbols(change), ["callback"]);
});

test("callers over a range inside a property initializer still seeds the class that holds it", async () => {
  commitPage();
  const { impact } = composeQueries({ scratchRoot });

  const answer = await impact.callers({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/page.ts", start: 9, end: 11 }] });

  assert.ok(answer.ok && answer.value.status !== "unknown");
  assert.deepEqual(answer.value.value.seeds.map(({ symbol, basis }) => ({ symbol, basis })), [{ symbol: "Page", basis: "lines" }]);
});

test("a trace over a real index names each candidate by its file and dotted containment path, a top-level one by its name", async () => {
  writeFileSync(join(repo, "src", "Outer.java"), ["public class Outer {", "  static class Inner {", "    int pick() { return 1; }", "  }", "}", ""].join("\n"));
  writeFileSync(join(repo, "src", "store.ts"), ["export class Store {", "  pick(): number {", "    return 2;", "  }", "}", ""].join("\n"));
  writeFileSync(join(repo, "src", "util.ts"), ["export function pick(): number {", "  return 3;", "}", "export function run(x: any): number {", "  return x.get().pick();", "}", ""].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "picks");
  const { trace } = composeQueries({ scratchRoot });

  const answer = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/util.ts", symbol: "run" }] });

  assert.ok(answer.ok && answer.value.status === "partial");
  assert.deepEqual(answer.value.cuts.map((cut) => cut.at), [["src/util.ts:5 x.get().pick", "src/Outer.java::Outer.Inner.pick", "src/store.ts::Store.pick", "src/util.ts::pick"]]);
});

test("a trace over a real index keeps a member call a cut when the code declares its name in a value position the index holds no node for, and external when only types or nothing declare it", async () => {
  const lines = [
    "export function repoFn(): void {}",
    "function make<T>(value: T): T {",
    "  return value;",
    "}",
    "export const store = make({ setErrors(errors: string): void { repoFn(); } });",
    "export const outer = { inner: { nestedMethod(): void {} } };",
    "export function factory() {",
    "  return { returnedMethod(): void {} };",
    "}",
    "export class Holder {",
    "  table = { fieldMethod(): void {} };",
    "}",
    "export const alias = { aliasKey: repoFn };",
    "export const target: Record<string, () => void> = {};",
    "target.assigned = repoFn;",
    "export type Deep = { outer: { deepOnly(): void } };",
    "export function take(options: { paramOnly(): void }): void {}",
    "export function run(s: any, items: number[]): void {",
    "  s.setErrors(\"x\");",
    "  s.nestedMethod();",
    "  s.returnedMethod();",
    "  s.fieldMethod();",
    "  s.aliasKey();",
    "  s.assigned();",
    "  s.deepOnly();",
    "  s.paramOnly();",
    "  items.map(String);",
    "}",
    "",
  ];
  writeFileSync(join(repo, "src", "members.ts"), lines.join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "members");
  const { trace } = composeQueries({ scratchRoot });
  const lineOf = (text: string): number => lines.indexOf(text) + 1;

  const answer = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/members.ts", symbol: "run" }] });

  assert.ok(answer.ok && answer.value.status === "partial");
  assert.deepEqual(answer.value.value.steps[0]?.external, [{ kind: "global", names: ["items.map"] }, { kind: "unnamed", names: ["s.deepOnly", "s.paramOnly"] }]);
  const cut = (call: string, name: string): string[] => [`src/members.ts:${lineOf(`  ${call}(${call === "s.setErrors" ? "\"x\"" : ""});`)} ${call}`, `src/members.ts::${name}`];
  assert.deepEqual(answer.value.cuts.map((entry) => entry.at), [
    cut("s.aliasKey", "aliasKey"), cut("s.assigned", "assigned"), cut("s.fieldMethod", "fieldMethod"),
    cut("s.nestedMethod", "nestedMethod"), cut("s.returnedMethod", "returnedMethod"), cut("s.setErrors", "setErrors"),
  ].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)));
});

test("a trace over a real index keeps a call to a Java record accessor a cut, and a call to an anonymous class method never external", async () => {
  writeFileSync(join(repo, "src", "Point.java"), ["public record Point(int coordinate) {}", ""].join("\n"));
  writeFileSync(join(repo, "src", "Shapes.java"), [
    "public class Shapes {",
    "  Runnable task = new Runnable() {",
    "    public void run() {}",
    "    public void anonymousOnly() {}",
    "  };",
    "  void use(Point p, Shapes t) {",
    "    p.coordinate();",
    "    t.task.anonymousOnly();",
    "  }",
    "}",
    "",
  ].join("\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "shapes");
  const { trace } = composeQueries({ scratchRoot });

  const answer = await trace.walk({ repo, repoId: "shop-service", revision: "HEAD", targets: [{ file: "src/Shapes.java", symbol: "Shapes.use" }] });

  assert.ok(answer.ok && answer.value.status === "partial");
  assert.equal(answer.value.value.steps[0]?.external, undefined);
  assert.deepEqual(answer.value.cuts.map((entry) => entry.at), [["src/Shapes.java:7 p.coordinate", "src/Point.java::coordinate"]]);
});
