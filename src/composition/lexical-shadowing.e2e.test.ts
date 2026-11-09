import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import { composeCli, composeQueries } from "./compose.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { Fact } from "../core/domain/shared/fact.ts";
import type { TraceValue } from "../core/domain/trace/trace-fact.ts";

/**
 * A name the occurrence's own scope binds never reaches the repository declaration an outer binding of that name would:
 * codegraph resolves a call, a type or a receiver's annotation by name, and the base reads the occurrence's binding.
 */
const FILES: Record<string, string> = Object.fromEntries([
  ["package.json", JSON.stringify({ name: "fixture" })],
  ["src/fmt.ts", "export function load(): string {\n  return 'f';\n}\n"],
  [
    "src/use.ts",
    [
      'import { load } from "./fmt";',
      "",
      "export function shadowed(): void {",
      "  const load = () => {};",
      "  load();",
      "}",
      "",
      "export const destructured = ({ load }: { load: () => void }) => load();",
      "",
      "export function caught(): void {",
      "  try {",
      "    shadowed();",
      "  } catch (load) {",
      "    load();",
      "  }",
      "}",
      "",
      "export function looped(fs: (() => void)[]): void {",
      "  for (const load of fs) {",
      "    load();",
      "  }",
      "}",
      "",
      "export function real(): void {",
      "  load();",
      "}",
      "",
    ].join("\n"),
  ],
  ["src/box.ts", "export class Box {\n  open(): void {}\n}\n"],
  ["src/made.ts", 'import { Box } from "./box";\n\nexport function made(): void {\n  class Box {}\n  new Box();\n}\n\nexport function real(): void {\n  new Box();\n}\n'],
  ["src/store.ts", "export class Store {\n  save(x: string): void {\n    console.log(x);\n  }\n}\n\nexport class Holder<Store extends { save(x: string): void }> {\n  put(store: Store): void {\n    store.save('h');\n  }\n}\n"],
]);

let root: string;
let repo: string;
let scratchRoot: string;

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-lexical-shadowing-"));
  repo = join(root, "repo");
  scratchRoot = join(root, "scratch");
  await mkdir(repo);
  await mkdir(scratchRoot);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: ENV });
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  execFileSync("git", ["add", "."], { cwd: repo, env: ENV });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo, env: ENV });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function callersOf(file: string, symbol: string): Promise<Fact<ImpactValue>> {
  const result = await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "lexical-shadowing", revision: "HEAD", targets: [{ file, symbol }] });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));
  return result.value;
}

/** The dependents a call proves, by their declaration, the lines of the call and how the call was bound. */
const dependents = (fact: Fact<ImpactValue>): string[] => (fact.status === "unknown" ? [] : fact.value.symbols.filter(({ depth, via }) => depth > 0 && via?.basis === "call").map(({ file, symbol, via }) => `${file}:${symbol} L${via?.lines?.join(",")} ${via?.derivation}`));

async function trace(target: string): Promise<TraceValue> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot, indexCache: join(root, "cache") })(["trace", repo, target], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  return (JSON.parse(stdout.join("\n")) as { value: TraceValue }).value;
}

const leavesOf = (value: TraceValue): string[] => value.steps.flatMap((step) => (step.leaves ?? []).map((leaf) => `${leaf.file}:${leaf.symbol}`));

test("callers of an imported declaration list only the calls and instantiations whose occurrence reads the import, never one a local, destructured, caught or iterated binding or a local class of its name shadows", async () => {
  assert.deepEqual(dependents(await callersOf("src/fmt.ts", "load")), ["src/use.ts:real L25 resolved"]);
  assert.deepEqual(dependents(await callersOf("src/box.ts", "Box")), ["src/made.ts:real L9 resolved"]);
});

test("trace runs the local binding a shadowed call names, and expands no imported body the call never runs", async () => {
  assert.deepEqual(leavesOf(await trace("src/use.ts:shadowed")), ["src/use.ts:load"]);
  assert.ok(!leavesOf(await trace("src/use.ts:caught")).includes("src/fmt.ts:load"));
});

test("callers of a class's method list a call on a receiver whose annotation names a type parameter that shadows the class only as a name match, never proven", async () => {
  assert.deepEqual(dependents(await callersOf("src/store.ts", "Store.save")), ["src/store.ts:put L9 name-match"]);
});
