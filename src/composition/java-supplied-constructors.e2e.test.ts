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
 * A construction of a repository type whose constructor the language supplies (a record's canonical constructor, the
 * default constructor of a class that writes none) runs what the sources prove: nothing of the repository, or the class
 * walked as that construction, down to the superclass constructor its implicit `super()` reaches. A constructor a
 * processor may add stays a cut.
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

async function run(args: readonly string[]): Promise<{ status: string; cuts?: readonly Cut[]; value: TraceValue }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })([...args], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  return JSON.parse(stdout.join("\n"));
}

const trace = (target: string) => run(["trace", repo, `${JAVA}/${target}`]);

/** The cuts of a trace by reason and the place they cut. */
const cutsOf = (fact: { cuts?: readonly Cut[] }) => (fact.cuts ?? []).map((cut) => [cut.reason, cut.at[0]]);

/** Every declaration a trace reaches, expanded or as a leaf, by file and name. */
const reached = (fact: { value: TraceValue }) => fact.value.steps.flatMap((step) => [`${step.file}:${step.symbol}`, ...(step.leaves ?? []).map((leaf) => `${leaf.file}:${leaf.symbol}`)]);

function use(body: string): Record<string, string> {
  return { [`${JAVA}/Use.java`]: `package com.acme;\n\nimport java.util.function.Supplier;\n\npublic class Use {\n  public Object run() {\n${body}\n  }\n}\n` };
}

test("a record's canonical constructor, a class's default constructor and T::new that no source writes run no repository code, and the answer is complete", async () => {
  commit({
    [`${JAVA}/Point.java`]: "package com.acme;\n\npublic record Point(int x, int y) {\n  public int sum() {\n    return x + y;\n  }\n}\n",
    [`${JAVA}/Missing.java`]: "package com.acme;\n\npublic class Missing extends RuntimeException {\n}\n",
    [`${JAVA}/Plain.java`]: "package com.acme;\n\npublic class Plain {\n  private int seed = 0;\n\n  public int one() {\n    return 1;\n  }\n}\n",
    ...use("    Point p = new Point(1, 2);\n    Plain plain = new Plain();\n    Supplier<Missing> s = Missing::new;\n    return plain.one() + p.x();"),
  });

  const fact = await trace("Use.java:run");

  assert.deepEqual([fact.status, cutsOf(fact)], ["complete", []]);
  assert.ok(reached(fact).includes(`${JAVA}/Plain.java:one`));
  assert.deepEqual(fact.value.steps.filter((step) => step.kind === "class").map((step) => step.symbol), []);
});

test("a construction of a type outside the repository keeps its cut", async () => {
  commit(use('    throw new IllegalArgumentException("x");'));

  const fact = await trace("Use.java:run");

  assert.deepEqual(cutsOf(fact), [["callee-unknown", `${JAVA}/Use.java:7 IllegalArgumentException`]]);
});

test("a compact canonical constructor is a written body, so a construction is never settled as supplied", async () => {
  commit({
    [`${JAVA}/Range.java`]: "package com.acme;\n\npublic record Range(int lo, int hi) {\n  public Range {\n    Check.count();\n  }\n}\n",
    ...use("    return new Range(1, 2);"),
  });

  const fact = await trace("Use.java:run");

  assert.deepEqual(cutsOf(fact), [["callee-unknown", `${JAVA}/Use.java:7 Range`]]);
});

test("the default constructor of a class runs the body of the constructor its superclass in the repository writes", async () => {
  commit({
    [`${JAVA}/Base.java`]: "package com.acme;\n\npublic class Base {\n  public Base() {\n    Check.count();\n  }\n}\n",
    [`${JAVA}/Sub.java`]: "package com.acme;\n\npublic class Sub extends Base {\n}\n",
    ...use("    Supplier<Sub> later = Sub::new;\n    return new Sub();"),
  });

  const fact = await trace("Use.java:run");

  assert.deepEqual([fact.status, cutsOf(fact)], ["complete", []]);
  assert.deepEqual(fact.value.steps.filter((step) => step.symbol === "Sub" || step.symbol === "Base").map((step) => [step.symbol, step.kind, step.line, step.via, step.at]), [
    ["Sub", "class", 3, "reference", { line: 7, column: 27 }],
    ["Base", "method", 4, "call", { line: 3 }],
    ["Sub", "class", 3, "call", { line: 8, column: 12 }],
  ]);
  assert.ok(reached(fact).includes(`${JAVA}/Check.java:count`));
});

test("a supplied constructor of a class with an annotation by which a processor may add a constructor stays a cut", async () => {
  commit({ [`${JAVA}/Holder.java`]: "package com.acme;\n\nimport lombok.NoArgsConstructor;\n\n@NoArgsConstructor\npublic class Holder {\n  private final int n = Check.count();\n}\n", ...use("    return new Holder();") });

  const fact = await trace("Use.java:run");

  assert.equal(fact.status, "partial");
  assert.deepEqual(cutsOf(fact), [["constructor-unsettled", `${JAVA}/Use.java:7 Holder`]]);
});
