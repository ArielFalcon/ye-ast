import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { Fact } from "../core/domain/shared/fact.ts";

/** `schema.ts` imports the constant `cutOwner`; the graph matches its uses to the function of the same name in `other.ts`. */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture" }),
  "src/parts.ts": "export const cutOwner = 1;\n",
  "src/other.ts": "function cutOwner(): number {\n  return 2;\n}\n\nexport const x = cutOwner();\n",
  "src/schema.ts": 'import { cutOwner } from "./parts.ts";\n\nexport function shape(): unknown {\n  return { owner: cutOwner };\n}\n\nexport function pass(): unknown {\n  return String(cutOwner);\n}\n',
};

let root: string;
let repo: string;
let scratchRoot: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-binding-homonyms-"));
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

async function callersOf(file: string, symbol: string): Promise<{ symbol: string; lines?: readonly number[] }[]> {
  const result = await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "binding-homonyms", revision: "HEAD", targets: [{ file, symbol }] });
  assert.ok(result.ok, JSON.stringify(result));
  const answer: Fact<ImpactValue> = result.value;
  assert.notEqual(answer.status, "unknown", JSON.stringify(answer));
  return answer.status === "unknown" ? [] : answer.value.symbols.map((reached) => ({ symbol: reached.symbol, ...(reached.via?.lines === undefined ? {} : { lines: reached.via.lines }) }));
}

test("a use of an imported name depends on the declaration the import binds, not on a homonym the graph matched", async () => {
  assert.deepEqual(await callersOf("src/parts.ts", "cutOwner"), [{ symbol: "cutOwner" }, { symbol: "shape", lines: [4] }, { symbol: "pass", lines: [8] }]);
  assert.deepEqual(await callersOf("src/other.ts", "cutOwner"), [{ symbol: "cutOwner" }, { symbol: "x", lines: [5] }]);
});

test("a file whose uses the graph matched to a homonym of what it imports is no user of the homonym's file", async () => {
  const result = await composeQueries({ scratchRoot }).impact.importers({ repo, repoId: "binding-homonyms", revision: "HEAD", files: ["src/other.ts", "src/parts.ts"] });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));

  assert.deepEqual(result.value.value.files.map(({ file, users }) => ({ file, users })), [{ file: "src/other.ts", users: [] }, { file: "src/parts.ts", users: ["src/schema.ts"] }]);
});
