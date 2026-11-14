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
 * A Java call whose receiver the reading cannot read is no step in the homonym the index binds by name (ADR-0087
 * decisions 1 to 3): `super` with a superclass outside the repository, a class literal, and a chain whose links start
 * at one place. A receiver that is a name keeps its answer.
 */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
const JAVA = "src/main/java/com/acme";
const SOURCES: Readonly<Record<string, string>> = {
  "pom.xml": "<project><groupId>com.acme</groupId><artifactId>fx</artifactId></project>",
  [`${JAVA}/Forms.java`]: [
    "package com.acme;",
    "",
    "import com.lib.Base;",
    "",
    "public class Forms extends Base {",
    "    void run() {",
    "        System.out.println(\"run\");",
    "    }",
    "",
    "    String getSimpleName() {",
    "        System.out.println(\"name\");",
    "        return \"forms\";",
    "    }",
    "",
    "    void onSuper() {",
    "        super.run();",
    "    }",
    "",
    "    String onClassLiteral() {",
    "        return Forms.class.getSimpleName();",
    "    }",
    "}",
  ].join("\n"),
  [`${JAVA}/Outer.java`]: ["package com.acme;", "", "public class Outer {", "    public Inner get() {", "        System.out.println(\"outer\");", "        return new Inner();", "    }", "}"].join("\n"),
  [`${JAVA}/Inner.java`]: ["package com.acme;", "", "public class Inner {", "    public void get() {", "        System.out.println(\"inner\");", "    }", "}"].join("\n"),
  [`${JAVA}/Link.java`]: ["package com.acme;", "", "public class Link {", "    public Link next() {", "        System.out.println(\"next\");", "        return this;", "    }", "}"].join("\n"),
  [`${JAVA}/Util.java`]: ["package com.acme;", "", "public class Util {", "    public static void log() {", "        System.out.println(\"log\");", "    }", "}"].join("\n"),
  [`${JAVA}/Chains.java`]: [
    "package com.acme;",
    "",
    "public class Chains {",
    "    void differ(Outer outer) {",
    "        outer.get().get();",
    "    }",
    "",
    "    void alike(Link link) {",
    "        link.next().next();",
    "    }",
    "",
    "    int names() {",
    "        Util.log();",
    "        return Math.abs(1);",
    "    }",
    "}",
  ].join("\n"),
};

let workspace: string;
let repo: string;

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-unread-call-forms-"));
  mkdirSync(join(workspace, "scratch"));
  repo = join(workspace, "forms");
  for (const [path, content] of Object.entries(SOURCES)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), `${content}\n`);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: GIT_ENV });
  execFileSync("git", ["add", "-A"], { cwd: repo, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repo, env: GIT_ENV });
});

after(() => rmSync(workspace, { recursive: true, force: true }));

interface Trace {
  status: string;
  cuts?: readonly Cut[];
  value: { steps: readonly { file: string; symbol: string; at?: { line: number } }[] };
}

async function trace(target: string): Promise<Trace> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })(["trace", repo, `${JAVA}/${target}`], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  return JSON.parse(stdout.join("\n"));
}

/** The steps below the root, as `file:symbol@line`, and the places the cuts start at. */
function called(fact: Trace): { steps: readonly string[]; cuts: readonly string[] } {
  return {
    steps: fact.value.steps.filter(({ at }) => at !== undefined).map(({ file, symbol, at }) => `${file.split("/").at(-1)}:${symbol}@${at!.line}`),
    cuts: (fact.cuts ?? []).map(({ reason, at }) => `${reason} ${at[0]}`),
  };
}

test("a call on super whose superclass the sources do not declare is no step in the class's own method", async () => {
  assert.deepEqual(called(await trace("Forms.java:onSuper")), { steps: [], cuts: [`receiver-unproven ${JAVA}/Forms.java:16 run`] });
});

test("a call on a class literal is no step in a repository homonym", async () => {
  assert.deepEqual(called(await trace("Forms.java:onClassLiteral")), { steps: [], cuts: [`receiver-unproven ${JAVA}/Forms.java:20 getSimpleName`] });
});

test("two calls that start at one place and read differently are a cut, never a step in one of them", async () => {
  assert.deepEqual(called(await trace("Chains.java:differ")), { steps: [], cuts: [`receiver-unproven ${JAVA}/Chains.java:5 get`] });
});

test("two calls that start at one place and read alike keep their step", async () => {
  assert.deepEqual(called(await trace("Chains.java:alike")), { steps: ["Link.java:next@9"], cuts: [] });
});

test("a call on a name keeps its answer: a repository type's static method is a step, a platform type's no cut", async () => {
  assert.deepEqual(called(await trace("Chains.java:names")), { steps: ["Util.java:log@13"], cuts: [] });
});
