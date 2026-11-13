import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";

/**
 * A Java enum is a type: it owns its methods and implements interfaces, so a call through the interface is a caller of
 * the enum's method.
 */
const JAVA = "src/main/java/app";
const UNIT = `${JAVA}/Unit.java`;
const PAINTER = `${JAVA}/Painter.java`;
const JAVA_SOURCES: Record<string, string> = {
  [`${JAVA}/Shape.java`]: "package app;\n\npublic interface Shape {\n  int area();\n}\n",
  [UNIT]: "package app;\n\npublic enum Unit implements Shape {\n  ONE;\n\n  @Override\n  public int area() {\n    return 1;\n  }\n}\n",
  [PAINTER]: "package app;\n\npublic class Painter {\n  public int paint(Shape shape) {\n    return shape.area();\n  }\n}\n",
};
const JAVA_CHANGE = { [UNIT]: JAVA_SOURCES[UNIT]!.replace("return 1;", "return 2;") };

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };

let root: string;
let scratchRoot: string;
let java: string;

async function commit(repo: string, files: Record<string, string>, message: string): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  execFileSync("git", ["add", "."], { cwd: repo, env: ENV });
  execFileSync("git", ["commit", "-qm", message], { cwd: repo, env: ENV });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-enum-supertypes-"));
  scratchRoot = join(root, "scratch");
  await mkdir(scratchRoot);
  java = join(root, "java");
  await mkdir(java);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: java, env: ENV });
  await commit(java, JAVA_SOURCES, "fixture");
  await commit(java, JAVA_CHANGE, "change");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

type Answer = { status: string; symbols: string[] };

function answerOf(result: Awaited<ReturnType<ReturnType<typeof composeQueries>["impact"]["callers"]>>): Answer {
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(result.value.status !== "unknown", JSON.stringify(result.value));
  const value: ImpactValue = result.value.value;
  return { status: result.value.status, symbols: value.symbols.map(({ file, symbol }) => `${file}:${symbol}`).toSorted() };
}

test("callers of a Java enum's method list the code that calls it through an interface the enum implements", async () => {
  const queries = composeQueries({ scratchRoot });
  const answer = answerOf(await queries.impact.callers({ repo: java, repoId: "enum-java", revision: "HEAD~1", targets: [{ file: UNIT, symbol: "area" }] }));

  assert.equal(answer.status, "complete");
  assert.ok(answer.symbols.includes(`${PAINTER}:paint`), JSON.stringify(answer.symbols));
});

test("the impact of a change to a Java enum's method reaches the code that calls it through an interface the enum implements", async () => {
  const queries = composeQueries({ scratchRoot });
  const answer = answerOf(await queries.impact.ofChange({ repo: java, repoId: "enum-java", base: "HEAD~1", head: "HEAD" }));

  assert.equal(answer.status, "complete");
  assert.ok(answer.symbols.includes(`${PAINTER}:paint`), JSON.stringify(answer.symbols));
});
