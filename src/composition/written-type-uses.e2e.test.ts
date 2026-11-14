import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";

/**
 * A type written as the type of a property: the index places the use at the property, a node the walk does not follow a
 * reference from, so the dependent is the interface or class that declares the property, reached by its own reference.
 */
const SOURCES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
  "src/mode.ts": 'export type Mode = "a" | "b";\nexport interface Shape { side: number }\nexport enum Color { Red, Blue }\nexport class Box { size = 1; }\n',
  "src/holder.ts":
    'import { Mode, Shape, Color, Box } from "./mode";\nexport interface Holder { mode: Mode; }\nexport type Alias = { shape: Shape };\nexport class Keeper { color: Color = Color.Red; }\nexport function take(box: Box): void { void box; }\nexport interface Fn { run(box: Box): Shape; }\n',
  "src/more.ts":
    'import { Mode, Shape, Color, Box } from "./mode";\nexport interface Wide { shape: Shape; box: Box; }\nexport class Store { shape!: Shape; private mode: Mode = "a"; }\nexport function pick(mode: Mode, color: Color): Mode { return color === Color.Red ? mode : "b"; }\nexport type Pair = [Mode, Color];\n',
  "src/holder-use.ts": 'import { Holder } from "./holder";\n\nexport function useHolder(holder: Holder): void {\n  void holder;\n}\n',
  "src/shapes.ts":
    'import { Shape } from "./mode";\n\nexport interface Optional { maybe?: Shape; }\nexport interface ReadOnly { readonly fixed: Shape; }\nexport interface Nested { outer: { inner: Shape }; }\nexport class Generic { items: Array<Shape> = []; }\nexport abstract class Abstract { abstract shape: Shape; }\n',
  "src/both.ts": 'import { Box } from "./mode";\n\nexport class Both {\n  box: Box = new Box();\n}\n',
  "src/both-use.ts": 'import { Both } from "./both";\n\nexport function useBoth(both: Both): void {\n  void both;\n}\n',
};
const CHANGE = { "src/mode.ts": 'export type Mode = "a" | "b" | "c";\nexport interface Shape { side: number }\nexport enum Color { Red, Blue }\nexport class Box { size = 1; }\n' };

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
  root = await mkdtemp(join(tmpdir(), "ye-ast-written-type-uses-"));
  scratchRoot = join(root, "scratch");
  repo = join(root, "repo");
  await mkdir(scratchRoot);
  await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: ENV });
  await commit(SOURCES, "fixture");
  await commit(CHANGE, "change");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function callersOf(symbol: string): Promise<{ status: string; value: ImpactValue }> {
  const result = await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "fixture", revision: "HEAD", targets: [{ file: "src/mode.ts", symbol }] });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));
  return { status: result.value.status, value: result.value.value };
}

const dependents = (value: ImpactValue) =>
  value.symbols.filter(({ depth }) => depth > 0).map(({ file, symbol, depth, via }) => ({ file, symbol, depth, via: via?.symbol, basis: via?.basis, lines: via?.lines ?? [] }));

test("a type written as a property's type is a dependent at the interface or class that declares the property, whose own users follow, beside the declarations that write it elsewhere, for callers and for the impact of a change", async () => {
  const callers = await callersOf("Mode");
  const change = await composeQueries({ scratchRoot }).impact.ofChange({ repo, repoId: "fixture", base: "HEAD~1", head: "HEAD" });
  assert.ok(change.ok && change.value.status !== "unknown", JSON.stringify(change));

  for (const { status, value } of [callers, { status: change.value.status, value: change.value.value }]) {
    assert.equal(status, "complete");
    assert.deepEqual(dependents(value), [
      { file: "src/holder.ts", symbol: "Holder", depth: 1, via: "Mode", basis: "reference", lines: [2] },
      { file: "src/more.ts", symbol: "Store", depth: 1, via: "Mode", basis: "reference", lines: [3] },
      { file: "src/more.ts", symbol: "pick", depth: 1, via: "Mode", basis: "reference", lines: [4] },
      { file: "src/more.ts", symbol: "Pair", depth: 1, via: "Mode", basis: "reference", lines: [5] },
      { file: "src/holder-use.ts", symbol: "useHolder", depth: 2, via: "Holder", basis: "reference", lines: [3] },
    ]);
  }
});

test("a property optional, readonly, abstract, of a nested type literal or typed with a generic argument names the type that declares it, as a type literal of a type alias and a method signature name themselves", async () => {
  const { status, value } = await callersOf("Shape");

  assert.equal(status, "complete");
  assert.deepEqual(
    dependents(value).filter(({ depth }) => depth === 1).map(({ file, symbol, lines }) => `${file}:${symbol}:${lines.join(",")}`),
    ["src/holder.ts:Alias:3", "src/holder.ts:Fn:", "src/holder.ts:run:6", "src/more.ts:Wide:2", "src/more.ts:Store:3", "src/shapes.ts:Optional:3", "src/shapes.ts:ReadOnly:4", "src/shapes.ts:Nested:5", "src/shapes.ts:Generic:6", "src/shapes.ts:Abstract:7"],
  );
});

test("a property whose type and initializer both write an enum names its class once, beside the declarations that read the enum elsewhere", async () => {
  const { status, value } = await callersOf("Color");

  assert.equal(status, "complete");
  assert.deepEqual(dependents(value).map(({ file, symbol, lines }) => `${file}:${symbol}:${lines.join(",")}`), ["src/holder.ts:Keeper:4", "src/more.ts:pick:4", "src/more.ts:Pair:5"]);
});

test("a property whose initializer calls or instantiates on the line of its type is a dependent of its own, and its class names the type by its own reference, whose users follow", async () => {
  const { status, value } = await callersOf("Box");

  assert.equal(status, "complete");
  assert.deepEqual(dependents(value).map(({ file, symbol, depth, basis, lines }) => `${depth} ${file}:${symbol}:${basis}:${lines.join(",")}`), [
    "1 src/both.ts:Both:reference:4",
    "1 src/both.ts:box:call:4",
    "1 src/holder.ts:take:reference:5",
    "1 src/holder.ts:Fn:contains:",
    "1 src/holder.ts:run:reference:6",
    "1 src/more.ts:Wide:reference:2",
    "2 src/both-use.ts:useBoth:reference:3",
  ]);
});
