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
 * What a Java trace says of a call on a receiver whose type is known: a `this` call in an inherited body runs what the
 * receiver the walk entered through runs, never what a sibling class of the body's owner declares, and a cut lists only
 * the declarations the receiver's type can run.
 */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
const JAVA = "src/main/java/com/acme";
const POM = "<project><groupId>com.acme</groupId><artifactId>fx</artifactId></project>\n";
const java = (name: string, ...lines: string[]): [string, string] => [`${JAVA}/${name}.java`, ["package com.acme;", "", ...lines].join("\n")];

/**
 * `Base` implements the generic `Port`: the type variables of its two `save` declarations leave the call unproven among
 * them and the `save` of `Beta`, a sibling of `Alpha`, which enters `Base` by `this`.
 */
const INHERITED: Readonly<Record<string, string>> = Object.fromEntries([
  java("Port", "public interface Port<K, E> {", "    void save(E entity);", "}"),
  java("Base", "public abstract class Base<K, E> implements Port<K, E> {", "    public void update(E entity) {", "        save(entity);", "    }", "", "    public void save(E entity) {", "        System.out.println(entity);", "    }", "}"),
  java("Alpha", "public class Alpha extends Base<Long, String> {", "    public void run(String entity) {", "        this.update(entity);", "    }", "}"),
  java("Beta", "public class Beta extends Base<Long, String> {", "    @Override", "    public void update(String entity) {", "        System.out.println(\"beta\");", "    }", "", "    @Override", "    public void save(String entity) {", "        System.out.println(\"beta-save\");", "    }", "}"),
]);

/** `Base` is closed: `Alpha` enters it by `this`, `Caller` through a receiver typed `Base`, and `Beta` overrides both its methods. */
const CLOSED: Readonly<Record<string, string>> = Object.fromEntries([
  java("Base", "public abstract class Base {", "    public void update(String entity) {", "        save(entity);", "    }", "", "    public void save(String entity) {", "        System.out.println(entity);", "    }", "}"),
  java("Alpha", "public class Alpha extends Base {", "    public void run(String entity) {", "        this.update(entity);", "    }", "}"),
  java("Beta", "public class Beta extends Base {", "    @Override", "    public void update(String entity) {", "        System.out.println(\"beta\");", "    }", "", "    @Override", "    public void save(String entity) {", "        System.out.println(\"beta-save\");", "    }", "}"),
  java("Caller", "public class Caller {", "    public void call(Base base, String entity) {", "        base.update(entity);", "    }", "}"),
]);

/** `Problem` is open through `Exception`; `Detailed` overrides its `setCode` and `Unrelated` declares a homonym. `Coded` has two constructors. */
const TYPED: Readonly<Record<string, string>> = Object.fromEntries([
  java("Problem", "public class Problem extends Exception {", "    public void setCode(String code) {", "        System.out.println(code);", "    }", "}"),
  java("Coded", "public class Coded {", "    public Coded() {", "        System.out.println(\"none\");", "    }", "", "    public Coded(String code) {", "        System.out.println(code);", "    }", "}"),
  java("Detailed", "public class Detailed extends Problem {", "    @Override", "    public void setCode(String code) {", "        System.out.println(\"detailed\");", "    }", "}"),
  java("Unrelated", "public class Unrelated {", "    public void setCode(String code) {", "        System.out.println(\"unrelated\");", "    }", "}"),
  java("Uses", "public class Uses {", "    public void merge(Problem destination, String code) {", "        destination.setCode(code);", "    }", "", "    public Coded make() {", "        return new Coded();", "    }", "}"),
]);

let workspace: string;
let inherited: string;
let closed: string;
let typed: string;

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

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "ye-ast-trace-receivers-"));
  mkdirSync(join(workspace, "scratch"));
  inherited = commit("inherited", INHERITED);
  closed = commit("closed", CLOSED);
  typed = commit("typed", TYPED);
});

after(() => rmSync(workspace, { recursive: true, force: true }));

type Fact = { status: string; cuts?: readonly Cut[]; value: { steps: readonly { file: string; symbol: string; line: number; depth: number }[] } };

async function trace(repo: string, file: string, symbol: string, ...more: readonly string[]): Promise<Fact> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await composeCli({ scratchRoot: join(workspace, "scratch"), indexCache: join(workspace, "cache") })(["trace", repo, `${JAVA}/${file}.java:${symbol}`, ...more.map((target) => `${JAVA}/${target}`)], { out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  assert.equal(code, EXIT_CODE.ok, stderr.join("\n"));
  return JSON.parse(stdout.join("\n"));
}

const stepsOf = (fact: Fact): string[] => fact.value.steps.filter((step) => step.depth > 0).map((step) => `${step.file.split("/").at(-1)!.replace(".java", "")}.${step.symbol}`);
const listed = (cut: Cut): string[] => cut.at.slice(1).map((anchor) => anchor.split(":")[0]!.split("/").at(-1)!.replace(".java", "")).sort();

test("a this call in an inherited body follows what the entered class runs, whatever a sibling class of the body's owner overrides", async () => {
  const fact = await trace(inherited, "Alpha", "Alpha.run");

  assert.deepEqual(fact.cuts ?? [], []);
  assert.deepEqual(stepsOf(fact), ["Base.update", "Base.save"]);
});

test("a call on a receiver of a declared type that cannot be proven lists only the declarations of that type's hierarchy", async () => {
  const fact = await trace(typed, "Uses", "Uses.merge");

  assert.deepEqual((fact.cuts ?? []).map(({ reason }) => reason), ["receiver-unproven"]);
  assert.deepEqual(listed(fact.cuts![0]!), ["Detailed", "Problem"]);
});

test("a construction whose written arguments only one constructor accepts is that constructor's step, not a cut", async () => {
  const fact = await trace(typed, "Uses", "Uses.make");

  assert.deepEqual((fact.cuts ?? []).map(({ reason }) => reason), []);
  assert.deepEqual(stepsOf(fact), ["Coded.Coded"]);
});

test("a this call in an inherited body dispatches over the types below the entered class only, and a call through the owner's type over every type below the owner", async () => {
  const entered = await trace(closed, "Alpha", "Alpha.run");
  const typedBase = await trace(closed, "Caller", "Caller.call");

  assert.deepEqual(entered.cuts ?? [], []);
  assert.deepEqual(stepsOf(entered), ["Base.update", "Base.save"]);
  assert.deepEqual((typedBase.cuts ?? []).map((cut) => `${cut.reason} ${listed(cut)}`), ["dispatch Beta", "dispatch Beta"]);
});

test("a declaration reached first by an entered class and again through the owner's type still cuts its dispatch for the second reach", async () => {
  const fact = await trace(closed, "Alpha", "Alpha.run", "Caller.java:Caller.call");

  assert.deepEqual((fact.cuts ?? []).map((cut) => `${cut.reason} ${listed(cut)}`), ["dispatch Beta", "dispatch Beta"]);
});
