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
 * A Java call the index does not resolve leaves the `name-only` cut toward a reached homonym that cannot take the number
 * of arguments it writes (ADR-0084). `Fn4.get` takes four and stays attributed for every outside receiver (a lambda
 * implements its functional interface); `Multi.get` takes one or more; `Pair` declares `get` of two and of three.
 * `Calls` writes `get` on outside receivers and on a `var` the pack cannot type.
 */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
const JAVA = "src/main/java/com/acme";
const POM = "<project><groupId>com.acme</groupId><artifactId>fx</artifactId></project>\n";
const GENERATOR_POM = "<project><build><plugins><plugin><groupId>org.openapitools</groupId><artifactId>openapi-generator-maven-plugin</artifactId></plugin></plugins></build></project>\n";
const SOURCES: Readonly<Record<string, string>> = {
  [`${JAVA}/Fn4.java`]: ["package com.acme;", "", "@FunctionalInterface", "public interface Fn4 {", "    String get(String a, String b, String c, String d);", "}"].join("\n"),
  [`${JAVA}/Wiring.java`]: ["package com.acme;", "", "public class Wiring {", "    final Fn4 first = (a, b, c, d) -> a;", "}"].join("\n"),
  [`${JAVA}/Multi.java`]: ["package com.acme;", "", "import java.util.ArrayList;", "", "public class Multi extends ArrayList<String> {", "    public String get(String first, String... rest) {", "        return first;", "    }", "}"].join("\n"),
  [`${JAVA}/Pair.java`]: [
    "package com.acme;",
    "",
    "import java.util.ArrayList;",
    "",
    "public class Pair extends ArrayList<String> {",
    "    public String get(String a, String b) {",
    "        return a;",
    "    }",
    "",
    "    public String get(String a, String b, String c) {",
    "        return c;",
    "    }",
    "}",
  ].join("\n"),
  [`${JAVA}/Calls.java`]: [
    "package com.acme;",
    "",
    "import com.lib.Factory;",
    "import java.util.List;",
    "import java.util.Map;",
    "import java.util.Optional;",
    "",
    "public class Calls {",
    "    public String byList(List<String> list) {",
    "        return list.get(0);",
    "    }",
    "",
    "    public String byOptional(Optional<String> opt) {",
    "        return opt.get();",
    "    }",
    "",
    "    public String byMap(Map<String, String> map, String k) {",
    "        return map.get(k);",
    "    }",
    "",
    "    public String byUntypedFour() {",
    "        var made = Factory.make();",
    "        return made.get(\"a\", \"b\", \"c\", \"d\");",
    "    }",
    "",
    "    public String byUntypedOne() {",
    "        var made = Factory.make();",
    "        return made.get(\"a\");",
    "    }",
    "",
    "    public String byUntypedTwo() {",
    "        var made = Factory.make();",
    "        return made.get(\"a\", \"b\");",
    "    }",
    "",
    "    public String byUntypedThree() {",
    "        var made = Factory.make();",
    "        return made.get(\"a\", \"b\", \"c\");",
    "    }",
    "}",
  ].join("\n"),
};
const at = (line: number): string => `${JAVA}/Calls.java:${line}`;
const OUTSIDE = [at(10), at(14), at(18)];
const UNTYPED = { four: at(23), one: at(28), two: at(33), three: at(38) };

let workspace: string;
const repos = { plain: "", generator: "", rewriting: "" };

function commit(repo: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), `${content}\n`);
  }
  execFileSync("git", ["add", "-A"], { cwd: repo, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repo, env: GIT_ENV });
}

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-argument-count-"));
  mkdirSync(join(workspace, "scratch"));
  const variants = {
    plain: { "pom.xml": POM },
    generator: { "pom.xml": GENERATOR_POM },
    rewriting: { "pom.xml": POM, [`${JAVA}/Ext.java`]: ["package com.acme;", "", "import lombok.experimental.ExtensionMethod;", "", "@ExtensionMethod(Fn4.class)", "public class Ext {", "}"].join("\n") },
  } as const;
  for (const [name, extra] of Object.entries(variants) as [keyof typeof repos, Readonly<Record<string, string>>][]) {
    repos[name] = join(workspace, name);
    mkdirSync(repos[name]);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repos[name], env: GIT_ENV });
    commit(repos[name], { ...extra, ...SOURCES });
  }
});

after(() => rmSync(workspace, { recursive: true, force: true }));

type Answer = { status: string; cuts?: readonly (Cut & { reach?: { declarations?: readonly string[] } })[] };

async function run(args: readonly string[]): Promise<Answer> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })([...args], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  return JSON.parse(stdout.join("\n"));
}

const callers = (targets: readonly string[], repo: keyof typeof repos = "plain") => run(["callers", repos[repo], ...targets.map((target) => `${JAVA}/${target}`)]);
/** The places the `name-only` cuts of an answer leave open toward `declaration`, sorted. */
const openToward = (fact: Answer, declaration: string): readonly string[] =>
  (fact.cuts ?? []).filter((cut) => cut.reason === "name-only" && cut.reach?.declarations?.includes(declaration)).flatMap(({ at: [, ...places] }) => places.map((place) => place.split(" ")[0]!)).sort();

test("a call that writes another count than the four a functional interface's method takes leaves its cut; one of four keeps it", async () => {
  const fact = await callers(["Fn4.java:get"]);

  assert.deepEqual(openToward(fact, `${JAVA}/Fn4.java::get`), [UNTYPED.four]);
});

test("a variable-arity method keeps the cut of every count from its fixed parameters up and loses it below", async () => {
  const fact = await callers(["Multi.java:get"]);

  assert.deepEqual(openToward(fact, `${JAVA}/Multi.java::get`), [...OUTSIDE.filter((place) => place !== at(14)), UNTYPED.four, UNTYPED.one, UNTYPED.two, UNTYPED.three].sort());
});

test("of two overloads, which share one anchor, a call keeps its cut while one of them takes its count", async () => {
  const fact = await callers(["Pair.java:6-8", "Pair.java:10-12"]);

  const open = (fact.cuts ?? []).filter((cut) => cut.reason === "name-only").flatMap(({ at: [, ...places] }) => places.map((place) => place.split(" ")[0]!)).sort();
  assert.deepEqual(open, [UNTYPED.two, UNTYPED.three]);
});

test("a declared source generator leaves the counts as the sources state them", async () => {
  const fact = await callers(["Fn4.java:get"], "generator");

  assert.deepEqual(openToward(fact, `${JAVA}/Fn4.java::get`), [UNTYPED.four]);
});

test("a call-rewriting annotation proves no count: every call keeps its cut", async () => {
  const fact = await callers(["Fn4.java:get"], "rewriting");

  assert.deepEqual(openToward(fact, `${JAVA}/Fn4.java::get`), [...OUTSIDE, UNTYPED.four, UNTYPED.one, UNTYPED.two, UNTYPED.three].sort());
});
