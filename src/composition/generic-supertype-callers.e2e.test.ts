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
 * Each implementation implements or overrides a method of a supertype written with type arguments, which the index leaves
 * as an unresolved reference and no supertype edge; `Client` calls every method through its supertype. `other.Repo` shares
 * the simple name of `shop.Repo`, and `OtherClient` calls it. `Holder.Kept` names `Repo` inside a class whose superclass
 * is outside the repository and may declare a member type `Repo`, so its supertype is not placed. The second commit
 * changes the body of `NameRepo.find`.
 */
const SHOP = "src/main/java/shop";
const CLIENT = `${SHOP}/Client.java`;
const OTHER_CLIENT = "src/main/java/other/OtherClient.java";
const java = (path: string, ...lines: string[]): [string, string] => [path, [`package ${path.includes("/other/") ? "other" : "shop"};`, ...lines, ""].join("\n")];
const SOURCES: Record<string, string> = Object.fromEntries([
  java(`${SHOP}/Repo.java`, "public interface Repo<T> { T find(); }"),
  java(`${SHOP}/NameRepo.java`, "public class NameRepo implements Repo<String> { public String find() { return \"n\"; } }"),
  java(`${SHOP}/Base.java`, "public abstract class Base<T> { public T get() { return null; } }"),
  java(`${SHOP}/Sub.java`, "public class Sub extends Base<String> { public String get() { return \"s\"; } }"),
  java(`${SHOP}/Lookup.java`, "public interface Lookup<T> { T look(); }"),
  java(`${SHOP}/Special.java`, "public interface Special extends Lookup<String> {}"),
  java(`${SHOP}/SpecialImpl.java`, "public class SpecialImpl implements Special { public String look() { return \"l\"; } }"),
  java(`${SHOP}/Plain.java`, "public interface Plain { String plain(); }"),
  java(`${SHOP}/Source.java`, "public interface Source<T> { T pull(); }"),
  java(`${SHOP}/Both.java`, "public class Both implements Plain, Source<String> { public String plain() { return \"p\"; } public String pull() { return \"b\"; } }"),
  java(`${SHOP}/Feed.java`, "public interface Feed<T> { T next(); }"),
  java(`${SHOP}/QualifiedFeed.java`, "public class QualifiedFeed implements shop.Feed<String> { public String next() { return \"q\"; } }"),
  java(`${SHOP}/Outer.java`, "public class Outer { public interface Inner<T> { T inner(); } }"),
  java(`${SHOP}/NestedImpl.java`, "public class NestedImpl implements Outer.Inner<String> { public String inner() { return \"i\"; } }"),
  java(`${SHOP}/Store.java`, "public interface Store<T> { T load(); }"),
  java(`${SHOP}/AbstractStore.java`, "public abstract class AbstractStore<T> implements Store<T> {}"),
  java(`${SHOP}/ConcreteStore.java`, "public class ConcreteStore extends AbstractStore<String> { public String load() { return \"c\"; } }"),
  java(`${SHOP}/Converter.java`, "public interface Converter<S, T> { T convert(S source); }"),
  java(`${SHOP}/Num.java`, "public class Num implements Converter<String, Integer> { public Integer convert(String source) { return 1; } }"),
  java(`${SHOP}/Parent.java`, "public class Parent<T> {", "  public Parent(int size) {", "  }", "}"),
  java(`${SHOP}/Child.java`, "public class Child extends Parent<String> { public Child() { super(1); } }"),
  java(`${SHOP}/Ranked.java`, "public class Ranked implements Comparable<Ranked> { public int compareTo(Ranked other) { return 0; } }"),
  java(`${SHOP}/Holder.java`, "public class Holder extends org.lib.Thing {", "  public static class Kept implements Repo<String> { public String find() { return \"k\"; } }", "}"),
  java(
    CLIENT,
    "public class Client {",
    "  private Repo<String> repo; private Base<String> base; private Lookup<String> lookup; private Source<String> source;",
    "  private Feed<String> feed; private Outer.Inner<String> inner; private Store<String> store; private Converter<String, Integer> converter;",
    "  public String viaRepo() { return repo.find(); }",
    "  public String viaBase() { return base.get(); }",
    "  public String viaLookup() { return lookup.look(); }",
    "  public String viaSource() { return source.pull(); }",
    "  public String viaFeed() { return feed.next(); }",
    "  public String viaInner() { return inner.inner(); }",
    "  public String viaStore() { return store.load(); }",
    "  public Integer viaConvert() { return converter.convert(\"x\"); }",
    "}",
  ),
  java("src/main/java/other/Repo.java", "public interface Repo<T> { T find(); }"),
  java(OTHER_CLIENT, "public class OtherClient {", "  private Repo<String> repo;", "  public String otherFind() { return repo.find(); }", "}"),
]);
const CHANGED = Object.fromEntries([java(`${SHOP}/NameRepo.java`, "public class NameRepo implements Repo<String> { public String find() { return \"m\"; } }")]);

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
  root = await mkdtemp(join(tmpdir(), "ye-ast-generic-supertype-"));
  scratchRoot = join(root, "scratch");
  repo = join(root, "repo");
  await mkdir(scratchRoot);
  await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: ENV });
  await commit(SOURCES, "fixture");
  await commit(CHANGED, "change");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The dependents an answer lists, as `<file>:<symbol>`. */
