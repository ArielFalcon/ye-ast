import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import { createCodeGraph } from "../core/adapters/codegraph/codegraph.adapter.ts";
import { isInMapScope } from "../core/domain/map/entrypoint-map.ts";
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
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

const CONTROLLER = `package shop;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/orders")
class OrderController {
  private final OrderService service;

  OrderController(OrderService service) { this.service = service; }

  @GetMapping("/{id}")
  String one() {
    return service.find();
  }
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

const DIR = "src/main/java/shop/";

let workspace: string;
let repo: string;
let scratchRoot: string;
let trustDirectory: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-live-"));
  repo = join(workspace, "shop-service");
  scratchRoot = join(workspace, "scratch");
  trustDirectory = join(workspace, "config", "ye-ast");
  mkdirSync(repo);
  mkdirSync(scratchRoot);
  git("init", "-q", "-b", "main");
  commit({ [`${DIR}OrderController.java`]: CONTROLLER, [`${DIR}OrderService.java`]: SERVICE, [`${DIR}OrderServiceImpl.java`]: IMPL, [`${DIR}Util.java`]: UTIL("s") }, "base");
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim();
}

function write(files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
}

function commit(files: Readonly<Record<string, string>>, message = "change"): string {
  write(files);
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

interface Answer {
  code: number;
  stdout: string;
  stderr: string;
  fact: { status: string; value: any; cuts?: { kind: string; at: string[] }[]; snapshot: { kind: string; stateId?: string; head?: string }; inputs: { content: string; origin?: { kind: string; base?: string }; declaredScope: { ignored?: string } }; reason?: string };
}

async function ye(command: string, args: string[], tail: string[] = []): Promise<Answer> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot, trustDirectory })([command, ...args, repo, ...tail], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  const text = stdout.join("\n");
  return { code, stdout: text, stderr: stderr.join("\n"), fact: text === "" ? ({} as Answer["fact"]) : JSON.parse(text) };
}

async function trust(mode: "trusted" | "untrusted"): Promise<void> {
  const installed = await composeCli({ scratchRoot, trustDirectory })(["init", "--trust", mode, repo], { out: () => undefined, err: () => undefined });
  assert.equal(installed, EXIT_CODE.ok);
}

const stateFile = (): string => join(repo, ".ye-ast-graph", "live", readdirSync(join(repo, ".ye-ast-graph", "live")).find((name) => name.endsWith(".state.json"))!);

test("live JSON edits reach their importing module and agree with committing the same bytes", async () => {
  commit({ "src/data.json": '{"value":1}\n', "src/use.ts": "import data from './data.json'; export const value = data.value;\n" });
  await trust("trusted");
  const before = await ye("importers", ["--live"], ["src/data.json"]);
  write({ "src/data.json": '{"value":2}\n' });
  const live = await ye("impact", ["--base", "HEAD", "--live", "--changed", "src/data.json"]);
  assert.equal(live.fact.status, "complete", live.stdout);
  assert.deepEqual(live.fact.value.modules?.origins, [{ file: "src/data.json", change: "modified" }]);
  assert.deepEqual(live.fact.value.modules?.modules.filter((module: { file: string }) => module.file === "src/use.ts").map((module: { snapshot: string }) => module.snapshot), ["base", "head"]);
  const after = await ye("importers", ["--live"], ["src/data.json"]);
  assert.notEqual(before.fact.inputs.content, after.fact.inputs.content);
  assert.notEqual(before.fact.snapshot.stateId, after.fact.snapshot.stateId);
  commit({});
  const revision = await ye("impact", ["--base", "HEAD~1", "--changed", "src/data.json"]);
  assert.deepEqual(live.fact.value, revision.fact.value);
});

test("under untrusted, every live query is refused with the command that trusts the repository and nothing is written", async () => {
  for (const [command, tail] of [["map", []], ["impact", ["--base", "HEAD"]], ["callers", [`${DIR}Util.java:fmt`]], ["importers", [`${DIR}Util.java`]]] as const) {
    const args = command === "impact" ? ["--base", "HEAD", "--live"] : ["--live"];
    const answer = await ye(command, args, command === "impact" ? [] : [...tail]);

    assert.equal(answer.code, EXIT_CODE.queryFailed, command);
    assert.equal(answer.stdout, "");
    assert.match(answer.stderr, /live-requires-trusted.*ye-ast init --trust trusted/);
  }
  assert.equal(existsSync(join(repo, ".ye-ast-graph")), false);
});

test("the mirror keeps only what an export writes and still fingerprints the rest", async () => {
  await trust("trusted");
  commit({ "NOTES.md": "# notes\n", [`${DIR}Util.java`]: UTIL("x") });

  const answer = await ye("map", ["--live"]);

  assert.equal(answer.code, EXIT_CODE.ok, answer.stderr);
  const scope = stateFile().slice(0, -".state.json".length);
  assert.equal(existsSync(join(scope, DIR, "Util.java")), true, "a source the export writes is in the mirror");
  assert.equal(existsSync(join(scope, "NOTES.md")), false, "a path no query reads is not copied");
  const state = JSON.parse(readFileSync(stateFile(), "utf8")) as { manifest: { path: string }[] };
  assert.equal(state.manifest.some((entry) => entry.path === "NOTES.md"), true, "the fingerprint still covers it");
});

test("--live with --head is a usage error", async () => {
  assert.equal((await ye("impact", ["--base", "HEAD", "--live", "--head", "HEAD"])).code, EXIT_CODE.usage);
});

test("on a clean tree every live answer carries the sha answer's value and the stateId is the content digest of HEAD", async () => {
  await trust("trusted");

  const liveMap = await ye("map", ["--live"]);
  const shaMap = await ye("map", []);
  const liveImpact = await ye("impact", ["--base", "HEAD", "--live"]);
  const shaImpact = await ye("impact", ["--base", "HEAD"]);
  const liveCallers = await ye("callers", ["--live"], [`${DIR}Util.java:fmt`]);
  const shaCallers = await ye("callers", [], [`${DIR}Util.java:fmt`]);
  const liveImporters = await ye("importers", ["--live"], [`${DIR}OrderService.java`]);
  const shaImporters = await ye("importers", [], [`${DIR}OrderService.java`]);

  for (const [live, sha] of [[liveMap, shaMap], [liveImpact, shaImpact], [liveCallers, shaCallers], [liveImporters, shaImporters]] as const) {
    assert.equal(live.code, EXIT_CODE.ok, live.stderr);
    assert.equal(live.fact.snapshot.kind, "live");
    assert.equal(live.fact.snapshot.stateId, shaMap.fact.inputs.content);
    assert.equal(live.fact.snapshot.head, git("rev-parse", "HEAD"));
    assert.equal(live.fact.inputs.declaredScope.ignored, "git");
    assert.equal(live.fact.status, sha.fact.status);
  }
  const entries = (fact: Answer["fact"]): unknown[] => fact.value.entrypoints.value.map((item: { value: unknown }) => item.value);
  assert.deepEqual(entries(liveMap.fact), entries(shaMap.fact));
  for (const [live, sha] of [[liveImpact, shaImpact], [liveCallers, shaCallers], [liveImporters, shaImporters]] as const) assert.deepEqual(live.fact.value, sha.fact.value);
  assert.equal("index" in liveMap.fact.inputs, false);
  assert.equal("index" in liveImpact.fact.inputs, false);
  assert.deepEqual(liveCallers.fact.inputs.origin, { kind: "full" });
  assert.deepEqual(readdirSync(scratchRoot), []);
});

test("a second live query with no edit leaves the recorded state byte for byte as it was", async () => {
  await trust("trusted");
  await ye("importers", ["--live"], [`${DIR}OrderService.java`]);
  const before = readFileSync(stateFile(), "utf8");

  const again = await ye("importers", ["--live"], [`${DIR}OrderService.java`]);

  assert.equal(again.code, EXIT_CODE.ok, again.stderr);
  assert.equal(readFileSync(stateFile(), "utf8"), before);
});

const SHAPES: readonly (readonly [string, () => void])[] = [
  ["an unstaged edit", () => write({ [`${DIR}Util.java`]: UTIL("s.trim()") })],
  ["a staged edit", () => { write({ [`${DIR}Util.java`]: UTIL("s.strip()") }); git("add", `${DIR}Util.java`); }],
  ["an untracked file", () => write({ [`${DIR}Extra.java`]: "package shop;\n\nclass Extra {\n  static int one() {\n    return 1;\n  }\n}\n" })],
  ["a deleted file", () => rmSync(join(repo, `${DIR}Util.java`))],
  ["an edit staged and then edited again", () => { write({ [`${DIR}OrderServiceImpl.java`]: IMPL.replace('"x"', '"y"') }); git("add", "-A"); write({ [`${DIR}OrderServiceImpl.java`]: IMPL.replace('"x"', '"z"') }); }],
];

test("a staged edit, an unstaged edit, an untracked file and a deleted file each give the value committing them gives, and each refresh is a sync", async () => {
  await trust("trusted");
  const first = await ye("impact", ["--base", "HEAD", "--live"]);
  assert.equal(first.code, EXIT_CODE.ok, first.stderr);
  const fullBuild = first.fact.snapshot.stateId;

  for (const [name, apply] of SHAPES) {
    const base = git("rev-parse", "HEAD");
    apply();

    const live = await ye("impact", ["--base", base, "--live"]);
    commit({}, name);
    const sha = await ye("impact", ["--base", base, "--head", "HEAD"]);

    assert.equal(live.code, EXIT_CODE.ok, `${name}: ${live.stderr}`);
    assert.deepEqual(live.fact.value, sha.fact.value, name);
    assert.deepEqual(live.fact.inputs.origin, { kind: "sync", base: fullBuild }, name);
    assert.equal(live.fact.snapshot.stateId, (await ye("map", ["--live"])).fact.snapshot.stateId, name);
  }
});

const TS_A = `export function used(): number {
  return 1;
}
`;

const TS_SPEC = `import { used } from "./a";

