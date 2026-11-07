import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { Fact } from "../core/domain/shared/fact.ts";

/**
 * `Accounts` imports the repository's `User` and also spells a platform `User` by its qualified name; the graph resolves
 * both spellings through the import. `VisitResource` uses its own nested record `Visits`, which the graph gives no node,
 * and the graph matches the name to the constructor of the homonym record of another package.
 */
const USER = "src/main/java/app/domain/User.java";
const VISITS = "src/main/java/app/dto/Visits.java";
const STATE = "src/main/java/app/inherit/State.java";
const REMOTE_USER = "src/main/java/app/remote/User.java";
const SHADOWED = "src/main/java/app/shadow/Derived.java";
const INHERITED_USER = "src/main/java/app/hidden/Base.java";
const HIDDEN = "src/main/java/app/hidden/Derived.java";
const ANONYMOUS = "src/main/java/app/hidden/Deferred.java";
const FILES: Record<string, string> = {
  "src/main/java/app/hidden/Task.java": "package app.hidden;\n\npublic interface Task {\n  Object run();\n}\n",
  [ANONYMOUS]: [
    "package app.hidden;",
    "",
    "public class Deferred extends Base {",
    "  Object load() {",
    "    Task task = new Task() {",
    "      public Object run() {",
    "        return new User();",
    "      }",
    "    };",
    "    class User {}",
    "    return task;",
    "  }",
    "}",
    "",
  ].join("\n"),
  [INHERITED_USER]: "package app.hidden;\n\npublic class Base {\n  static class User {}\n}\n",
  [HIDDEN]: [
    "package app.hidden;",
    "",
    "public class Derived extends Base {",
    "  Object later() {",
    "    Object user = new User();",
    "    class User {}",
    "    return user;",
    "  }",
    "",
    "  Object outside(boolean fresh) {",
    "    if (fresh) {",
    "      class User {}",
    "      return new User();",
    "    }",
    "    return new User();",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/main/java/app/shadow/Base.java": "package app.shadow;\n\npublic class Base {\n  static class User {}\n}\n",
  [SHADOWED]: ["package app.shadow;", "", "public class Derived extends Base {", "  Object load() {", "    class User {}", "    return new User();", "  }", "}", ""].join("\n"),
  "src/main/java/app/inherit/Base.java": "package app.inherit;\n\npublic class Base {\n  private record State(int n) {}\n}\n",
  [STATE]: "package app.inherit;\n\npublic class State {}\n",
  "src/main/java/app/inherit/Derived.java": ["package app.inherit;", "", "public class Derived extends Base {", "  public State read() {", "    return new State();", "  }", "}", ""].join("\n"),
  "src/main/java/app/local/Base.java": "package app.local;\n\npublic class Base {\n  private static class User {}\n}\n",
  [REMOTE_USER]: "package app.remote;\n\npublic class User {}\n",
  "src/main/java/app/remote/Derived.java": ["package app.remote;", "", "public class Derived extends app.local.Base {", "  public User load() {", "    return null;", "  }", "}", ""].join("\n"),
  [USER]: "package app.domain;\n\npublic class User {}\n",
  [VISITS]: ["package app.dto;", "", "public record Visits(int count) {", "  public Visits() {", "    this(0);", "  }", "}", ""].join("\n"),
  "src/main/java/app/web/VisitResource.java": [
    "package app.web;",
    "",
    "public class VisitResource {",
    "  public Visits read() {",
    "    return new Visits(1);",
    "  }",
    "",
    "  record Visits(int count) {}",
    "}",
    "",
  ].join("\n"),
  "src/main/java/app/service/Accounts.java": [
    "package app.service;",
    "",
    "import app.domain.User;",
    "",
    "public class Accounts {",
    "  public String load(User user) {",
    "    return null;",
    "  }",
    "",
    "  public org.springframework.security.core.userdetails.User build() {",
    "    return null;",
    "  }",
    "}",
    "",
  ].join("\n"),
};

let root: string;
let repo: string;
let scratchRoot: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-java-name-bindings-"));
  repo = join(root, "repo");
  scratchRoot = join(root, "scratch");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
  await mkdir(repo);
  await mkdir(scratchRoot);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  execFileSync("git", ["add", "."], { cwd: repo, env });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo, env });
  await writeFile(join(repo, INHERITED_USER), "package app.hidden;\n\npublic class Base {\n  static class User {\n    int id;\n  }\n}\n");
  execFileSync("git", ["commit", "-qam", "change the inherited User"], { cwd: repo, env });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a Java type spelled with a platform package is no use of the repository's homonym its file imports", async () => {
  const result = await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "java-name-bindings", revision: "HEAD", targets: [{ file: USER, symbol: "User" }] });
  assert.ok(result.ok, JSON.stringify(result));
  const answer: Fact<ImpactValue> = result.value;
  assert.ok(answer.status !== "unknown", JSON.stringify(answer));

  assert.deepEqual(answer.value.symbols.map(({ file, symbol }) => `${file}:${symbol}`).filter((reached) => !reached.startsWith(USER)), ["src/main/java/app/service/Accounts.java:Accounts", "src/main/java/app/service/Accounts.java:load"]);
});

