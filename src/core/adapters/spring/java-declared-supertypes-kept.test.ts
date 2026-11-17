import assert from "node:assert/strict";
import test from "node:test";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ConstructedClassSite } from "../../ports/import-origins.port.ts";
import { createJavaParser, createJavaTreeHolds } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaNameBindings } from "./java-name-bindings.adapter.ts";
import { java, edited, rememberingFacts } from "./remembering-facts.testing.ts";

const SLOT = "java-declared-supertypes";
const BASE = java("Base", ["package app;", "", "public class Base {}"]);
const STORE = java("Store", ["package app;", "", "public interface Store {}"]);
const DISK = java("Disk", ["package app;", "", "import app.wide.*;", "", "public class Disk extends Base implements Store, Wide {}"]);
const TOOL = java("Tool", ["package app;", "", "public class Tool extends java.util.ArrayList<String> {}"]);
const UNIT = java("Unit", ["package app;", "", "public enum Unit {", "  ONE {", "    int area() { return 1; }", "  },", "  TWO;", "", "  int area() { return 2; }", "}"]);
const UNRELATED = java("Unrelated", ["package app;", "", "class Unrelated {", "  int count() { return 1; }", "}"]);
const SOURCES = [BASE, STORE, DISK, TOOL, UNIT, UNRELATED];
const WIDE = java("Wide", ["package app.wide;", "", "public interface Wide {}"], "app/wide");

const declaration = (file: SourceFile, name: string): ConstructedClassSite => ({ file: file.path, line: file.content.split("\n").findIndex((text) => new RegExp(`(class|interface|enum) ${name}\\b`).test(text)) + 1, name });
const SITES = [declaration(DISK, "Disk"), declaration(TOOL, "Tool"), declaration(BASE, "Base"), { file: UNIT.path, line: 4, name: "ONE" }];
const FILES_OF_SITES = 4;

async function readKept(facts: ReturnType<typeof rememberingFacts>, sources: readonly SourceFile[], sites = SITES, paths = sources.map(({ path }) => path)) {
  const holds = createJavaTreeHolds();
  const hold = holds.open();
  try {
    return await createJavaNameBindings(() => createJavaParser(holds), sources, paths, facts, hold).declaredSupertypes!(sites);
  } finally {
    hold.release();
  }
}

const cold = (sources: readonly SourceFile[], sites = SITES, paths = sources.map(({ path }) => path)) => createJavaNameBindings(createJavaParser, sources, paths).declaredSupertypes!(sites);
const turn = (facts: ReturnType<typeof rememberingFacts>) => facts.readsOf(SLOT);
const replacing = (file: SourceFile, next: SourceFile) => SOURCES.map((each) => (each === file ? next : each));

test("the declared supertypes kept per file answer the bytes of a read without facts, and an edit of a file no clause read derives none", async () => {
  const facts = rememberingFacts();
  const first = await readKept(facts, SOURCES);
  assert.deepEqual(first, await cold(SOURCES));
  assert.deepEqual(first.map(({ kind }) => kind), ["supertypes", "supertypes", "supertypes", "supertypes"]);
  assert.deepEqual(turn(facts), { hits: 0, misses: FILES_OF_SITES });
  const sources = replacing(UNRELATED, edited(UNRELATED, ["return 1;", "return 2;"]));
  assert.deepEqual(await readKept(facts, sources), first);
  assert.deepEqual(turn(facts), { hits: FILES_OF_SITES, misses: FILES_OF_SITES });
});

test("an edit of a file with sites derives that file, and an edit of a file whose type a clause named derives the files that named it", async () => {
  const facts = rememberingFacts();
  await readKept(facts, SOURCES);
  const tool = edited(TOOL, ["public class", "// a comment\npublic class"]);
  const toolSources = replacing(TOOL, tool);
  const sites = [SITES[0]!, declaration(tool, "Tool"), SITES[2]!, SITES[3]!];
  assert.deepEqual(await readKept(facts, toolSources, sites), await cold(toolSources, sites));
  assert.deepEqual(turn(facts), { hits: FILES_OF_SITES - 1, misses: FILES_OF_SITES + 1 });
  const base = edited(BASE, ["public class", "// a comment\npublic class"]);
  const baseSources = replacing(BASE, base);
  const baseSites = [SITES[0]!, SITES[1]!, declaration(base, "Base"), SITES[3]!];
  assert.deepEqual(await readKept(facts, baseSources, baseSites), await cold(baseSources, baseSites));
  assert.deepEqual(turn(facts), { hits: FILES_OF_SITES - 1 + FILES_OF_SITES - 2, misses: FILES_OF_SITES + 1 + 2 });
});

