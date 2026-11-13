import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeQueries } from "./compose.ts";
import type { Cut } from "../core/domain/shared/fact.ts";

/**
 * Sources whose syntax errors the grammar confines to a member body. `Repo` writes statements before `super(...)` in its
 * constructor, which the grammar does not accept, and `Pre` writes them before `this(...)`; `Repo`'s constructor body
 * also declares a local class `Local` below `Lib`, a type a single-type import names. `Controller` implements
 * `OrdersApi`, which a single-type import names and no source declares, and `NameRepo` extends `Repo<String>`, which
 * the index leaves unresolved for its type arguments; `Client` calls `find` through a `Repo<String>`. In `header` the
 * error lies in a method's parameter list instead, outside every body.
 */
const APP = "src/main/java/app";
const java = (path: string, ...lines: string[]): [string, string] => [path, [`package ${path.split("/").at(-2)};`, ...lines, ""].join("\n")];
const CONTROLLER = java(`${APP}/Controller.java`, "import app.api.OrdersApi;", "public class Controller implements OrdersApi {", "  public String m() { return \"c\"; }", "}");
const COMMON = [
  CONTROLLER,
  java(`${APP}/Base.java`, "public class Base {", "  public Base(int x) {}", "}"),
  java(`${APP}/NameRepo.java`, "public class NameRepo extends Repo<String> {", "  public NameRepo() { super(1); }", "  public String find(String key) { return key; }", "}"),
  java(`${APP}/Client.java`, "public class Client {", "  public String via(Repo<String> repo) { return repo.find(\"a\"); }", "}"),
  java(`${APP}/Pre.java`, "public class Pre {", "  public Pre(int x) {", "    if (x < 0) throw new IllegalArgumentException();", "    this(x, 1);", "  }", "  public Pre(int x, int y) {}", "}"),
];
const REPO = (constructor: readonly string[]) => java(`${APP}/Repo.java`, "import org.lib.Lib;", "public abstract class Repo<T> extends Base {", ...constructor, "  public abstract String find(T key);", "}");
const REPOSITORIES: Record<string, Record<string, string>> = {
  confined: Object.fromEntries([...COMMON, REPO(["  protected Repo(int x) {", "    int y = x + 1;", "    super(y);", "    class Local extends Lib {}", "  }"])]),
  header: Object.fromEntries([...COMMON, REPO(["  protected Repo(int x,) {", "    super(x);", "  }"])]),
};
const UNREADABLE = [`${APP}/Pre.java`, `${APP}/Repo.java`];

let root: string;
let scratchRoot: string;

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ye-ast-confined-errors-"));
  scratchRoot = join(root, "scratch");
  await mkdir(scratchRoot);
  for (const [name, files] of Object.entries(REPOSITORIES)) {
    const repo = join(root, name);
    await mkdir(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: ENV });
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), text);
    }
    execFileSync("git", ["add", "."], { cwd: repo, env: ENV });
    execFileSync("git", ["commit", "-qm", name], { cwd: repo, env: ENV });
  }
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const queries = () => composeQueries({ scratchRoot }).impact;
const UNREADABLE_AT = / source-unreadable$/;
const relationUnread = (cuts: readonly Cut[]): (readonly string[])[] => cuts.filter((cut) => "reason" in cut && cut.reason === "relation-unread").map(({ at }) => at);
const supertypeCuts = (cuts: readonly Cut[]): (readonly string[])[] => relationUnread(cuts).filter(([anchor]) => !UNREADABLE_AT.test(anchor!));
/** The sources an answer cuts as unreadable, with a reach of anything: a body nobody read may call anything. */
const unreadableFiles = (cuts: readonly Cut[]): string[] => cuts.filter((cut) => cut.reason === "relation-unread" && UNREADABLE_AT.test(cut.at[0]!) && cut.reach.kind === "anything").map(({ at }) => at[0]!.split(":")[0]!).sort();
const cutsOf = (value: { status: string; cuts?: readonly Cut[] }): readonly Cut[] => (value.status === "partial" ? value.cuts ?? [] : []);

async function callers(name: keyof typeof REPOSITORIES, file: string, symbol: string) {
  const result = await queries().callers({ repo: join(root, name), repoId: name, revision: "HEAD", targets: [{ file, symbol }] });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));
  return { dependents: result.value.value.symbols.map(({ file, symbol }) => `${file}:${symbol}`), cuts: cutsOf(result.value) };
}

async function importers(name: keyof typeof REPOSITORIES, file: string) {
  const result = await queries().importers({ repo: join(root, name), repoId: name, revision: "HEAD", files: [file] });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));
  return cutsOf(result.value);
}

test("a supertype a single-type import names is proven outside while a source's syntax errors lie in member bodies, and the bodies stay unreadable", async () => {
  const called = await callers("confined", `${APP}/Controller.java`, "Controller.m");
  assert.deepEqual(supertypeCuts(called.cuts), []);
  assert.deepEqual(unreadableFiles(called.cuts), UNREADABLE);
  assert.deepEqual(await importers("confined", `${APP}/Controller.java`), []);
});

test("a supertype written with type arguments is placed at the class the source with an unread body declares, so its caller is listed", async () => {
  const called = await callers("confined", `${APP}/NameRepo.java`, "NameRepo.find");
  assert.ok(called.dependents.includes(`${APP}/Client.java:via`), JSON.stringify(called));
  assert.deepEqual(supertypeCuts(called.cuts), []);
  assert.deepEqual(unreadableFiles(called.cuts), UNREADABLE);
});

test("a syntax error outside every member body proves no supertype of the repository", async () => {
  assert.deepEqual(supertypeCuts((await callers("header", `${APP}/Controller.java`, "Controller.m")).cuts), [[`${APP}/Controller.java::Controller`, `${APP}/Controller.java:3 OrdersApi`]]);
  assert.deepEqual(supertypeCuts(await importers("header", `${APP}/Controller.java`)), [[`${APP}/Controller.java::Controller`, `${APP}/Controller.java:3 OrdersApi`]]);
  assert.deepEqual(unreadableFiles((await callers("header", `${APP}/Controller.java`, "Controller.m")).cuts), UNREADABLE);
});
