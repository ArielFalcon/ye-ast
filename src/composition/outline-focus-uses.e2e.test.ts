import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";

/** Declarations whose first line is not the line of their name, used outside the body that uses them. */
const FILES: Record<string, string> = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { lib: ["es2022"], strict: true, noEmit: true } }),
  "captured.ts": "export function outer() {\n  const\n  external = () => 1;\n  function together() { return external.call(null); }\n  return together;\n}\n",
  "decorated.ts": "function decorate(value: any, context: any) {}\n@decorate\nexport class External {}\nexport function together() { return External.bind(null); }\n",
  "multiline.ts": "export\nfunction\nexternal() { return 1; }\nexport function together() { return external.call(null); }\n",
  "defs.ts": "export function real() { return 1; }\n",
  "barrel-hidden.ts": "function alias() { return 99; }\nexport { real as alias } from './defs';\n",
  "ns-hidden.ts": "import * as N from './barrel-hidden';\nexport function together() { return N.alias.call(null); }\n",
  "service.ts": "export class Service { load() { return 1; } }\nexport function together(svc: Service) { return svc.load(); }\n",
  "src/main/java/app/Peer.java": "package app;\npublic class Peer {\n  public void touch() {}\n}\n",
  "src/main/java/app/Local.java": "package app;\npublic class Local {\n  void together(Peer peer) {\n    peer.touch();\n  }\n}\n",
  "one.ts": "export function same() { return 1; }\n",
  "two.ts": "export function same() { return 2; }\n",
  "star.ts": "export * from './one';\nexport * from './two';\n",
  "ns-star.ts": "import * as N from './star';\nexport function together() { return N.same(); }\n",
  "src/main/java/q/Helper.java": "package q;\npublic class Helper {}\n",
  "src/main/java/p/Service.java": "package p;\nimport q.*;\nclass Service {\n  void together() { new Helper(); }\n}\n",
  "factory.ts": "export function make(deps: { graph: { open(): number } }) {\n  return function together() { return deps.graph.open(); };\n}\n",
  "ambiguous.ts": "export function handler() {\n  const handler = () => 1;\n  function together() { return handler.call(null); }\n  return together;\n}\n",
};

let root: string;
let repo: string;
let scratchRoot: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-outline-focus-uses-"));
  repo = join(root, "repo");
  scratchRoot = join(root, "scratch");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
  await mkdir(repo);
  await mkdir(scratchRoot);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  execFileSync("git", ["add", "."], { cwd: repo, env });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo, env });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function focusOf(file: string) {
  const answer = await composeQueries({ scratchRoot }).outline.outline({ repo, repoId: "outline-focus-uses", revision: "HEAD", focus: [{ file, symbol: "together" }] });
  assert.ok(answer.ok && answer.value.status !== "unknown", JSON.stringify(answer));
  return answer.value;
}

async function usesOf(file: string): Promise<unknown> {
  const fact = await focusOf(file);
  assert.ok(fact.status === "complete", JSON.stringify(fact));
  return fact.value.focus?.[0]?.uses;
}

test("a value an enclosing function declares over two lines is a use of its declaration, not a local of the focused body", async () => {
  assert.deepEqual(await usesOf("captured.ts"), [{ declaration: { file: "captured.ts", name: "external", kind: "function", line: 3, endLine: 3 }, relations: ["calls"], at: [{ line: 4, column: 32 }] }]);
});

test("a decorated class used by the focused body is a use of the class", async () => {
  assert.deepEqual(await usesOf("decorated.ts"), [{ declaration: { file: "decorated.ts", name: "External", kind: "class", line: 3, endLine: 3 }, relations: ["calls"], at: [{ line: 4, column: 37 }] }]);
});

test("a function whose signature spans several lines, used by the focused body, is a use of the function", async () => {
  assert.deepEqual(await usesOf("multiline.ts"), [{ declaration: { file: "multiline.ts", name: "external", kind: "function", line: 2, endLine: 3 }, relations: ["calls"], at: [{ line: 4, column: 37 }] }]);
});

test("a parameter of a factory around the focused function is a local root: no use and no cut", async () => {
  assert.deepEqual(await usesOf("factory.ts"), []);
});

test("a captured value two indexed declarations could be is a cut, never a local root", async () => {
  const answer = await composeQueries({ scratchRoot }).outline.outline({ repo, repoId: "outline-focus-uses", revision: "HEAD", focus: [{ file: "ambiguous.ts", symbol: "together" }] });
  assert.ok(answer.ok, JSON.stringify(answer));
  assert.equal(answer.value.status, "partial", JSON.stringify(answer.value));
  assert.deepEqual(answer.value.value.focus?.[0]?.uses, []);
});

test("a member of a namespace import is what the module exports under that name, never a private homonym it declares", async () => {
  assert.deepEqual(await usesOf("ns-hidden.ts"), [{ declaration: { file: "defs.ts", name: "real", kind: "function", line: 1, endLine: 1 }, relations: ["calls"], at: [{ line: 2, column: 37 }] }]);
});

test("a member reached through a parameter of the body is no use even when the graph resolved it; the parameter's type is", async () => {
  assert.deepEqual(await usesOf("service.ts"), [{ declaration: { file: "service.ts", name: "Service", kind: "class", line: 1, endLine: 1 }, relations: ["references"], at: [{ line: 2, column: 31 }] }]);
});

test("a Java method reached through a parameter of the body is no use; the parameter's type is", async () => {
  const uses = (await usesOf("src/main/java/app/Local.java")) as { declaration?: { name: string } }[];
  assert.deepEqual(uses.map((use) => use.declaration?.name), ["Peer"]);
});

test("a namespace member two star exports could supply is a cut, never one of them", async () => {
  const fact = await focusOf("ns-star.ts");
  assert.deepEqual(fact.value.focus?.[0]?.uses, []);
  assert.deepEqual(fact.status === "partial" ? fact.cuts.map((cut) => cut.at) : [], [["ns-star.ts::together", "ns-star.ts:2 same"]]);
});

test("a Java type only a wildcard import supplies is a cut, never the type the graph matched", async () => {
  const fact = await focusOf("src/main/java/p/Service.java");
  assert.deepEqual(fact.value.focus?.[0]?.uses, []);
  assert.deepEqual(fact.status === "partial" ? fact.cuts.map((cut) => cut.at) : [], [["src/main/java/p/Service.java::p.Service.together", "src/main/java/p/Service.java:4 Helper"]]);
});
