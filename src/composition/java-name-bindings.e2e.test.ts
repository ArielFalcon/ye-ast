import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { Fact } from "../core/domain/shared/fact.ts";

/**
 * `Accounts` imports the repository's `User` and also spells a platform `User` by its qualified name; the graph resolves
 * both spellings through the import.
 */
const USER = "src/main/java/app/domain/User.java";
const FILES: Record<string, string> = {
  [USER]: "package app.domain;\n\npublic class User {}\n",
  "src/main/java/app/service/Accounts.java": [
    "package app.service;",
    "",
    "import app.domain.User;",
    "",
    "public class Accounts {",
    "  public String load(User user) {",
    "    return null;",
    "  }",
    "",
    "  public org.springframework.security.core.userdetails.User build() {",
    "    return null;",
    "  }",
    "}",
    "",
  ].join("\n"),
};

let root: string;
let repo: string;
let scratchRoot: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-java-name-bindings-"));
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

test("a Java type spelled with a platform package is no use of the repository's homonym its file imports", async () => {
  const result = await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "java-name-bindings", revision: "HEAD", targets: [{ file: USER, symbol: "User" }] });
  assert.ok(result.ok, JSON.stringify(result));
  const answer: Fact<ImpactValue> = result.value;
  assert.ok(answer.status !== "unknown", JSON.stringify(answer));

  assert.deepEqual(answer.value.symbols.map(({ file, symbol }) => `${file}:${symbol}`).filter((reached) => !reached.startsWith(USER)), ["src/main/java/app/service/Accounts.java:Accounts", "src/main/java/app/service/Accounts.java:load"]);
});
