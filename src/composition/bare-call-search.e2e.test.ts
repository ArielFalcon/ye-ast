import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODE } from "../cli/main.ts";
import type { Cut } from "../core/domain/shared/fact.ts";
import { composeCli } from "./compose.ts";

/**
 * A Java call without a receiver searches the innermost type around it of which a method of the name is a member, then
 * the single-static-import of the name (JLS 15.12.1, 6.4.1). A superinterface's static method is no member of the types
 * below it (JLS 8.4.8), so it never binds such a call.
 */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
const JAVA = "src/main/java/com/acme";
const SOURCES: Readonly<Record<string, string>> = {
  "pom.xml": "<project><groupId>com.acme</groupId><artifactId>fx</artifactId></project>",
  [`${JAVA}/Util.java`]: ["package com.acme;", "", "public class Util {", "    public static void ping() {", "        System.out.println(\"util\");", "    }", "}"].join("\n"),
  [`${JAVA}/Face.java`]: ["package com.acme;", "", "public interface Face {", "    static void ping() {", "        System.out.println(\"face\");", "    }", "}"].join("\n"),
  [`${JAVA}/Base.java`]: ["package com.acme;", "", "public class Base {", "    void ping() {", "        System.out.println(\"base\");", "    }", "}"].join("\n"),
  [`${JAVA}/Imported.java`]: ["package com.acme;", "", "import static com.acme.Util.ping;", "", "public class Imported implements Face {", "    void run() {", "        ping();", "    }", "}"].join("\n"),
  [`${JAVA}/Shadowed.java`]: ["package com.acme;", "", "import static com.acme.Util.ping;", "", "public class Shadowed extends Base {", "    void run() {", "        ping();", "    }", "}"].join("\n"),
  [`${JAVA}/Nest.java`]: [
    "package com.acme;",
    "",
    "import static com.acme.Util.ping;",
    "",
    "public class Nest {",
    "    void ping() {",
    "        System.out.println(\"nest\");",
    "    }",
    "",
    "    class Inner implements Face {",
    "        void call() {",
    "            ping();",
    "        }",
    "    }",
    "}",
  ].join("\n"),
};

let workspace: string;
let repo: string;

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-bare-call-search-"));
  mkdirSync(join(workspace, "scratch"));
  repo = join(workspace, "repo");
  for (const [path, content] of Object.entries(SOURCES)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), `${content}\n`);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: GIT_ENV });
  execFileSync("git", ["add", "-A"], { cwd: repo, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repo, env: GIT_ENV });
});

after(() => rmSync(workspace, { recursive: true, force: true }));

interface Answer {
  status: string;
  cuts?: readonly Cut[];
  value: unknown;
}

async function run(args: readonly string[]): Promise<Answer> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })(args, { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  return JSON.parse(stdout.join("\n"));
}

/** The status, the steps below the root as `file:symbol@line`, and each cut as its reason and the place it starts at. */
async function trace(target: string): Promise<{ status: string; steps: readonly string[]; cuts: readonly string[] }> {
  const fact = await run(["trace", repo, `${JAVA}/${target}`]);
  const { steps } = fact.value as { steps: readonly { file: string; symbol: string; at?: { line: number } }[] };
  return {
    status: fact.status,
    steps: steps.filter(({ at }) => at !== undefined).map(({ file, symbol, at }) => `${file.split("/").at(-1)}:${symbol}@${at!.line}`),
    cuts: (fact.cuts ?? []).map(({ reason, at }) => `${reason} ${at[0]}`),
  };
}

/** The methods reached through anything but containment, as `file:symbol`. */
async function callers(target: string): Promise<readonly string[]> {
  const fact = await run(["callers", repo, `${JAVA}/${target}`]);
  const { symbols } = fact.value as { symbols: readonly { file: string; symbol: string; kind: string; via?: { basis: string } }[] };
  return symbols.filter(({ kind, via }) => kind === "method" && via !== undefined && via.basis !== "contains").map(({ file, symbol }) => `${file.split("/").at(-1)}:${symbol}`).sort();
}

test("a call without a receiver that no type around it has a member for binds its single-static-import, never a superinterface's static method", async () => {
  assert.deepEqual(await trace("Imported.java:run"), { status: "complete", steps: ["Util.java:ping@7"], cuts: [] });
});

test("a call without a receiver in a nested class binds the member of the class around it, before a static import and past a superinterface's static method", async () => {
  assert.deepEqual(await trace("Nest.java:12-12"), { status: "complete", steps: ["Nest.java:ping@12"], cuts: [] });
});

test("callers of the imported method list the call, and callers of the superinterface's static method do not", async () => {
  assert.ok((await callers("Util.java:ping")).includes("Imported.java:run"));
  assert.ok(!(await callers("Face.java:ping")).includes("Imported.java:run"));
});

test("an inherited member shadows a static import of its name", async () => {
  assert.deepEqual(await trace("Shadowed.java:run"), { status: "complete", steps: ["Base.java:ping@7"], cuts: [] });
});
