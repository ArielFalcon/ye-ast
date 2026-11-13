import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import type { TraceValue } from "../core/domain/trace/trace-fact.ts";
import type { Cut } from "../core/domain/shared/fact.ts";
import { composeCli } from "./compose.ts";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const CHECKOUT = {
  "pom.xml": "<project><groupId>com.acme</groupId><artifactId>shop</artifactId></project>\n",
  "src/main/java/com/acme/Billing.java": "package com.acme;\n\npublic class Billing {\n  public int total() {\n    return 1;\n  }\n}\n",
  "src/main/java/com/acme/Other.java": "package com.acme;\n\npublic class Other {\n  public int total() {\n    return 2;\n  }\n}\n",
  "src/main/java/com/acme/Checkout.java": "package com.acme;\n\npublic class Checkout {\n  private final Billing billing = new Billing();\n\n  public int pay() {\n    return billing.total();\n  }\n}\n",
};

let workspace: string;
let repo: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-"));
  repo = join(workspace, "shop");
  mkdirSync(repo);
  mkdirSync(join(workspace, "scratch"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: GIT_ENV });
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function commit(files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  execFileSync("git", ["add", "-A"], { cwd: repo, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repo, env: GIT_ENV });
}

async function trace(target: string): Promise<{ status: string; cuts?: readonly Cut[]; value: TraceValue }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })(["trace", repo, target], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  return JSON.parse(stdout.join("\n"));
}

for (const [build, script] of [
  ["a Gradle build script in the Kotlin DSL", { "build.gradle.kts": "plugins { java }\n", "settings.gradle.kts": "rootProject.name = \"shop\"\n" }],
  ["Gradle build logic under buildSrc", { "buildSrc/src/main/kotlin/Conventions.kt": "object Conventions\n" }],
] as const) {
  test(`${build} is build configuration, so a Java receiver stays proven`, async () => {
    commit({ ...CHECKOUT, ...script });

    const fact = await trace("src/main/java/com/acme/Checkout.java:pay");

    assert.deepEqual([fact.status, fact.cuts ?? []], ["complete", []]);
  });
}

test("a Kotlin source of the main source set still refuses a Java receiver proof", async () => {
  commit({ ...CHECKOUT, "build.gradle.kts": "plugins { java }\n", "src/main/kotlin/com/acme/Refund.kt": "package com.acme\n\nclass Refund\n" });

  const fact = await trace("src/main/java/com/acme/Checkout.java:pay");

  assert.equal(fact.status, "partial");
  assert.deepEqual(fact.cuts?.map((cut) => [cut.kind, "reason" in cut ? cut.reason : undefined, cut.at[0]]), [["unresolved-link", "receiver-unproven", "src/main/java/com/acme/Checkout.java:7 total"], ["no-extractor", "language", "src/main/kotlin/com/acme/Refund.kt"]]);
});