test("a type that appears under a name a clause leaves outside derives the file that wrote the clause, and no other", async () => {
  const facts = rememberingFacts();
  const before = await readKept(facts, SOURCES);
  const sources = [...SOURCES, WIDE];
  const after = await readKept(facts, sources);
  assert.deepEqual(after, await cold(sources));
  assert.notDeepEqual(after, before);
  assert.deepEqual(turn(facts), { hits: FILES_OF_SITES - 1, misses: FILES_OF_SITES + 1 });
});

test("an enum constant with a class body extends its enum by its own file's types, and a constant without one places nothing", async () => {
  const facts = rememberingFacts();
  const sites = [{ file: UNIT.path, line: 4, name: "ONE" }, { file: UNIT.path, line: 7, name: "TWO" }];
  const answers = await readKept(facts, SOURCES, sites);
  assert.deepEqual(answers, await cold(SOURCES, sites));
  assert.deepEqual(answers.map(({ kind }) => kind), ["supertypes", "unknown"]);
  assert.deepEqual(turn(facts), { hits: 0, misses: 1 });
});

const TASK = java("Task", ["package app;", "", "public interface Task { void run(); }"]);
const REPO = java("Repo", ["package app;", "", "public abstract class Repo extends Base {", "  protected Repo(Task task) {", "    int y = 1;", "    super(y);", "    task.run();", "  }", "}"]);
const MYSTERY = java("Mystery", ["package app;", "", "import java.util.*;", "", "public class Mystery extends Unlisted {}"]);

test("a source that does not parse leaves every clause unproven, and a source whose errors lie in a body does not", async () => {
  const facts = rememberingFacts();
  const sources = [...SOURCES, TASK, REPO];
  const sites = [SITES[0]!, declaration(REPO, "Repo")];
  const answers = await readKept(facts, sources, sites);
  assert.deepEqual(answers, await cold(sources, sites));
  assert.deepEqual(answers.map(({ kind }) => kind), ["supertypes", "supertypes"]);
  const broken = [...SOURCES, java("Broken", ["package app;", "class {"])];
  const unproven = await readKept(facts, broken, SITES);
  assert.deepEqual(unproven, await cold(broken));
  assert.deepEqual(unproven.map(({ kind }) => kind), ["unknown", "unknown", "unknown", "supertypes"]);
});

test("a JVM source no extractor reads leaves every clause unproven, though the enum constant its own file settles stays placed", async () => {
  const facts = rememberingFacts();
  const paths = [...SOURCES.map(({ path }) => path), "src/main/kotlin/Twin.kt"];
  const answers = await readKept(facts, SOURCES, SITES, paths);
  assert.deepEqual(answers, await cold(SOURCES, SITES, paths));
  assert.deepEqual(answers.map(({ kind }) => kind), ["unknown", "unknown", "unknown", "supertypes"]);
});

test("a type declared by a source whose errors lie in a body is placed where it is, and moving it derives the clause that names it", async () => {
  const facts = rememberingFacts();
  const child = java("Child", ["package app;", "", "public class Child extends Repo {}"]);
  const sources = [...SOURCES, TASK, REPO, child];
  const sites = [declaration(child, "Child")];
  const placed = await readKept(facts, sources, sites);
  assert.deepEqual(placed, await cold(sources, sites));
  assert.deepEqual(placed.map(({ kind }) => kind), ["supertypes"]);
  const moved = [...SOURCES, TASK, edited(REPO, ["public abstract class", "// a comment\npublic abstract class"]), child];
  const after = await readKept(facts, moved, sites);
  assert.deepEqual(after, await cold(moved, sites));
  assert.notDeepEqual(after, placed);
  assert.deepEqual(turn(facts), { hits: 0, misses: 2 });
});

test("a package a source whose errors lie in a body declares under a platform one is asked too: editing it derives the clauses that name a type that package's siblings may offer", async () => {
  const facts = rememberingFacts();
  const claiming = java("Claiming", ["package java.util.sample;", "", "public class Claiming {", "  Claiming() {", "    int y = 1;", "    super(y);", "  }", "}"], "java/util/sample");
  const sources = [...SOURCES, MYSTERY, claiming];
  const sites = [declaration(MYSTERY, "Mystery")];
  const claimed = await readKept(facts, sources, sites);
  assert.deepEqual(claimed, await cold(sources, sites));
  const released = [...SOURCES, MYSTERY, { ...claiming, content: claiming.content.replace("util.sample;", "util2.sample;") }];
  const after = await readKept(facts, released, sites);
  assert.deepEqual(after, await cold(released, sites));
  assert.notDeepEqual(after, claimed);
  assert.deepEqual(turn(facts), { hits: 0, misses: 2 });
});
