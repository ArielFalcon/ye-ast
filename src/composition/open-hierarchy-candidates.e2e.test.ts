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

/**
 * Receivers of repository interfaces whose hierarchy only `org.lib.Outside` leaves open. `Items` also extends `Custom`,
 * whose `getById` its call runs, beside the homonym of `Other`. `Courses` declares no `findById`,
 * so its call runs the outside type's member, never the `findById` of `Port` nor of `Adapter`, which implements it.
 */
const sink = (owner: string, header: string) => [header, `        System.out.println("${owner}");`, "        Sink.log();", "        return null;", "    }"];
const SINK = ["package com.acme;", "", "public class Sink {", "    public static void log() {", "        System.out.println(\"sink\");", "    }", "}"].join("\n");
const OUTSIDE = (name: string) => ["package com.acme;", "", "import org.lib.Outside;", "", `public interface ${name} extends Outside<String, Long> {`, "}"].join("\n");
const READS = (field: string, call: string) => ["package com.acme;", "", "public class Reads {", `    private ${field};`, "", "    public Object read(Long id) {", `        return ${call};`, "    }", "}"].join("\n");
const INTERFACE_OPEN: Readonly<Record<string, string>> = {
  [`${JAVA}/Sink.java`]: SINK,
  [`${JAVA}/Custom.java`]: ["package com.acme;", "", "public interface Custom {", ...sink("custom", "    default String getById(Long id, String at) {"), "}"].join("\n"),
  [`${JAVA}/Items.java`]: ["package com.acme;", "", "import org.lib.Outside;", "", "public interface Items extends Outside<String, Long>, Custom {", "}"].join("\n"),
  [`${JAVA}/Other.java`]: ["package com.acme;", "", "public class Other {", ...sink("other", "    public String getById(Long id, String at) {"), "}"].join("\n"),
  [`${JAVA}/Reads.java`]: READS("Items items", "items.getById(id, \"x\")"),
};
const PORT = ["package com.acme;", "", "public interface Port {", "    String findById(Long id);", "}"].join("\n");
const OUTSIDE_MEMBER: Readonly<Record<string, string>> = {
  [`${JAVA}/Sink.java`]: SINK,
  [`${JAVA}/Courses.java`]: OUTSIDE("Courses"),
  [`${JAVA}/Port.java`]: PORT,
  [`${JAVA}/Adapter.java`]: ["package com.acme;", "", "public class Adapter implements Port {", ...sink("adapter", "    public String findById(Long id) {"), "}"].join("\n"),
  [`${JAVA}/Reads.java`]: READS("Courses courses", "courses.findById(id)"),
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
let interfaceOpen: string;
let outsideMember: string;
let outsideMemberAlone: string;

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-open-candidates-"));
  mkdirSync(join(workspace, "scratch"));
  closed = commit("closed", SOURCES);
  unplaced = commit("unplaced", { ...SOURCES, [`${JAVA}/Wiring.java`]: ANONYMOUS });
  mapped = commit("mapped", MAPPED);
  interfaceOpen = commit("interface-open", INTERFACE_OPEN);
  outsideMember = commit("outside-member", OUTSIDE_MEMBER);
  const { [`${JAVA}/Adapter.java`]: _adapter, ...alone } = OUTSIDE_MEMBER;
  outsideMemberAlone = commit("outside-member-alone", alone);
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

/** The cuts whose place is in `Reads.java`, with that place. */
const readsCuts = (fact: Fact) => (fact.cuts ?? []).filter((cut) => cut.at[0]!.startsWith(`${JAVA}/Reads.java`)).map(({ reason, at }) => `${reason} ${at.join(" ")}`);
const readsListed = (fact: Fact) => (fact.value.symbols ?? []).filter((symbol) => symbol.file.endsWith("/Reads.java")).map((symbol) => symbol.symbol).sort();

test("callers of a homonym outside the hierarchy of an interface open only through an outside supertype neither cut nor list the call on it", async () => {
  const fact = await callers(interfaceOpen, "Other.java:getById");

  assert.deepEqual(readsCuts(fact), []);
  assert.deepEqual(readsListed(fact), []);
});

test("callers of a declaration that a call running only an outside supertype's member cannot run neither cut nor list the call", async () => {
  for (const [repo, target] of [[outsideMember, "Adapter.java:findById"], [outsideMember, "Port.java:findById"], [outsideMemberAlone, "Port.java:findById"]] as const) {
    const fact = await callers(repo, target);

    assert.deepEqual(readsCuts(fact), [], target);
    assert.deepEqual(readsListed(fact), [], target);
  }
});
