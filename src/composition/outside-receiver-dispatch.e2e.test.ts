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
 * A Java call on a receiver whose declared type lies outside the repository (ADR-0079 U2) keeps its `name-only` cut only
 * toward the reached declarations a value of that type may run: none for a plain class, every one whose owner or a type
 * below it has a supertype outside the repository (`MyMap`, an enum, a record), every instance method for
 * `java.lang.Object`, and every one while a build file declares a source generator. `Service` calls `get` on a parameter, an `Optional`, a
 * repository method's declared return, a field, a local and a type-variable bound; `More` on a library type.
 */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
const JAVA = "src/main/java/com/acme";
const POM = "<project><groupId>com.acme</groupId><artifactId>fx</artifactId></project>\n";
const GENERATOR_POM = "<project><build><plugins><plugin><groupId>org.openapitools</groupId><artifactId>openapi-generator-maven-plugin</artifactId></plugin></plugins></build></project>\n";
const SOURCES: Readonly<Record<string, string>> = {
  [`${JAVA}/Api.java`]: ["package com.acme;", "", "public class Api {", "    public String get(String key) {", "        return key;", "    }", "", "    public boolean equals(Object other) {", "        return other == this;", "    }", "}"].join("\n"),
  [`${JAVA}/MyMap.java`]: ["package com.acme;", "", "import java.util.HashMap;", "", "public class MyMap extends HashMap<String, String> {", "    @Override", "    public String get(Object key) {", "        return \"\";", "    }", "}"].join("\n"),
  [`${JAVA}/Registry.java`]: ["package com.acme;", "", "import java.util.HashMap;", "", "public class Registry extends HashMap<String, String> {", "    public static int size(String key) {", "        return 0;", "    }", "}"].join("\n"),
  [`${JAVA}/Kind.java`]: ["package com.acme;", "", "public enum Kind {", "    A;", "", "    public String get(String key) {", "        return key;", "    }", "}"].join("\n"),
  [`${JAVA}/Rec.java`]: ["package com.acme;", "", "public record Rec(String value) {", "    public String get(String key) {", "        return value;", "    }", "}"].join("\n"),
  [`${JAVA}/Holder.java`]: ["package com.acme;", "", "import java.util.Map;", "", "public class Holder {", "    public Map<String, String> values() {", "        return Map.of();", "    }", "}"].join("\n"),
  [`${JAVA}/Service.java`]: [
    "package com.acme;",
    "",
    "import java.util.Map;",
    "import java.util.Optional;",
    "",
    "public class Service {",
    "    private final Map<String, String> cache = Map.of();",
    "",
    "    public String byMap(Map<String, String> map, String k) {",
    "        return map.get(k);",
    "    }",
    "",
    "    public String byOptional(Optional<String> opt) {",
    "        return opt.get();",
    "    }",
    "",
    "    public String byReturn(Holder holder, String k) {",
    "        return holder.values().get(k);",
    "    }",
    "",
    "    public String byField(String k) {",
    "        return cache.get(k);",
    "    }",
    "",
    "    public String byLocal(String k) {",
    "        Map<String, String> local = Map.of();",
    "        return local.get(k);",
    "    }",
    "",
    "    public <M extends Map<String, String>> String byBound(M bound, String k) {",
    "        return bound.get(k);",
    "    }",
    "",
    "    public boolean byObject(Object o, Object k) {",
    "        return o.equals(k);",
    "    }",
    "",
    "    public boolean byMapEquals(Map<String, String> map, Object k) {",
    "        return map.equals(k);",
    "    }",
    "",
    "    public int bySize(Map<String, String> map) {",
    "        return map.size();",
    "    }",
    "}",
  ].join("\n"),
  [`${JAVA}/Entity.java`]: ["package com.acme;", "", "import java.io.Serializable;", "", "public class Entity implements Serializable {", "    public String toString() {", "        return \"e\";", "    }", "}"].join("\n"),
  [`${JAVA}/Ids.java`]: ["package com.acme;", "", "import java.io.Serializable;", "", "public class Ids {", "    public String text(Serializable id) {", "        return id.toString();", "    }", "}"].join("\n"),
  [`${JAVA}/More.java`]: ["package com.acme;", "", "import com.lib.Node;", "", "public class More {", "    public Object byNode(Node node) {", "        return node.get();", "    }", "}"].join("\n"),
};
const GET_CALLS = ["Service.java:10", "Service.java:14", "Service.java:18", "Service.java:22", "Service.java:27", "Service.java:31"].map((place) => `${JAVA}/${place}`);

let workspace: string;
const repos = { plain: "", generator: "" };

