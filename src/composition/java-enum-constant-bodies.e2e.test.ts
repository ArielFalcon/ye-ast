import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";

/**
 * The class body of a Java enum constant is a type below its enum (JLS 8.9.1): a method it declares overrides the enum's,
 * so the code that calls the enum's method runs the body's.
 */
const JAVA = "src/main/java/app";
const UNIT = `${JAVA}/Unit.java`;
const EXTRA = `${JAVA}/Extra.java`;
const PAINTER = `${JAVA}/Painter.java`;
const SOURCES: Record<string, string> = {
  [UNIT]: "package app;\n\npublic enum Unit {\n  ONE {\n    @Override\n    int area() {\n      return Extra.more();\n    }\n  },\n  TWO;\n\n  int area() {\n    return 2;\n  }\n}\n",
  [EXTRA]: "package app;\n\npublic class Extra {\n  static int more() {\n    return 1;\n  }\n}\n",
  [PAINTER]: "package app;\n\npublic class Painter {\n  public int paint(Unit unit) {\n    return unit.area();\n  }\n}\n",
};
const CHANGE = { [UNIT]: SOURCES[UNIT]!.replace("return Extra.more();", "return Extra.more() + 1;") };

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };

let root: string;
let scratchRoot: string;
let repo: string;

async function commit(files: Record<string, string>, message: string): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  execFileSync("git", ["add", "."], { cwd: repo, env: ENV });
  execFileSync("git", ["commit", "-qm", message], { cwd: repo, env: ENV });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-enum-constant-bodies-"));
  scratchRoot = join(root, "scratch");
  await mkdir(scratchRoot);
  repo = join(root, "java");
  await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: ENV });
  await commit(SOURCES, "fixture");
  await commit(CHANGE, "change");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

type Answer = { status: string; symbols: string[] };

function answerOf(result: Awaited<ReturnType<ReturnType<typeof composeQueries>["impact"]["callers"]>>): Answer {
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(result.value.status !== "unknown", JSON.stringify(result.value));
  const value: ImpactValue = result.value.value;
  return { status: result.value.status, symbols: value.symbols.map(({ file, symbol, line }) => `${file}:${line}:${symbol}`).toSorted() };
}

test("callers of what a constant body's method calls list the code that calls the enum's method", async () => {
  const answer = answerOf(await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "enum-bodies", revision: "HEAD~1", targets: [{ file: EXTRA, symbol: "more" }] }));

  assert.equal(answer.status, "complete");
  assert.ok(answer.symbols.includes(`${PAINTER}:4:paint`), JSON.stringify(answer.symbols));
});

test("the impact of a change to a constant body's method reaches the code that calls the enum's method", async () => {
  const answer = answerOf(await composeQueries({ scratchRoot }).impact.ofChange({ repo, repoId: "enum-bodies", base: "HEAD~1", head: "HEAD" }));

  assert.equal(answer.status, "complete");
  assert.ok(answer.symbols.includes(`${PAINTER}:4:paint`), JSON.stringify(answer.symbols));
});

test("callers of the enum's method list its caller and the constant body's override below it", async () => {
  const answer = answerOf(await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "enum-bodies", revision: "HEAD~1", targets: [{ file: UNIT, start: 12, end: 14 }] }));

  assert.equal(answer.status, "complete");
  assert.ok(answer.symbols.includes(`${PAINTER}:4:paint`), JSON.stringify(answer.symbols));
  assert.ok(answer.symbols.includes(`${UNIT}:5:area`), JSON.stringify(answer.symbols));
});
