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

/**
 * A construction, written or as a constructor reference, whose type the strict Java reading proves a platform type is
 * an external call of the trace, as a call to a member of that type is; where the reading proves nothing, the cut stays.
 */

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const JAVA = "src/main/java/com/acme";
const POM = { "pom.xml": "<project><groupId>com.acme</groupId><artifactId>shop</artifactId></project>\n" };
const CHECK = { [`${JAVA}/Check.java`]: "package com.acme;\n\npublic class Check {\n  public static int count() {\n    return 1;\n  }\n}\n" };

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
  for (const [path, content] of Object.entries({ ...POM, ...CHECK, ...files })) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  execFileSync("git", ["add", "-A"], { cwd: repo, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repo, env: GIT_ENV });
}

async function trace(target: string): Promise<{ status: string; cuts?: readonly Cut[]; value: TraceValue }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })(["trace", repo, `${JAVA}/${target}`], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  return JSON.parse(stdout.join("\n"));
}

/** The cuts of a trace by reason and the place they cut. */
const cutsOf = (fact: { cuts?: readonly Cut[] }) => (fact.cuts ?? []).map((cut) => [cut.reason, cut.at[0]]);

/** The external calls of the root step, by module and name. */
const externalOf = (fact: { value: TraceValue }) => (fact.value.steps[0]!.external ?? []).flatMap((call) => call.names.map((name) => ("module" in call ? `${call.module}:${name}` : `${call.kind}:${name}`)));

function use(body: string, imports = "", heritage = ""): Record<string, string> {
  return { [`${JAVA}/Use.java`]: `package com.acme;\n\n${imports}import java.util.function.Function;\nimport java.util.function.Supplier;\n\npublic class Use${heritage} {\n  public Object run(java.util.List<Object> list) {\n${body}\n  }\n}\n` };
}

const RED = [
  "    Supplier<Object> made = ArrayList::new;",
  "    Object fresh = new ArrayList<String>();",
  '    throw new IllegalArgumentException("x");',
].join("\n");

test("a construction and a constructor reference of a type java.lang or a single-type platform import names are external calls, and the answer is complete", async () => {
  commit(use(RED, "import java.util.ArrayList;\n"));

  const fact = await trace("Use.java:run");

  assert.deepEqual([fact.status, cutsOf(fact)], ["complete", []]);
  assert.deepEqual(externalOf(fact), ["java.lang:IllegalArgumentException", "java.util:ArrayList"]);
  assert.deepEqual(fact.value.steps.map((step) => step.symbol), ["run"]);
});

test("a reference to a member of a platform type keeps its cut, since an instance member may run an override the repository writes", async () => {
  commit({
    [`${JAVA}/Loud.java`]: "package com.acme;\n\npublic class Loud extends java.io.PrintStream {\n  public Loud() {\n    super(new java.io.ByteArrayOutputStream());\n  }\n\n  @Override\n  public void println(Object value) {\n    Check.count();\n  }\n}\n",
    ...use("    list.forEach(System.out::println);\n    Function<Object, String> text = Object::toString;\n    return text;"),
  });

  const fact = await trace("Use.java:run");

  assert.equal(fact.status, "partial");
  assert.deepEqual(cutsOf(fact).map(([, place]) => place).sort(), [`${JAVA}/Use.java:8 println`, `${JAVA}/Use.java:9 toString`]);
});

test("a construction of a type no import, package or platform names keeps its cut", async () => {
  commit(use("    return new Mystery();\n  }\n\n  public Object library() {\n    return new LibThing();", "import org.lib.LibThing;\n"));

  const [unknown, library] = await Promise.all([trace("Use.java:run"), trace("Use.java:library")]);

  assert.deepEqual(cutsOf(unknown), [["callee-unknown", `${JAVA}/Use.java:9 Mystery`]]);
  assert.deepEqual(cutsOf(library), [["callee-unknown", `${JAVA}/Use.java:13 LibThing`]]);
});

test("a repository type of the package named like a java.lang type is constructed as the repository's, never as an external call", async () => {
  commit({ [`${JAVA}/IllegalStateException.java`]: "package com.acme;\n\npublic class IllegalStateException {\n  public IllegalStateException() {\n    Check.count();\n  }\n}\n", ...use("    return new IllegalStateException();") });

  const fact = await trace("Use.java:run");

  assert.deepEqual(externalOf(fact), []);
  assert.ok(fact.value.steps.some((step) => step.file === `${JAVA}/IllegalStateException.java` && step.symbol === "IllegalStateException"));
});

test("an anonymous class written at a construction of a platform type is repository code and keeps its cut", async () => {
  commit(use("    return new Runnable() {\n      public void run() {\n        Check.count();\n      }\n    };"));

  const fact = await trace("Use.java:run");

  assert.deepEqual([fact.status, cutsOf(fact), externalOf(fact)], ["partial", [["receiver-unproven", `${JAVA}/Use.java:10 count`], ["callee-unknown", `${JAVA}/Use.java:8 Runnable`]], []]);
});

test("a construction of a java.lang type keeps its cut while a JVM source no reader reads may declare a type of its package", async () => {
  commit({ "src/main/kotlin/com/acme/Other.kt": "package com.acme\n\nclass Other\n", ...use('    throw new IllegalArgumentException("x");') });

  const fact = await trace("Use.java:run");

  assert.deepEqual(cutsOf(fact), [["callee-unknown", `${JAVA}/Use.java:8 IllegalArgumentException`], ["language", "src/main/kotlin/com/acme/Other.kt"]]);
});

test("a construction of a java.lang type keeps its cut below a superclass outside the repository, which may declare a member type of its name", async () => {
  commit(use('    throw new IllegalArgumentException("x");', "import org.lib.LibBase;\n", " extends LibBase"));

  const fact = await trace("Use.java:run");

  assert.deepEqual(cutsOf(fact), [["callee-unknown", `${JAVA}/Use.java:9 IllegalArgumentException`]]);
});
