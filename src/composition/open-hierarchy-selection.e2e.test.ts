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
 * A Java call on a receiver whose hierarchy the sources leave open is selected where the language rules out every member
 * an unread supertype may declare (ADR-0086): a call without arguments binds to the nearest declaration without
 * parameters up the class chain, and a call through the name of a class whose only unread supertypes are interfaces
 * names a static method of the class chain. `Base` implements `Comparable`, `Item` extends it; `Codes` implements
 * `Comparable` and the repository interface `Parsing`; `Mapper` extends a class outside the sources.
 */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
const JAVA = "src/main/java/com/acme";
const POM = "<project><groupId>com.acme</groupId><artifactId>fx</artifactId></project>\n";
const SOURCES: Readonly<Record<string, string>> = {
  [`${JAVA}/Base.java`]: ["package com.acme;", "", "public class Base implements Comparable<Base> {", "    public String label() {", "        return \"base\";", "    }", "", "    public String find(String key) {", "        return key;", "    }", "", "    public int compareTo(Base other) {", "        return 0;", "    }", "}"].join("\n"),
  [`${JAVA}/Item.java`]: [
    "package com.acme;",
    "",
    "public class Item extends Base {",
    "    @Override",
    "    public String label() {",
    "        return \"item\";",
    "    }",
    "",
    "    public String label(String... parts) {",
    "        return parts[0];",
    "    }",
    "",
    "    private String secret() {",
    "        return \"s\";",
    "    }",
    "}",
  ].join("\n"),
  [`${JAVA}/Named.java`]: ["package com.acme;", "", "public interface Named {", "    String title();", "}"].join("\n"),
  [`${JAVA}/Tagged.java`]: ["package com.acme;", "", "public abstract class Tagged implements Named, Comparable<Tagged> {", "}"].join("\n"),
  [`${JAVA}/Shape.java`]: ["package com.acme;", "", "public interface Shape extends Comparable<Shape> {", "    String area();", "}"].join("\n"),
  [`${JAVA}/Parsing.java`]: ["package com.acme;", "", "public interface Parsing {", "    default String parse(Object raw) {", "        return \"\";", "    }", "}"].join("\n"),
  [`${JAVA}/Codes.java`]: ["package com.acme;", "", "public class Codes implements Parsing, Comparable<Codes> {", "    public static String parse(String raw) {", "        return raw;", "    }", "", "    public int compareTo(Codes other) {", "        return 0;", "    }", "}"].join("\n"),
  [`${JAVA}/Mapper.java`]: ["package com.acme;", "", "import com.lib.AbstractMapper;", "", "public class Mapper extends AbstractMapper {", "    public static String parse(String raw) {", "        return raw;", "    }", "}"].join("\n"),
  [`${JAVA}/Uses.java`]: [
    "package com.acme;",
    "",
    "public class Uses {",
    "    public String byItem(Item item) {",
    "        return item.label();",
    "    }",
    "",
    "    public String byBase(Base base) {",
    "        return base.label();",
    "    }",
    "",
    "    public String byArgument(Item item) {",
    "        return item.find(\"k\");",
    "    }",
    "",
    "    public String byInterfaceMember(Tagged tagged) {",
    "        return tagged.title();",
    "    }",
    "",
    "    public String byInterface(Shape shape) {",
    "        return shape.area();",
    "    }",
    "",
    "    public String byPrivate(Item item) {",
    "        return item.secret();",
    "    }",
    "",
    "    public String byStatic(String raw) {",
    "        return Codes.parse(raw.trim());",
    "    }",
    "",
    "    public String byOpenStatic() {",
    "        return Mapper.parse(\"x\");",
    "    }",
    "}",
  ].join("\n"),
};

let workspace: string;
let repo: string;

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-open-hierarchy-"));
  mkdirSync(join(workspace, "scratch"));
  repo = join(workspace, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: GIT_ENV });
  for (const [path, content] of Object.entries({ "pom.xml": POM, ...SOURCES })) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), `${content}\n`);
  }
  execFileSync("git", ["add", "-A"], { cwd: repo, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repo, env: GIT_ENV });
});

after(() => rmSync(workspace, { recursive: true, force: true }));

type Trace = { status: string; cuts?: readonly Cut[]; value: { steps: readonly { file: string; symbol: string; line: number; depth: number; leaves?: readonly { file: string; symbol: string; start: number }[] }[] } };

async function trace(method: string): Promise<Trace> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })(["trace", repo, `${JAVA}/Uses.java:${method}`], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  return JSON.parse(stdout.join("\n"));
}

/** The declarations a trace reached beyond its root, as `file:line symbol`, steps and leaves alike. */
const reached = (fact: Trace): readonly string[] =>
  fact.value.steps.flatMap((step) => [...(step.depth > 0 ? [`${step.file}:${step.line} ${step.symbol}`] : []), ...(step.leaves ?? []).map((leaf) => `${leaf.file}:${leaf.start} ${leaf.symbol}`)]).sort();
const cuts = (fact: Trace) => (fact.cuts ?? []).map(({ reason, at }) => [reason, at[0]]);

test("a call without arguments binds to the nearest declaration without parameters up the class chain, past a varargs homonym", async () => {
  const fact = await trace("byItem");

  assert.equal(fact.status, "complete", JSON.stringify(fact.cuts));
  assert.deepEqual(reached(fact), [`${JAVA}/Item.java:4 label`]);
});

test("a static call through the name of a class whose only unread supertypes are interfaces is selected among its class chain", async () => {
  const fact = await trace("byStatic");

  assert.equal(fact.status, "complete", JSON.stringify(fact.cuts));
  assert.deepEqual(reached(fact), [`${JAVA}/Codes.java:4 parse`]);
});

test("a call with an argument on an open hierarchy stays unproven: an unread supertype may declare a more specific overload", async () => {
  const fact = await trace("byArgument");

  assert.deepEqual(cuts(fact), [["receiver-unproven", `${JAVA}/Uses.java:13 find`]]);
});

test("a call without arguments whose only declaration belongs to a repository interface stays unproven", async () => {
  const fact = await trace("byInterfaceMember");

  assert.deepEqual(cuts(fact), [["receiver-unproven", `${JAVA}/Uses.java:17 title`]]);
});

test("a call without arguments on a receiver that is an interface stays unproven", async () => {
  const fact = await trace("byInterface");

  assert.deepEqual(cuts(fact), [["receiver-unproven", `${JAVA}/Uses.java:21 area`]]);
});

test("a static call through the name of a class whose superclass the sources do not declare stays unproven", async () => {
  const fact = await trace("byOpenStatic");

  assert.deepEqual(cuts(fact), [["receiver-unproven", `${JAVA}/Uses.java:33 parse`]]);
});

test("a selected call with an overrider below the receiver's type is a dispatch cut, not one settled step", async () => {
  const fact = await trace("byBase");

  assert.deepEqual(cuts(fact), [["dispatch", `${JAVA}/Base.java:4 label`]]);
});

test("a private declaration called outside its class keeps the call unproven", async () => {
  const fact = await trace("byPrivate");

  assert.deepEqual(cuts(fact), [["receiver-unproven", `${JAVA}/Uses.java:25 item.secret`]]);
});