function dependentsOf(result: Awaited<ReturnType<ReturnType<typeof composeQueries>["impact"]["callers"]>>): string[] {
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(result.value.status !== "unknown", JSON.stringify(result.value));
  const value: ImpactValue = result.value.value;
  return value.symbols.map(({ file, symbol }) => `${file}:${symbol}`);
}

type CallersTarget = { file: string; symbol: string } | { file: string; start: number; end: number };

const callersFact = (target: CallersTarget) => composeQueries({ scratchRoot }).impact.callers({ repo, repoId: "generic-supertype", revision: "HEAD", targets: [target] });

async function callersOf(file: string, symbol: string): Promise<string[]> {
  return dependentsOf(await callersFact({ file, symbol }));
}

const relationUnread = (cuts: readonly Cut[] | undefined): (readonly string[])[] => (cuts ?? []).filter((cut) => "reason" in cut && cut.reason === "relation-unread").map(({ at }) => at);

test("callers of a method implementing or overriding a method of a parameterized supertype list the supertype's caller, never a homonym's", async () => {
  const cases: [string, string, string][] = [
    ["NameRepo.java", "NameRepo.find", "viaRepo"],
    ["Sub.java", "Sub.get", "viaBase"],
    ["SpecialImpl.java", "SpecialImpl.look", "viaLookup"],
    ["Both.java", "Both.pull", "viaSource"],
    ["QualifiedFeed.java", "QualifiedFeed.next", "viaFeed"],
    ["NestedImpl.java", "NestedImpl.inner", "viaInner"],
    ["ConcreteStore.java", "ConcreteStore.load", "viaStore"],
    ["Num.java", "Num.convert", "viaConvert"],
  ];
  for (const [file, symbol, caller] of cases) {
    const dependents = await callersOf(`${SHOP}/${file}`, symbol);
    assert.ok(dependents.includes(`${CLIENT}:${caller}`), `${symbol}: ${JSON.stringify(dependents)}`);
    assert.ok(!dependents.some((dependent) => dependent.startsWith(OTHER_CLIENT)), `${symbol}: ${JSON.stringify(dependents)}`);
  }
});

test("callers of a method of a parameterized supertype list the method that implements it, and a homonym's callers do not", async () => {
  assert.ok((await callersOf(`${SHOP}/Repo.java`, "Repo.find")).includes(`${SHOP}/NameRepo.java:find`));
  assert.ok(!(await callersOf("src/main/java/other/Repo.java", "Repo.find")).some((dependent) => dependent.startsWith(SHOP)));
});

test("the impact of a change to an implementation of a parameterized supertype lists the supertype's caller", async () => {
  const dependents = dependentsOf(await composeQueries({ scratchRoot }).impact.ofChange({ repo, repoId: "generic-supertype", base: "HEAD~1", head: "HEAD" }));
  assert.ok(dependents.includes(`${CLIENT}:viaRepo`), JSON.stringify(dependents));
  assert.ok(!dependents.some((dependent) => dependent.startsWith(OTHER_CLIENT)), JSON.stringify(dependents));
});

