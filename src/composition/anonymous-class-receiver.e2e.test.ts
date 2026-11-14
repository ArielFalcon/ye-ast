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
 * A Java call without a receiver searches the innermost class around it whose members, declared or inherited, include the
 * name (JLS 15.12.1). An anonymous or a local class inherits its supertypes' members: one whose hierarchy the sources do
 * not settle may hold the name, so the call is unproven; a repository supertype whose closed hierarchy lacks the name sends
 * the search to the class around it; one that declares the name is the type searched; the class's own method of the name
 * keeps the call. `Outer` writes `foo()` in each shape.
 */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
const JAVA = "src/main/java/com/acme";
const SOURCES: Readonly<Record<string, string>> = {
  "pom.xml": "<project><groupId>com.acme</groupId><artifactId>fx</artifactId></project>",
  [`${JAVA}/Closed.java`]: ["package com.acme;", "", "public abstract class Closed {", "    public abstract void go();", "}"].join("\n"),
  [`${JAVA}/Declares.java`]: ["package com.acme;", "", "public abstract class Declares {", "    public abstract void go();", "", "    void foo() {}", "}"].join("\n"),
  [`${JAVA}/Half.java`]: ["package com.acme;", "", "public abstract class Half extends com.lib.Base {", "    public abstract void go();", "}"].join("\n"),
  [`${JAVA}/Kind.java`]: ["package com.acme;", "", "public enum Kind {", "    A {", "        void run() { foo(); }", "    };", "", "    void run() {}", "", "    void foo() {}", "}"].join("\n"),
  [`${JAVA}/Outer.java`]: [
    "package com.acme;",
    "",
    "import com.lib.Task;",
    "",
    "public class Outer {",
    "    void foo() {}",
    "",
    "    void unread() {",
    "        Task t = new Task() {",
    "            public void go() { foo(); }",
    "        };",
    "    }",
    "",
    "    void local() {",
    "        class Local extends Task {",
    "            void go() { foo(); }",
    "        }",
    "    }",
    "",
    "    void closed() {",
    "        Closed c = new Closed() {",
    "            public void go() {",
    "                Closed d = new Closed() {",
    "                    public void go() { foo(); }",
    "                };",
    "            }",
    "        };",
    "    }",
    "",
    "    void memberless() {",
    "        class Plain implements java.io.Serializable {",
    "            void go() { foo(); }",
    "        }",
    "    }",
    "",
    "    void half() {",
    "        Half h = new Half() {",
    "            public void go() { foo(); }",
    "        };",
    "    }",
    "",
    "    void own() {",
    "        Closed c = new Closed() {",
    "            public void go() { foo(); }",
    "",
    "            void foo() {}",
    "        };",
    "    }",
    "",
    "    void declares() {",
    "        Declares d = new Declares() {",
    "            public void go() { foo(); }",
    "        };",
    "    }",
    "}",
  ].join("\n"),
};

let workspace: string;
let repo: string;

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-anonymous-receiver-"));
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

interface Step {
  line: number;
  leaves?: readonly { file: string; start: number }[];
}

async function run(args: readonly string[]): Promise<{ status: string; cuts?: readonly Cut[]; value: { steps?: readonly Step[]; symbols?: readonly { file: string; symbol: string; line: number }[] } }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })([...args], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  return JSON.parse(stdout.join("\n"));
}

const trace = (file: string, line: number) => run(["trace", repo, `${JAVA}/${file}:${line}-${line}`]);
/** The leaves of the traced line's step, as `file:start`. */
const leavesAt = (fact: Awaited<ReturnType<typeof run>>, line: number) => (fact.value.steps ?? []).filter((step) => step.line === line).flatMap((step) => (step.leaves ?? []).map((leaf) => `${leaf.file}:${leaf.start}`));

test("a call without a receiver in an anonymous or a local class whose supertype's members the sources do not settle is unproven", async () => {
  for (const line of [10, 16, 38]) {
    const fact = await trace("Outer.java", line);

    assert.equal(fact.status, "partial");
    assert.deepEqual(fact.cuts?.map(({ reason, at }) => [reason, at[0]]), [["receiver-unproven", `${JAVA}/Outer.java:${line} foo`]]);
  }
});

test("a supertype whose closed hierarchy lacks the name sends the search to the class around it, through nested classes", async () => {
  for (const line of [24, 32]) {
    const fact = await trace("Outer.java", line);

    assert.equal(fact.status, "complete", JSON.stringify(fact.cuts));
    assert.deepEqual(leavesAt(fact, line), [`${JAVA}/Outer.java:6`]);
  }
});

test("a supertype that declares the name is the type the call searches", async () => {
  const fact = await trace("Outer.java", 52);

  assert.equal(fact.status, "complete", JSON.stringify(fact.cuts));
  assert.deepEqual(leavesAt(fact, 52), [`${JAVA}/Declares.java:6`]);
});

test("an anonymous class declaring the one method of the name keeps the call on its own method", async () => {
  const fact = await trace("Outer.java", 44);

  assert.equal(fact.status, "complete", JSON.stringify(fact.cuts));
  assert.deepEqual(leavesAt(fact, 44), [`${JAVA}/Outer.java:46`]);
});

test("callers of the supertype's declaration list the anonymous class's method", async () => {
  const fact = await run(["callers", repo, `${JAVA}/Declares.java:foo`]);

  assert.equal(fact.status, "complete", JSON.stringify(fact.cuts));
  assert.ok(fact.value.symbols?.some((symbol) => symbol.file === `${JAVA}/Outer.java` && symbol.symbol === "go" && symbol.line === 52), JSON.stringify(fact.value.symbols));
});

test("an enum constant's body searches its enum", async () => {
  const fact = await trace("Kind.java", 5);

  assert.equal(fact.status, "complete", JSON.stringify(fact.cuts));
  assert.deepEqual(leavesAt(fact, 5), [`${JAVA}/Kind.java:10`]);
});
