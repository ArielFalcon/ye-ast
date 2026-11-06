import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeQueries } from "./compose.ts";

/** Declarations whose first line is not the line of their name, used outside the body that uses them. */
const FILES: Record<string, string> = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { lib: ["es2022"], strict: true, noEmit: true } }),
  "captured.ts": "export function outer() {\n  const\n  external = () => 1;\n  function together() { return external.call(null); }\n  return together;\n}\n",
  "decorated.ts": "function decorate(value: any, context: any) {}\n@decorate\nexport class External {}\nexport function together() { return External.bind(null); }\n",
  "multiline.ts": "export\nfunction\nexternal() { return 1; }\nexport function together() { return external.call(null); }\n",
  "factory.ts": "export function make(deps: { graph: { open(): number } }) {\n  return function together() { return deps.graph.open(); };\n}\n",
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
  for (const [path, text] of Object.entries(FILES)) await writeFile(join(repo, path), text);
  execFileSync("git", ["add", "."], { cwd: repo, env });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo, env });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function usesOf(file: string): Promise<unknown> {
  const answer = await composeQueries({ scratchRoot }).outline.outline({ repo, repoId: "outline-focus-uses", revision: "HEAD", focus: [{ file, symbol: "together" }] });
  assert.ok(answer.ok, JSON.stringify(answer));
  assert.ok(answer.value.status === "complete", JSON.stringify(answer.value));
  return answer.value.value.focus?.[0]?.uses;
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