export const value = used();
`;

const TS_DIR = "src/ts/";

const liveDirectory = (): string => join(repo, ".ye-ast-graph", "live");

const scopeDirectory = (): string =>
  join(liveDirectory(), readdirSync(liveDirectory()).find((name) => !name.endsWith(".state.json") && !name.endsWith(".lock"))!);

const indexTree = (): string => join(scopeDirectory(), ".ye-ast-graph", "index-tree");

function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();
}

test("importers exposes omitted live tests as cuts while revision snapshots read them", async () => {
  commit({ [`${TS_DIR}a.ts`]: TS_A, [`${TS_DIR}a.spec.ts`]: TS_SPEC }, "typescript fixture");
  await trust("trusted");

  const live = await ye("importers", ["--live"], [`${TS_DIR}a.spec.ts`]);
  const sha = await ye("importers", [], [`${TS_DIR}a.spec.ts`]);

  assert.equal(live.code, EXIT_CODE.ok, live.stderr);
  assert.equal(live.fact.status, "partial");
  assert.ok(live.fact.cuts?.some((cut) => cut.kind === "not-exported" && cut.at.includes(`${TS_DIR}a.spec.ts`)));
  assert.equal(sha.fact.status, "complete");
  assert.equal((sha.fact.value as unknown as { files: { file: string }[] }).files[0]?.file, `${TS_DIR}a.spec.ts`);
});

test("the first live query stages the files the export writes and nothing else, and the engine never sees a test file", async () => {
  commit({ [`${TS_DIR}a.ts`]: TS_A, [`${TS_DIR}a.spec.ts`]: TS_SPEC, "docs/notes.md": "# notes\n" }, "typescript fixture");
  await trust("trusted");

  const answer = await ye("impact", ["--base", "HEAD", "--live"]);

  assert.equal(answer.code, EXIT_CODE.ok, answer.stderr);
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repo, env: GIT_ENV, encoding: "utf8" }).split("\0").filter((path) => path !== "");
  const staged = filesUnder(indexTree()).filter((path) => !path.startsWith(".ye-ast-graph/"));
  assert.deepEqual(staged, listed.filter((path) => isInMapScope(path)).sort());
  assert.ok(listed.length > staged.length);

  const opened = createCodeGraph().open(indexTree());
  assert.equal(opened.ok, true, opened.ok ? "" : opened.fault.detail);
  if (!opened.ok) return;
  try {
    assert.deepEqual(opened.value.symbolsInFiles([`${TS_DIR}a.spec.ts`]), []);
    assert.ok(opened.value.symbolsInFiles([`${TS_DIR}a.ts`]).some((symbol) => symbol.name === "used"));
  } finally {
    opened.value.close();
  }
});

test("two live queries over the same tree answer byte for byte, and the index tree changes neither content nor stateId", async () => {
  await trust("trusted");

  const first = await ye("impact", ["--base", "HEAD", "--live"]);
  const second = await ye("impact", ["--base", "HEAD", "--live"]);

  assert.equal(first.code, EXIT_CODE.ok, first.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.fact.snapshot.stateId, (await ye("map", [])).fact.inputs.content);
});

test("one composition answers a repeated live query from its retained data, an edit misses, and every answer is what a fresh composition answers", async () => {
  await trust("trusted");
  const lines: string[] = [];
  const kept = composeQueries({ scratchRoot, trustDirectory, measure: (line) => lines.push(line) });
  const hits = (): number => lines.filter((line) => JSON.parse(line).ye_ast.event === "cache" && JSON.parse(line).ye_ast.outcome === "hit").length;
  const util = `${DIR}Util.java`;
  const request = { repo, repoId: "shop", live: true } as const;
  const asks = {
    map: (queries: ReturnType<typeof composeQueries>) => queries.entrypoints.map(request),
    change: (queries: ReturnType<typeof composeQueries>) => queries.impact.ofChange({ ...request, base: "HEAD" }),
    callers: (queries: ReturnType<typeof composeQueries>) => queries.impact.callers({ ...request, targets: [{ file: util, symbol: "fmt" }] }),
    importers: (queries: ReturnType<typeof composeQueries>) => queries.impact.importers({ ...request, files: [util] }),
  };

  for (const [name, ask] of Object.entries(asks)) {
    const miss = await ask(kept);
    const before = hits();
    const hit = await ask(kept);
    assert.ok(miss.ok && hit.ok, name);
    assert.ok(hits() > before, `${name} reuses retained data`);
    assert.equal(canonicalJson(hit), canonicalJson(miss), name);
    assert.equal(canonicalJson(hit), canonicalJson(await ask(composeQueries({ scratchRoot, trustDirectory }))), name);
  }

  write({ [util]: UTIL('s + "!"') });
  for (const [name, ask] of Object.entries(asks)) {
    const edited = await ask(kept);
    assert.ok(edited.ok, name);
    assert.equal(canonicalJson(edited), canonicalJson(await ask(composeQueries({ scratchRoot, trustDirectory }))), name);
  }
});

const ANGULAR_PACKAGE = JSON.stringify({ dependencies: { "@angular/core": "20.0.0", "@angular/router": "20.0.0" } });
const ROUTES = 'import { Routes } from "@angular/router";\nexport const routes: Routes = [\n  { path: "list", loadComponent: () => import("./list.component") },\n];\n';
const LIST = 'import { Component } from "@angular/core";\n@Component({ selector: "app-list", template: "" })\nexport default class ListComponent {}\n';
const HOME = 'import { Component } from "@angular/core";\n@Component({ selector: "app-home", templateUrl: "./home.component.html" })\nexport default class HomeComponent {}\n';

test("a live importers answer after an edit that only touched a template agrees with committing the same bytes", async () => {
  commit({ "package.json": ANGULAR_PACKAGE, "web/app.routes.ts": ROUTES, "web/list.component.ts": LIST, "web/home.component.ts": HOME, "web/home.component.html": '<a routerLink="/list">List</a>\n' });
  await trust("trusted");
  const users = (answer: Answer): unknown => (answer.fact.value as unknown as { files: { users: string[] }[] }).files[0]?.users;
  const linked = await ye("importers", ["--live"], ["web/app.routes.ts"]);
  assert.deepEqual(users(linked), ["web/home.component.ts"]);

  write({ "web/home.component.html": "<p>Home</p>\n" });
  const live = await ye("importers", ["--live"], ["web/app.routes.ts"]);
  commit({ "web/home.component.html": "<p>Home</p>\n" });
  const sha = await ye("importers", [], ["web/app.routes.ts"]);

  assert.equal(live.code, EXIT_CODE.ok, live.stderr);
  assert.deepEqual(users(sha), []);
  assert.deepEqual(users(live), users(sha));
});
