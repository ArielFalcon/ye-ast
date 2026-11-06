import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { Fact } from "../core/domain/shared/fact.ts";

const URL_CLASS = "class URL {\n  constructor(path: string) {\n    console.log(path);\n  }\n}\n";

/** Two script files: the first declares a global that shadows a library name, the second uses it without an import. */
const FILES: Record<string, string> = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { lib: ["es2022"], strict: true, noEmit: true } }),
  "url.ts": URL_CLASS,
  "use.ts": 'function use(): unknown {\n  return new URL("/orders");\n}\n',
};

let root: string;
let repo: string;
let scratchRoot: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-script-globals-"));
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
  await writeFile(join(repo, "url.ts"), URL_CLASS.replace("class URL {\n", "class URL {\n  readonly kind = \"url\";\n"));
  git("commit", "-qam", "change URL");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function names(result: { ok: true; value: Fact<ImpactValue> } | { ok: false }): string[] {
  assert.ok(result.ok, JSON.stringify(result));
  assert.notEqual(result.value.status, "unknown", JSON.stringify(result.value));
  return result.value.status === "unknown" ? [] : result.value.value.symbols.map((symbol) => symbol.symbol);
}

test("a script's own global that shadows a library name keeps its callers", async () => {
  const reached = names(await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "script-globals", revision: "HEAD", targets: [{ file: "url.ts", symbol: "URL" }] }));

  assert.deepEqual(reached, ["URL", "use"]);
});

test("a change to a script's own global reaches the scripts that use it", async () => {
  const reached = names(await composeQueries({ scratchRoot }).impact.ofChange({ repo, repoId: "script-globals", base: "HEAD~1", head: "HEAD" }));

  assert.ok(reached.includes("use"), reached.join(", "));
});