test("callers of a constructor of a parameterized superclass list the subclass constructor that chains to it", async () => {
  const dependents = dependentsOf(await callersFact({ file: `${SHOP}/Parent.java`, start: 3, end: 4 }));
  assert.ok(dependents.includes(`${SHOP}/Child.java:Child`), JSON.stringify(dependents));
});

test("importers of a parameterized supertype's file list the file of the type that extends or implements it", async () => {
  const result = await composeQueries({ scratchRoot }).impact.importers({ repo, repoId: "generic-supertype", revision: "HEAD", files: [`${SHOP}/Lookup.java`, `${SHOP}/Repo.java`] });
  assert.ok(result.ok && result.value.status !== "unknown", JSON.stringify(result));
  const users = Object.fromEntries(result.value.value.files.map(({ file, users }) => [file, users]));
  assert.ok(users[`${SHOP}/Repo.java`]?.includes(`${SHOP}/NameRepo.java`), JSON.stringify(users));
  assert.ok(users[`${SHOP}/Lookup.java`]?.includes(`${SHOP}/Special.java`), JSON.stringify(users));
  assert.ok(!users[`${SHOP}/Repo.java`]?.includes(`${SHOP}/Holder.java`), JSON.stringify(users));
  assert.deepEqual(relationUnread(result.value.status === "partial" ? result.value.cuts : []), []);

  const holder = await composeQueries({ scratchRoot }).impact.importers({ repo, repoId: "generic-supertype", revision: "HEAD", files: [`${SHOP}/Holder.java`] });
  assert.ok(holder.ok && holder.value.status === "partial", JSON.stringify(holder));
  assert.deepEqual(relationUnread(holder.value.cuts), [[`${SHOP}/Holder.java::Kept`, `${SHOP}/Holder.java:3 Repo<String>`]]);
});

test("a supertype the sources do not place links nothing and cuts the answers about its type, and only those; one proven outside cuts nothing", async () => {
  const kept = await callersFact({ file: `${SHOP}/Holder.java`, symbol: "Kept.find" });
  assert.ok(kept.ok && kept.value.status === "partial", JSON.stringify(kept));
  assert.deepEqual(relationUnread(kept.value.cuts), [[`${SHOP}/Holder.java::Kept`, `${SHOP}/Holder.java:3 Repo<String>`]]);
  assert.ok(!dependentsOf(kept).includes(`${CLIENT}:viaRepo`), JSON.stringify(kept.value.value));

  const named = await callersFact({ file: `${SHOP}/NameRepo.java`, symbol: "NameRepo.find" });
  assert.ok(named.ok && named.value.status !== "unknown");
  assert.deepEqual(relationUnread(named.value.status === "partial" ? named.value.cuts : []), []);

  const ranked = await callersFact({ file: `${SHOP}/Ranked.java`, symbol: "Ranked.compareTo" });
  assert.ok(ranked.ok && ranked.value.status !== "unknown");
  assert.deepEqual(relationUnread(ranked.value.status === "partial" ? ranked.value.cuts : []), []);
});

test("an answer that reached a type a supertype reference names with type arguments, and that no one placed, carries a cut naming that reference", async () => {
  const result = await callersFact({ file: `${SHOP}/Repo.java`, symbol: "Repo.find" });
  assert.ok(result.ok && result.value.status === "partial", JSON.stringify(result));
  const nameOnly = result.value.cuts.filter((cut) => "reason" in cut && cut.reason === "name-only").map(({ at }) => at);
  assert.deepEqual(nameOnly, [[`${SHOP}/Holder.java`, `${SHOP}/Holder.java:3 Repo<String>`]]);

  const importers = await composeQueries({ scratchRoot }).impact.importers({ repo, repoId: "generic-supertype", revision: "HEAD", files: [`${SHOP}/Repo.java`] });
  assert.ok(importers.ok && importers.value.status !== "unknown", JSON.stringify(importers));
  assert.deepEqual(importers.value.value.files.map(({ unresolvedNamers }) => unresolvedNamers), [[`${SHOP}/Holder.java`]]);
});
