import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { ImpactValue } from "../core/domain/impact/impact-fact.ts";
import type { Cut } from "../core/domain/shared/fact.ts";

/**
 * Supertypes the index leaves unresolved without type arguments. `Qualified` implements `other.Repo` by its qualified
 * name, and `Client` calls `find` through it; `third.Repo` shares its simple name and `ThirdClient` calls it.
 * `Failure`, `Wild` and `Sorter` name a type outside the repository through `java.lang`, one on-demand import of a
 * package the repository does not declare, and an on-demand import of a listed platform package; `TwoWild` names one two
 * such on-demand imports may offer, and `Holder.Job` names `Runnable` inside a class whose superclass is outside the
 * repository and may declare a member type of that name; `Served` names `ServedApi`, which no source declares and no
 * import offers, as a type its own package gains from generated sources. `Shell.Task` names `Handler`, which an
 * on-demand import of a
 * package the repository does not declare may offer, inside a class whose superclass the repository declares twice, one
 * declaring a member type of that name. `Service` extends `core.BaseService` by its qualified name and overrides the
 * `helper` its `template` calls; `Overload` declares a `helper` of another parameter type, and `Generic` one whose parameter
 * is a type variable, which the sources do not settle as an override or not. The second commit changes the body of `Qualified.find`.
 */
const APP = "src/main/java/app";
const CLIENT = `${APP}/Client.java`;
const THIRD_CLIENT = "src/main/java/third/ThirdClient.java";
const java = (path: string, ...lines: string[]): [string, string] => [path, [`package ${path.split("/").at(-2)};`, ...lines, ""].join("\n")];
const qualified = (body: string): [string, string] => java(`${APP}/Qualified.java`, "public class Qualified implements other.Repo {", `  public String find(String key) { return ${body}; }`, "}");
const SOURCES: Record<string, string> = Object.fromEntries([
  java("src/main/java/other/Repo.java", "public interface Repo { String find(String key); }"),
  qualified("key"),
  java(CLIENT, "import other.Repo;", "public class Client {", "  public String viaRepo(Repo repo) { return repo.find(\"a\"); }", "}"),
  java("src/main/java/third/Repo.java", "public interface Repo { String find(String key); }"),
  java(THIRD_CLIENT, "public class ThirdClient {", "  public String viaThird(Repo repo) { return repo.find(\"t\"); }", "}"),
  java(`${APP}/Failure.java`, "public class Failure extends RuntimeException { public String m() { return \"f\"; } }"),
  java(`${APP}/Wild.java`, "import org.lib.*;", "public class Wild extends OtherLibraryBase { public String m() { return \"w\"; } }"),
  java(`${APP}/Sorter.java`, "import java.util.*;", "public class Sorter implements Comparator<String> { public int compare(String a, String b) { return 0; } public String m() { return \"s\"; } }"),
  java(`${APP}/TwoWild.java`, "import org.lib.*;", "import org.other.*;", "public class TwoWild extends Ambiguous { public String m() { return \"t\"; } }"),
  java(`${APP}/Holder.java`, "public class Holder extends org.lib.Thing {", "  public static class Job implements Runnable { public void run() {} public String m() { return \"j\"; } }", "}"),
  java(`${APP}/Served.java`, "public class Served implements ServedApi { public String m() { return \"g\"; } }"),
  java("src/main/java/dup/Base.java", "public class Base { public interface Handler<T> {} }"),
  java("module/src/main/java/dup/Base.java", "public class Base {}"),
  java("src/main/java/dup/Shell.java", "import org.lib.*;", "public class Shell extends Base {", "  public static class Task implements Handler<String> { public String m() { return \"t\"; } }", "}"),
  java("src/main/java/core/BaseService.java", "public class BaseService {", "  protected String helper(String key) { return key; }", "  public String template() { return helper(\"k\"); }", "}"),
  java(`${APP}/Service.java`, "public class Service extends core.BaseService {", "  @Override protected String helper(String key) { return \"s\"; }", "}"),
  java(`${APP}/Overload.java`, "public class Overload extends core.BaseService {", "  protected String helper(Integer key) { return \"o\"; }", "}"),
  java(`${APP}/Generic.java`, "public class Generic<T> extends core.BaseService {", "  protected String helper(T key) { return \"g\"; }", "}"),
]);

let root: string;
let scratchRoot: string;
let repo: string;

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };

