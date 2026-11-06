import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { Fact } from "../core/domain/shared/fact.ts";

const MODEL = "export interface Expression {\n  value: number;\n}\n\nexport class Base {}\n\nexport function evaluate(expression: Expression): number {\n  return expression.value;\n}\n";

/** Names a package spells like declarations of the repository: the graph matches them by their last name. */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture", dependencies: { pkg: "1.0.0" } }),
  "src/model.ts": MODEL,
  "src/uses-default.ts": 'import ts from "pkg";\n\nexport function show(node: ts.Expression): string {\n  return String(node);\n}\n',
  "src/uses-namespace.ts": 'import * as pkg from "pkg";\n\nexport function render(node: pkg.Expression): string {\n  return String(node);\n}\n\nexport function make(): unknown {\n  return new pkg.Base();\n}\n',
  "src/uses-value.ts": 'import { evaluate } from "pkg";\n\nexport const table = { run: evaluate };\n\nexport function main(): unknown {\n  return table;\n}\n',
  "src/uses-repo.ts": 'import { Base, Expression, evaluate } from "./model.ts";\n\nexport function real(expression: Expression): number {\n  return evaluate(expression) + (new Base() ? 1 : 0);\n}\n',
};

const OUTSIDE = ["show", "render", "make", "table", "main"];

let root: string;
let repo: string;
let scratchRoot: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-package-homonyms-"));
  repo = join(root, "repo");
  scratchRoot = join(root, "scratch");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
  await mkdir(repo);
  await mkdir(scratchRoot);
  git("init", "-q", "-b", "main");
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  git("add", ".");
  git("commit", "-qm", "fixture");
  await writeFile(join(repo, "src/model.ts"), MODEL.replace("value: number;", "value: number;\n  label: string;").replace("return expression.value;", "return expression.value + 1;"));
  git("commit", "-qam", "change model");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function names(result: { ok: true; value: Fact<ImpactValue> } | { ok: false }): string[] {
  assert.ok(result.ok, JSON.stringify(result));
  assert.notEqual(result.value.status, "unknown", JSON.stringify(result.value));
  return result.value.status === "unknown" ? [] : result.value.value.symbols.map((symbol) => symbol.symbol);
}

async function callersOf(symbol: string): Promise<string[]> {
  return names(await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "package-homonyms", revision: "HEAD", targets: [{ file: "src/model.ts", symbol }] }));
}

test("a name rooted at a package import is no caller of the repository declaration it is spelled like", async () => {
  for (const symbol of ["Expression", "Base", "evaluate"]) {
    const reached = await callersOf(symbol);
    assert.ok(reached.includes("real"), `${symbol}: ${reached.join(", ")}`);
    assert.deepEqual(reached.filter((name) => OUTSIDE.includes(name)), [], symbol);
  }
});

test("a change to the repository declarations reaches only the code that imports them", async () => {
  const reached = names(await composeQueries({ scratchRoot }).impact.ofChange({ repo, repoId: "package-homonyms", base: "HEAD~1", head: "HEAD" }));

  assert.ok(reached.includes("real"), reached.join(", "));
  assert.deepEqual(reached.filter((name) => OUTSIDE.includes(name)), []);
});

test("a file whose names are rooted at a package import is no user of the repository file they are spelled like", async () => {
  const result = await composeQueries({ scratchRoot }).impact.importers({ repo, repoId: "package-homonyms", revision: "HEAD", files: ["src/model.ts"] });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));

  assert.deepEqual(result.value.value.files.map(({ users }) => users), [["src/uses-repo.ts"]]);
});
