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
 * A Java call on `super` is read in the direct superclass of the type `this` denotes there and runs without dispatch
 * (ADR-0087 decisions 4 and 5): a repository superclass names the member it selects, a superclass outside the repository
 * names none, and the reverse families follow the call to the selected member alone. A class literal is a receiver
 * outside the repository (decision 3).
 */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
const JAVA = "src/main/java/com/acme";
const SOURCES: Readonly<Record<string, string>> = {
  "pom.xml": "<project><groupId>com.acme</groupId><artifactId>fx</artifactId></project>",
  [`${JAVA}/Parent.java`]: ["package com.acme;", "", "public class Parent {", "    public void pRun() {", "        System.out.println(\"parent\");", "    }", "}"].join("\n"),
  [`${JAVA}/Child.java`]: [
    "package com.acme;",
    "",
    "public class Child extends Parent {",
    "    @Override",
    "    public void pRun() {",
    "        System.out.println(\"child\");",
    "    }",
    "",
    "    void callsSuper() {",
    "        super.pRun();",
    "    }",
    "",
    "    void virtual(Parent p) {",
    "        p.pRun();",
    "    }",
    "",
    "    void superThenVirtual(Parent p) {",
    "        super.pRun();",
    "        p.pRun();",
    "    }",
    "}",
  ].join("\n"),
  [`${JAVA}/Builder.java`]: [
    "package com.acme;",
    "",
    "public class Builder extends Parent {",
    "    public Builder() {",
    "        super.pRun();",
    "    }",
    "}",
  ].join("\n"),
  [`${JAVA}/Forms.java`]: [
    "package com.acme;",
    "",
    "import com.lib.Base;",
    "",
    "public class Forms extends Base {",
    "    void bRun() {",
    "        System.out.println(\"forms\");",
    "    }",
    "",
    "    void onSuper() {",
    "        super.bRun();",
    "    }",
    "}",
  ].join("\n"),
  [`${JAVA}/Mid.java`]: [
    "package com.acme;",
    "",
    "public class Mid extends com.lib.Base {",
    "    public void m() {",
    "        System.out.println(\"none\");",
    "    }",
    "",
    "    public void m(int a) {",
    "        System.out.println(\"one\");",
    "    }",
    "}",
  ].join("\n"),
  [`${JAVA}/Leaf.java`]: [
    "package com.acme;",
    "",
    "public class Leaf extends Mid {",
    "    @Override",
    "    public void m() {",
    "        System.out.println(\"leaf\");",
    "    }",
    "",
    "    void callOpen() {",
    "        super.m();",
    "        super.m(1);",
    "    }",
    "}",
  ].join("\n"),
  [`${JAVA}/Task.java`]: ["package com.acme;", "", "public class Task {", "    public void go() {", "        System.out.println(\"task\");", "    }", "}"].join("\n"),
  [`${JAVA}/Holder.java`]: [
    "package com.acme;",
    "",
    "public class Holder {",
    "    public void go() {",
    "        System.out.println(\"holder\");",
    "    }",
    "",
    "    Task make() {",
    "        return new Task() {",
    "            @Override",
    "            public void go() {",
    "                super.go();",
    "            }",
    "        };",
    "    }",
    "}",
  ].join("\n"),
  [`${JAVA}/Named.java`]: ["package com.acme;", "", "public class Named {", "    public String getSimpleName() {", "        System.out.println(\"named\");", "        return \"named\";", "    }", "}"].join("\n"),
  [`${JAVA}/Literal.java`]: ["package com.acme;", "", "public class Literal {", "    String name() {", "        return Named.class.getSimpleName();", "    }", "}"].join("\n"),
};

let workspace: string;
let repo: string;

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-super-call-"));
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

/** The steps below the root, as `file:symbol@line`, and each cut as its reason and the place it starts at. */
async function trace(target: string): Promise<{ steps: readonly string[]; cuts: readonly string[] }> {
  const fact = await run(["trace", repo, `${JAVA}/${target}`]);
  const { steps } = fact.value as { steps: readonly { file: string; symbol: string; at?: { line: number } }[] };
  return {
    steps: steps.filter(({ at }) => at !== undefined).map(({ file, symbol, at }) => `${file.split("/").at(-1)}:${symbol}@${at!.line}`),
    cuts: (fact.cuts ?? []).map(({ reason, at }) => `${reason} ${at[0]}`),
  };
}

/** The status, the declarations reached through anything but containment, and the places the cuts start at. */
async function callers(target: string): Promise<{ status: string; callers: readonly string[]; cuts: readonly string[] }> {
  const fact = await run(["callers", repo, `${JAVA}/${target}`]);
  const { symbols } = fact.value as { symbols: readonly { symbol: string; via?: { basis: string } }[] };
  return { status: fact.status, callers: symbols.filter(({ via }) => via !== undefined && via.basis !== "contains").map(({ symbol }) => symbol).sort(), cuts: (fact.cuts ?? []).map(({ reason, at }) => `${reason} ${at[0]}`) };
}

test("a call on super is a step in the superclass's method, with no dispatch below it although the class overrides it", async () => {
  assert.deepEqual(await trace("Child.java:callsSuper"), { steps: ["Parent.java:pRun@10"], cuts: [] });
});

test("an ordinary call on a declared receiver keeps its dispatch, also after a call on super reached the same method", async () => {
  const dispatch = `dispatch ${JAVA}/Parent.java:4 pRun`;
  assert.deepEqual(await trace("Child.java:virtual"), { steps: ["Parent.java:pRun@14"], cuts: [dispatch] });
  assert.deepEqual(await trace("Child.java:superThenVirtual"), { steps: ["Parent.java:pRun@18", "Parent.java:pRun@19"], cuts: [dispatch] });
});

test("callers of the superclass's method list the method that calls it on super", async () => {
  const fact = await callers("Parent.java:pRun");

  assert.equal(fact.status, "complete", JSON.stringify(fact.cuts));
  assert.ok(fact.callers.includes("callsSuper") && fact.callers.includes("Builder"), JSON.stringify(fact.callers));
});

test("a call on super whose superclass is outside the repository names no repository method, and is no caller of the class's own", async () => {
  assert.deepEqual(await trace("Forms.java:onSuper"), { steps: [], cuts: [`receiver-unproven ${JAVA}/Forms.java:11 bRun`] });
  const fact = await callers("Forms.java:bRun");
  assert.deepEqual(fact, { status: "complete", callers: [], cuts: [] });
});

test("a call on super under an open hierarchy is selected by the class chain without arguments, and unproven with them", async () => {
  assert.deepEqual(await trace("Leaf.java:callOpen"), { steps: ["Mid.java:m@10"], cuts: [`receiver-unproven ${JAVA}/Leaf.java:11 m`] });
});

test("a call on super inside an anonymous class of a repository class is read in that class", async () => {
  assert.deepEqual(await trace("Holder.java:12-12"), { steps: ["Task.java:go@12"], cuts: [] });
});

test("callers of a repository homonym of a class literal's member neither list the call nor cut it", async () => {
  const fact = await callers("Named.java:getSimpleName");

  assert.equal(fact.status, "complete", JSON.stringify(fact.cuts));
  assert.ok(!fact.callers.includes("name"), JSON.stringify(fact.callers));
});