async function commit(files: Record<string, string>, message: string): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  execFileSync("git", ["add", "."], { cwd: repo, env: ENV });
  execFileSync("git", ["commit", "-qm", message], { cwd: repo, env: ENV });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-supertype-forms-"));
  scratchRoot = join(root, "scratch");
  repo = join(root, "repo");
  await mkdir(scratchRoot);
  await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: ENV });
  await commit(SOURCES, "fixture");
  await commit(Object.fromEntries([qualified("\"q\"")]), "change");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const queries = () => composeQueries({ scratchRoot });

function dependentsOf(result: Awaited<ReturnType<ReturnType<typeof composeQueries>["impact"]["callers"]>>): string[] {
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(result.value.status !== "unknown", JSON.stringify(result.value));
  const value: ImpactValue = result.value.value;
  return value.symbols.map(({ file, symbol }) => `${file}:${symbol}`);
}

const callersFact = (file: string, symbol: string) => queries().impact.callers({ repo, repoId: "supertype-forms", revision: "HEAD", targets: [{ file, symbol }] });

const relationUnread = (result: Awaited<ReturnType<typeof callersFact>>): (readonly string[])[] => {
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));
  const cuts: readonly Cut[] = result.value.status === "partial" ? result.value.cuts : [];
  return cuts.filter((cut) => "reason" in cut && cut.reason === "relation-unread").map(({ at }) => at);
};

test("callers of a method implementing a supertype written by its qualified name list the supertype's caller, never a homonym's, and no cut", async () => {
  const result = await callersFact(`${APP}/Qualified.java`, "Qualified.find");
  const dependents = dependentsOf(result);

  assert.ok(dependents.includes(`${CLIENT}:viaRepo`), JSON.stringify(dependents));
  assert.ok(!dependents.some((dependent) => dependent.startsWith(THIRD_CLIENT)), JSON.stringify(dependents));
  assert.deepEqual(relationUnread(result), []);
});

test("the impact of a change to an implementation of a supertype written by its qualified name lists the supertype's caller", async () => {
  const dependents = dependentsOf(await queries().impact.ofChange({ repo, repoId: "supertype-forms", base: "HEAD~1", head: "HEAD" }));

  assert.ok(dependents.includes(`${CLIENT}:viaRepo`), JSON.stringify(dependents));
  assert.ok(!dependents.some((dependent) => dependent.startsWith(THIRD_CLIENT)), JSON.stringify(dependents));
});

test("importers of a supertype's file list the file that implements it by its qualified name, and a homonym's do not", async () => {
  const result = await queries().impact.importers({ repo, repoId: "supertype-forms", revision: "HEAD", files: ["src/main/java/other/Repo.java", "src/main/java/third/Repo.java"] });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));
  const users = Object.fromEntries(result.value.value.files.map(({ file, users }) => [file, users]));

  assert.ok(users["src/main/java/other/Repo.java"]?.includes(`${APP}/Qualified.java`), JSON.stringify(users));
  assert.ok(!users["src/main/java/third/Repo.java"]?.includes(`${APP}/Qualified.java`), JSON.stringify(users));
});

test("a supertype only types outside the repository may be cuts nothing, whether java.lang, on-demand imports, an outside supertype around it or no source at all offers it; one a repository declaration may also be is a cut", async () => {
  for (const [file, symbol] of [["Failure", "Failure.m"], ["Wild", "Wild.m"], ["Sorter", "Sorter.m"], ["TwoWild", "TwoWild.m"], ["Holder", "Job.m"], ["Served", "Served.m"]] as const) assert.deepEqual(relationUnread(await callersFact(`${APP}/${file}.java`, symbol)), [], symbol);

  assert.deepEqual(relationUnread(await callersFact("src/main/java/dup/Shell.java", "Task.m")), [["src/main/java/dup/Shell.java::Task", "src/main/java/dup/Shell.java:4 Handler<String>"]]);
});

test("trace of a call to an overridable method is a dispatch cut naming the override in a subclass that extends its owner by its qualified name and a method the sources do not settle as one, never an overload", async () => {
  const result = await queries().trace.walk({ repo, repoId: "supertype-forms", revision: "HEAD", targets: [{ file: "src/main/java/core/BaseService.java", symbol: "BaseService.template" }] });
  assert.ok(result.ok && result.value.status === "partial", JSON.stringify(result));

  const dispatch = result.value.cuts.filter((cut) => "reason" in cut && cut.reason === "dispatch").map(({ at }) => at);
  assert.deepEqual(dispatch, [["src/main/java/core/BaseService.java:3 helper", `${APP}/Generic.java::app.Generic.helper`, `${APP}/Service.java::app.Service.helper`]]);
});