test("a Java name a nested record binds is no use of the homonym record of another package the graph matched it to", async () => {
  const result = await composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "java-name-bindings", revision: "HEAD", targets: [{ file: VISITS, symbol: "Visits" }] });
  assert.ok(result.ok, JSON.stringify(result));
  const answer: Fact<ImpactValue> = result.value;
  assert.ok(answer.status !== "unknown", JSON.stringify(answer));

  assert.deepEqual(answer.value.symbols.filter(({ depth }) => depth > 0), []);
});

test("a Java type name a superclass's private member type spells is a use of the type the file's own scope binds", async () => {
  const queries = composeQueries({ scratchRoot });
  const reached = async (file: string, symbol: string): Promise<string[]> => {
    const result = await queries.impact.callers({ repo, repoId: "java-name-bindings", revision: "HEAD", targets: [{ file, symbol }] });
    assert.ok(result.ok, JSON.stringify(result));
    assert.ok(result.value.status !== "unknown", JSON.stringify(result.value));
    return result.value.value.symbols.filter(({ depth }) => depth > 0).map(({ file: at, symbol: name }) => `${at}:${name}`);
  };

  assert.ok((await reached(STATE, "State")).includes("src/main/java/app/inherit/Derived.java:read"));
  assert.ok((await reached(REMOTE_USER, "User")).includes("src/main/java/app/remote/Derived.java:load"));
});

test("a Java class declared in a method shadows a member type its class inherits, for its focus and its callers alike", async () => {
  const queries = composeQueries({ scratchRoot });
  const outline = await queries.outline.outline({ repo, repoId: "java-name-bindings", revision: "HEAD", focus: [{ file: SHADOWED, symbol: "Derived.load" }] });
  assert.ok(outline.ok, JSON.stringify(outline));
  assert.ok(outline.value.status !== "unknown", JSON.stringify(outline.value));
  const used = outline.value.value.focus?.flatMap(({ uses }) => uses ?? []).flatMap((use) => ("declaration" in use && use.declaration !== undefined ? [use.declaration.file] : []));
  const callers = await queries.impact.callers({ repo, repoId: "java-name-bindings", revision: "HEAD", targets: [{ file: SHADOWED, symbol: "Derived.load.User" }] });
  assert.ok(callers.ok, JSON.stringify(callers));
  assert.ok(callers.value.status !== "unknown", JSON.stringify(callers.value));

  assert.deepEqual(used?.filter((file) => file === "src/main/java/app/shadow/Base.java"), []);
  assert.ok(callers.value.value.symbols.some(({ file, symbol, depth }) => file === SHADOWED && symbol === "load" && depth === 1));
});

test("a Java type name read where no local class of the name is in scope yet is a use of the type the class inherits, for its callers and the impact of its change alike", async () => {
  const queries = composeQueries({ scratchRoot });
  const callers = await queries.impact.callers({ repo, repoId: "java-name-bindings", revision: "HEAD", targets: [{ file: INHERITED_USER, symbol: "Base.User" }] });
  const impact = await queries.impact.ofChange({ repo, repoId: "java-name-bindings", base: "HEAD~1", head: "HEAD" });
  const reached = (result: typeof callers): string[] => {
    assert.ok(result.ok, JSON.stringify(result));
    assert.ok(result.value.status !== "unknown", JSON.stringify(result.value));
    return result.value.value.symbols.filter(({ file, depth }) => file === HIDDEN && depth === 1).map(({ symbol }) => symbol);
  };

  for (const answer of [callers, impact]) {
    assert.ok(reached(answer).includes("later"), JSON.stringify(answer));
    assert.ok(reached(answer).includes("outside"), JSON.stringify(answer));
  }
});

test("a Java type name read in an anonymous class body binds through the body's scope before the method around it", async () => {
  const queries = composeQueries({ scratchRoot });
  const callers = await queries.impact.callers({ repo, repoId: "java-name-bindings", revision: "HEAD", targets: [{ file: INHERITED_USER, symbol: "Base.User" }] });
  const impact = await queries.impact.ofChange({ repo, repoId: "java-name-bindings", base: "HEAD~1", head: "HEAD" });

  for (const answer of [callers, impact]) {
    assert.ok(answer.ok, JSON.stringify(answer));
    assert.ok(answer.value.status !== "unknown", JSON.stringify(answer.value));
    assert.ok(answer.value.value.symbols.some(({ file, depth }) => file === ANONYMOUS && depth > 0), JSON.stringify(answer.value));
  }
});
