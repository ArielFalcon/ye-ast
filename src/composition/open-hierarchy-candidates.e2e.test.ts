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
 * A Java call with arguments on a repository class whose hierarchy only a type outside the repository leaves open is
 * unproven among the declarations of its name and arity at, above and below that class (ADR-0089 decision 2): `Problem`
 * extends `Exception`, `Detailed` overrides its `setCode`, and `Unrelated` declares a homonym. The call writes its
 * receiver as a call, which the index leaves without a target.
 */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
const JAVA = "src/main/java/com/acme";
const POM = "<project><groupId>com.acme</groupId><artifactId>fx</artifactId></project>\n";
const callee = (owner: string, method: string, parameters = "String code") => [`    public void ${method}(${parameters}) {`, `        System.out.println("${owner}");`, "    }"];
const SOURCES: Readonly<Record<string, string>> = {
  [`${JAVA}/Problem.java`]: ["package com.acme;", "", "public class Problem extends Exception {", ...callee("problem", "setCode"), "", ...callee("problem", "describe", ""), "}"].join("\n"),
  [`${JAVA}/Detailed.java`]: ["package com.acme;", "", "public class Detailed extends Problem {", "    @Override", ...callee("detailed", "setCode"), "}"].join("\n"),
  [`${JAVA}/Unrelated.java`]: ["package com.acme;", "", "public class Unrelated {", ...callee("unrelated", "setCode"), "}"].join("\n"),
  [`${JAVA}/Uses.java`]: [
    "package com.acme;",
    "",
    "public class Uses {",
    "    public void coded(String value) {",
    "        make().setCode(value);",
    "    }",
    "",
    "    public void described() {",
    "        make().describe();",
    "    }",
    "",
    "    public void untyped(String value) {",
    "        this.<Problem>any().setCode(value);",
    "    }",
    "",
    "    private Problem make() {",
    "        return new Problem();",
    "    }",
    "",
    "    private <T> T any() {",
    "        return null;",
    "    }",
    "}",
  ].join("\n"),
};
/** A class of the repository the project does not place, below `Problem`, whose override a call on `Problem` may run. */
const ANONYMOUS = ["package com.acme;", "", "public class Wiring {", "    public Problem wired() {", "        return new Problem() {", ...callee("wired", "setCode").map((line) => `    ${line}`), "        };", "    }", "}"].join("\n");

/**
 * A generic interface `Mapper` implemented by `Plain` and `Other` with concrete type arguments; a call on a field typed
 * `Plain` whose argument's type the reading does not settle binds to `Plain`'s method, which implements the interface's.
 */
const MAPPED: Readonly<Record<string, string>> = {
  [`${JAVA}/Mapper.java`]: ["package com.acme;", "", "public interface Mapper<S, T> {", "    T convert(S source);", "}"].join("\n"),
  [`${JAVA}/Plain.java`]: ["package com.acme;", "", "public class Plain implements Mapper<String, String> {", "    public String convert(String source) {", "        System.out.println(\"plain\");", "        return source;", "    }", "}"].join("\n"),
  [`${JAVA}/Other.java`]: ["package com.acme;", "", "public class Other implements Mapper<Integer, String> {", "    public String convert(Integer source) {", "        System.out.println(\"other\");", "        return \"\";", "    }", "}"].join("\n"),
  [`${JAVA}/Uses.java`]: ["package com.acme;", "", "public class Uses {", "    private Plain plain;", "", "    public void mapped() {", "        plain.convert(System.getenv(\"x\"));", "    }", "}"].join("\n"),
};

let workspace: string;

function commit(name: string, files: Readonly<Record<string, string>>): string {
  const repo = join(workspace, name);
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: GIT_ENV });
  for (const [path, content] of Object.entries({ "pom.xml": POM, ...files })) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), `${content}\n`);
  }
  execFileSync("git", ["add", "-A"], { cwd: repo, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repo, env: GIT_ENV });
  return repo;
}