function commit(repo: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), `${content}\n`);
  }
  execFileSync("git", ["add", "-A"], { cwd: repo, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repo, env: GIT_ENV });
}

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-outside-dispatch-"));
  mkdirSync(join(workspace, "scratch"));
  for (const [name, pom] of [["plain", POM], ["generator", GENERATOR_POM]] as const) {
    repos[name] = join(workspace, name);
    mkdirSync(repos[name]);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repos[name], env: GIT_ENV });
    commit(repos[name], { "pom.xml": pom, ...SOURCES });
  }
  commit(repos.plain, { [`${JAVA}/Api.java`]: SOURCES[`${JAVA}/Api.java`]!.replace("return key;", "return key.trim();") });
});

after(() => rmSync(workspace, { recursive: true, force: true }));

async function run(args: readonly string[]): Promise<{ status: string; cuts?: readonly Cut[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })([...args], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  return JSON.parse(stdout.join("\n"));
}

const callers = (target: string, repo: keyof typeof repos = "plain") => run(["callers", repos[repo], `${JAVA}/${target}`]);
type Answer = { status: string; cuts?: readonly (Cut & { reach?: { declarations?: readonly string[] } })[] };
const nameOnly = (fact: Answer) => (fact.cuts ?? []).filter((cut) => cut.reason === "name-only");
/** The places the `name-only` cuts of an answer leave open toward `declaration`, sorted. */
const openToward = (fact: Answer, declaration: string): readonly string[] =>
  nameOnly(fact).filter((cut) => cut.reach?.declarations?.includes(declaration)).flatMap(({ at: [, ...places] }) => places.map((place) => place.split(" ")[0]!)).sort();
/** The calls of `get` that write one argument: `opt.get()` and `node.get()` write none, which no reached `get` accepts (ADR-0084). */
const EVERY_GET = GET_CALLS.filter((place) => place !== `${JAVA}/Service.java:14`);

test("a call on a receiver declared as a type outside the repository is no caller of a plain class's homonym", async () => {
  const fact = await callers("Api.java:get");

  assert.equal(fact.status, "complete", JSON.stringify(fact.cuts));
});

test("impact of a change to the plain class's method settles the same calls", async () => {
  const fact = await run(["impact", repos.plain, "--base", "HEAD~1"]);

  assert.deepEqual(nameOnly(fact).map(({ at }) => at), []);
});

test("a repository class extending a type outside the repository keeps the cut of every such call", async () => {
  const fact = await callers("MyMap.java:get");

  assert.deepEqual(openToward(fact, `${JAVA}/MyMap.java::get`), EVERY_GET);
});

test("asked with a plain class's homonym, the cuts reach the class below the outside type alone", async () => {
  const fact = await run(["callers", repos.plain, `${JAVA}/Api.java:get`, `${JAVA}/MyMap.java:get`]);

  assert.deepEqual(openToward(fact, `${JAVA}/MyMap.java::get`), EVERY_GET);
  assert.deepEqual(openToward(fact, `${JAVA}/Api.java::get`), []);
});

test("an enum owner and a record owner stay attributed without library signatures", async () => {
  for (const [target, anchor] of [["Kind.java:get", `${JAVA}/Kind.java::get`], ["Rec.java:get", `${JAVA}/Rec.java::get`]] as const) {
    const fact = await callers(target);

    assert.deepEqual(openToward(fact, anchor), EVERY_GET);
  }
});

test("a receiver of the root type attributes every owner, and another outside type none of a plain class", async () => {
  const fact = await callers("Api.java:equals");

  assert.deepEqual(openToward(fact, `${JAVA}/Api.java::equals`), [`${JAVA}/Service.java:35`]);
});

test("a receiver declared as a platform interface the supertypes leave out keeps its call: a class implementing it may run", async () => {
  const fact = await callers("Entity.java:toString");

  assert.deepEqual((fact.cuts ?? []).flatMap(({ at }) => at).filter((place) => place.startsWith(`${JAVA}/Ids.java:`)), [`${JAVA}/Ids.java:7 id.toString`]);
});

test("a static method is no target of an instance call, even below a type outside the repository", async () => {
  const fact = await callers("Registry.java:size");

  assert.equal(fact.status, "complete", JSON.stringify(fact.cuts));
});

test("a declared source generator keeps the plain class's method attributed", async () => {
  const fact = await callers("Api.java:get", "generator");

  assert.deepEqual(openToward(fact, `${JAVA}/Api.java::get`), EVERY_GET);
});

test("trace keeps reading an outside receiver as unproven: a cut listing every homonym", async () => {
  for (const [target, place] of [["Service.java:byMap", "Service.java:10 map.get"], ["Service.java:byReturn", "Service.java:18 holder.values().get"]] as const) {
    const fact = await run(["trace", repos.plain, `${JAVA}/${target}`]);

    assert.deepEqual(fact.cuts?.map(({ reason, at }) => [reason, ...at]), [["receiver-unproven", `${JAVA}/${place}`, `${JAVA}/Api.java::com.acme.Api.get`, `${JAVA}/Kind.java::com.acme.Kind.get`, `${JAVA}/MyMap.java::com.acme.MyMap.get`, `${JAVA}/Rec.java::com.acme.get`]]);
  }
});
