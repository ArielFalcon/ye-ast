import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EXIT_CODE } from "../cli/main.ts";
import { REDACTED } from "../core/ports/redaction.port.ts";
import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import { createRemoteRefresh, defaultRemoteRefreshDeps } from "../core/adapters/git/remote-refresh.adapter.ts";
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import { EDGE_POLICY } from "../core/domain/impact/edge-policy.ts";
import type { DecisionValue } from "../core/ports/decision-queries.port.ts";
import type { WorkspaceValue } from "../core/ports/workspace-queries.port.ts";
import { composeCli, composeQueries, mcpCommandFor } from "./compose.ts";
import { installedVersion } from "./installed-versions.ts";
import { createMcpServer } from "../mcp/server.ts";
import { openSession } from "../mcp/test-session.ts";

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
  assert.deepEqual(unserved.evidence, [{ path: "src/app/order.page.ts", line: 7, endLine: 7 }]);
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
  assert.equal(value.repositories.find(({ repo: id }) => id === "orders")?.path, join(cacheDirectory, "remotes", digest.of(url)));

  const { version, entrypoints, impact, outline, workspace: workspaceQueries, workspaceImpact, decisions, redaction } = composeQueries({ scratchRoot, trustDirectory, refresh });
  const session = await openSession(createMcpServer({ version, entrypoints, impact, outline, workspace: workspaceQueries, workspaceImpact, decisions, redaction, repository: { path: repo, repoId: "shop-service" } }));
  try {
    const answer = await session.callTool("ye_ast_callers", { targets: [{ file: "src/OrderController.java", symbol: "OrderController.one" }], workspace: {}, full: true });
    const structured = answer.structuredContent as Record<string, unknown>;
    assert.deepEqual(structured["freshness"], redaction.redactValue([{ repo: "orders", url, freshness: { status: "verified" } }]));
    assert.equal((structured["resolution"] as { sha?: string }[])[0]?.sha, remoteSha);
    const { freshness: _freshness, resolution: _resolution, ...fact } = structured;
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
  assert.deepEqual(remote?.options[0]?.evidence, [{ path: ".git/config", line: 1, via: "origin" }]);
  assert.equal(value.decisions.some((decision) => decision.id === "remote:shop-service"), false, "the bound repository declares nothing to confirm");
});


test("reference proof version changes the existing deterministic impact producer digest", async () => {
  const { impact, version } = composeQueries({ scratchRoot });
  const request = { repo, repoId: "shop-service", revision: "HEAD", files: ["README.md"] };
  const first = await impact.importers(request);
  const second = await impact.importers(request);
  assert.ok(first.ok && second.ok);
  const digest = createSha256Digest();
  const { referenceProofVersion, ...baseline } = EDGE_POLICY;
  assert.equal(referenceProofVersion, 1);
  const current = digest.of(JSON.stringify(EDGE_POLICY)).slice(0, 12);
  const before = digest.of(JSON.stringify(baseline)).slice(0, 12);
  assert.notEqual(current, before);
  assert.equal(first.value.producer.version, `${version}+edge-policy.${current}`);
  assert.equal(second.value.producer.version, first.value.producer.version);
});
