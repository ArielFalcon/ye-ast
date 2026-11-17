import assert from "node:assert/strict";
import test from "node:test";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ImplementingSite } from "../../ports/import-origins.port.ts";
import { createJavaParser, createJavaTreeHolds } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaNameBindings } from "./java-name-bindings.adapter.ts";
import { java, edited, rememberingFacts } from "./remembering-facts.testing.ts";

const SLOT = "java-implemented-declarations";
const STORE = java("Store", ["package app;", "", "public interface Store {", "  void save(String value);", "}"]);
const DISK = java("Disk", ["package app;", "", "import app.wide.*;", "", "public class Disk implements Store, Wide {", "  public void save(String value) {}", "}"]);
const TOOL = java("Tool", ["package app;", "", "public class Tool {", "  public void use() {}", "}"]);
const UNRELATED = java("Unrelated", ["package app;", "", "class Unrelated {", "  int count() { return 1; }", "}"]);
const SOURCES = [STORE, DISK, TOOL, UNRELATED];
const WIDE = java("Wide", ["package app.wide;", "", "public interface Wide {", "  void save(String value);", "}"], "app/wide");

const method = (file: SourceFile, text: string, name: string): ImplementingSite => ({ file: file.path, start: file.content.split("\n").findIndex((each) => each.includes(text)) + 1, name });
const SITES = [method(DISK, "public void save", "save"), method(TOOL, "public void use", "use")];
const FILES_OF_SITES = 2;

async function readKept(facts: ReturnType<typeof rememberingFacts>, sources: readonly SourceFile[], sites = SITES, paths = sources.map(({ path }) => path)) {
  const holds = createJavaTreeHolds();
  const hold = holds.open();
  try {
    return await createJavaNameBindings(() => createJavaParser(holds), sources, paths, facts, hold).implementedDeclarations!(sites);
  } finally {
    hold.release();
  }
}

const cold = (sources: readonly SourceFile[], sites = SITES, paths = sources.map(({ path }) => path)) => createJavaNameBindings(createJavaParser, sources, paths).implementedDeclarations!(sites);
const turn = (facts: ReturnType<typeof rememberingFacts>) => facts.readsOf(SLOT);
const replacing = (file: SourceFile, next: SourceFile) => SOURCES.map((each) => (each === file ? next : each));

test("the implemented declarations kept per file answer the bytes of a read without facts, and an edit of a file no site read derives none", async () => {
  const facts = rememberingFacts();
  const first = await readKept(facts, SOURCES);
  assert.deepEqual(first, await cold(SOURCES));
  assert.deepEqual(first.map(({ kind }) => kind), ["unknown", "declarations"]);
  assert.deepEqual(turn(facts), { hits: 0, misses: FILES_OF_SITES });
  const sources = replacing(UNRELATED, edited(UNRELATED, ["return 1;", "return 2;"]));
  assert.deepEqual(await readKept(facts, sources), first);
  assert.deepEqual(turn(facts), { hits: FILES_OF_SITES, misses: FILES_OF_SITES });
});

test("a supertype that appears where the hierarchy had a gap derives the file whose method read it, and the declarations it finds are the bytes of a read without facts", async () => {
  const facts = rememberingFacts();
  const before = await readKept(facts, SOURCES);
  const sources = [...SOURCES, WIDE];
  const after = await readKept(facts, sources);
  assert.deepEqual(after, await cold(sources));
  assert.notDeepEqual(after, before);
  assert.deepEqual(after[0], { kind: "declarations", declarations: [{ file: STORE.path, start: 4, nameLine: 4 }, { file: WIDE.path, start: 4, nameLine: 4 }] });
  assert.deepEqual(turn(facts), { hits: FILES_OF_SITES - 1, misses: FILES_OF_SITES + 1 });
});

test("an edit of a supertype's file derives the files whose methods read it, and no other", async () => {
  const facts = rememberingFacts();
  const sources = [...SOURCES, WIDE];
  await readKept(facts, sources);
  const edit = sources.map((each) => (each === WIDE ? edited(WIDE, ["void save(String value);", "void save(int value);"]) : each));
  const after = await readKept(facts, edit);
  assert.deepEqual(after, await cold(edit));
  assert.deepEqual(after[0], { kind: "declarations", declarations: [{ file: STORE.path, start: 4, nameLine: 4 }] });
  assert.deepEqual(turn(facts), { hits: FILES_OF_SITES - 1, misses: FILES_OF_SITES + 1 });
});

test("a call-rewriting annotation anywhere, or a JVM source no extractor reads, leaves every method unknown and derives every file", async () => {
  const facts = rememberingFacts();
  await readKept(facts, SOURCES);
  const rewriting = [...SOURCES, java("Delegating", ["package app;", "", "@lombok.experimental.Delegate", "class Delegating {}"])];
  const unknown = await readKept(facts, rewriting);
  assert.deepEqual(unknown, await cold(rewriting));
  assert.deepEqual(unknown.map(({ kind }) => kind), ["unknown", "unknown"]);
  assert.deepEqual(turn(facts), { hits: 0, misses: FILES_OF_SITES * 2 });
  const paths = [...SOURCES.map(({ path }) => path), "src/main/kotlin/Twin.kt"];
  assert.deepEqual(await readKept(facts, SOURCES, SITES, paths), await cold(SOURCES, SITES, paths));
});