let closed: string;
let unplaced: string;
let mapped: string;

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-open-candidates-"));
  mkdirSync(join(workspace, "scratch"));
  closed = commit("closed", SOURCES);
  unplaced = commit("unplaced", { ...SOURCES, [`${JAVA}/Wiring.java`]: ANONYMOUS });
  mapped = commit("mapped", MAPPED);
});

after(() => rmSync(workspace, { recursive: true, force: true }));

type Fact = { status: string; cuts?: readonly Cut[]; value: { steps?: readonly { file: string; symbol: string; line: number; depth: number }[]; symbols?: readonly { file: string; symbol: string; depth: number }[] } };

async function run(args: readonly string[]): Promise<Fact> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })([...args], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  return JSON.parse(stdout.join("\n"));
}

const trace = (repo: string, method: string) => run(["trace", repo, `${JAVA}/Uses.java:${method}`]);
const callers = (repo: string, target: string) => run(["callers", repo, `${JAVA}/${target}`]);
/** The declarations a cut lists past its place, by file. */
const listed = (cut: Cut) => cut.at.slice(1).map((anchor) => anchor.split(":")[0]!.split("/").at(-1)).sort();
const cutsAt = (fact: Fact, place: string) => (fact.cuts ?? []).filter((cut) => cut.at.includes(place));

test("a call with an argument on a class open only through an outside superclass lists the declarations of its hierarchy, an override below included, and no homonym", async () => {
  const fact = await trace(closed, "coded");

  assert.deepEqual((fact.cuts ?? []).map(({ reason }) => reason), ["receiver-unproven"]);
  assert.deepEqual(listed(fact.cuts![0]!), ["Detailed.java", "Problem.java"]);
});

test("callers of a homonym outside the receiver's hierarchy leave the call, and callers of a declaration of it mark the call as a hidden caller", async () => {
  const place = `${JAVA}/Uses.java:5 make().setCode`;
  const unrelated = await callers(closed, "Unrelated.java:setCode");
  const problem = await callers(closed, "Problem.java:setCode");
  const detailed = await callers(closed, "Detailed.java:setCode");

  assert.deepEqual(cutsAt(unrelated, place), []);
  assert.deepEqual(cutsAt(unrelated, `${JAVA}/Uses.java:13 this.any().setCode`).map(({ reason }) => reason), ["name-only"]);
  assert.deepEqual(cutsAt(problem, place).map(({ reason }) => reason), ["hidden-caller", "hidden-caller"]);
  assert.deepEqual(cutsAt(detailed, place).map(({ reason }) => reason), ["hidden-caller", "hidden-caller"]);
});

test("a class the project does not place below the receiver's type, or a receiver whose type the reading does not resolve, lists every homonym", async () => {
  const anonymous = await trace(unplaced, "coded");
  const untyped = await trace(closed, "untyped");

  for (const fact of [anonymous, untyped]) assert.ok(listed(fact.cuts![0]!).includes("Unrelated.java"), JSON.stringify(fact.cuts));
});

test("a call without arguments the class chain selects under the open hierarchy keeps its step", async () => {
  const fact = await trace(closed, "described");

  assert.equal(fact.status, "complete", JSON.stringify(fact.cuts));
  assert.deepEqual(fact.value.steps!.filter((step) => step.depth > 0).map((step) => `${step.file}:${step.line} ${step.symbol}`), [`${JAVA}/Problem.java:8 describe`]);
});

test("callers of an implementation that reach the generic interface method leave a call on another concrete implementing class to that class's method, without a hidden caller", async () => {
  const other = await callers(mapped, "Other.java:convert");
  const plain = await callers(mapped, "Plain.java:convert");
  const symbols = (fact: Fact) => (fact.value.symbols ?? []).map(({ file, symbol }) => `${file.split("/").at(-1)} ${symbol}`);

  assert.equal(other.status, "complete", JSON.stringify(other.cuts));
  assert.ok(symbols(other).includes("Mapper.java convert") && !symbols(other).includes("Uses.java mapped"), JSON.stringify(other.value.symbols));
  assert.ok(symbols(plain).includes("Uses.java mapped"), JSON.stringify(plain.value.symbols));
});
