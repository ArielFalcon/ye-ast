import assert from "node:assert/strict";
import test from "node:test";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ConstructedClassSite } from "../../ports/import-origins.port.ts";
import { createJavaParser, createJavaTreeHolds } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaNameBindings } from "./java-name-bindings.adapter.ts";
import { java, edited, rememberingFacts } from "./remembering-facts.testing.ts";

const SLOT = "java-implicit-chains";
const PARENT = java("Parent", ["package app;", "", "public class Parent {", "  public Parent() {}", "}"]);
const CHILD = java("Child", ["package app;", "", "class Child extends Parent {}"]);
const PLAIN = java("Plain", ["package app;", "", "public class Plain {}"]);
const SUB = java("Sub", ["package app;", "", "class Sub extends Plain {}"]);
const BORROWER = java("Borrower", ["package app;", "", "import app.wide.*;", "", "class Borrower extends Wide {}"]);
const KIND = java("Kind", ["package app;", "", "public enum Kind { A }"]);
const UNRELATED = java("Unrelated", ["package app;", "", "class Unrelated {", "  int count() { return 1; }", "}"]);
const SOURCES = [PARENT, CHILD, PLAIN, SUB, BORROWER, KIND, UNRELATED];
const WIDE = java("Wide", ["package app.wide;", "", "public class Wide { public Wide() {} }"], "app/wide");

const declaration = (file: SourceFile, name: string): ConstructedClassSite => ({ file: file.path, line: file.content.split("\n").findIndex((text) => new RegExp(`(class|enum) ${name}\\b`).test(text)) + 1, name });
const SITES = [declaration(CHILD, "Child"), declaration(SUB, "Sub"), declaration(BORROWER, "Borrower"), declaration(KIND, "Kind")];
const FILES_OF_SITES = 4;

async function readKept(facts: ReturnType<typeof rememberingFacts>, sources: readonly SourceFile[], sites = SITES, paths = sources.map(({ path }) => path)) {
  const holds = createJavaTreeHolds();
  const hold = holds.open();
  try {
    return await createJavaNameBindings(() => createJavaParser(holds), sources, paths, facts, hold).implicitChains!(sites);
  } finally {
    hold.release();
  }
}

const cold = (sources: readonly SourceFile[], sites = SITES, paths = sources.map(({ path }) => path)) => createJavaNameBindings(createJavaParser, sources, paths).implicitChains!(sites);
const turn = (facts: ReturnType<typeof rememberingFacts>) => facts.readsOf(SLOT);
const replacing = (file: SourceFile, next: SourceFile) => SOURCES.map((each) => (each === file ? next : each));

test("the implicit chains kept per file answer the bytes of a read without facts, and an edit of a file no chain read derives none", async () => {
  const facts = rememberingFacts();
  const first = await readKept(facts, SOURCES);
  assert.deepEqual(first, await cold(SOURCES));
  assert.deepEqual(first.map(({ kind }) => kind), ["constructor", "supplied", "unknown", "none"]);
  assert.deepEqual(turn(facts), { hits: 0, misses: FILES_OF_SITES });
  const sources = replacing(UNRELATED, edited(UNRELATED, ["return 1;", "return 2;"]));
  assert.deepEqual(await readKept(facts, sources), first);
  assert.deepEqual(turn(facts), { hits: FILES_OF_SITES, misses: FILES_OF_SITES });
});

test("an edit of the superclass's file derives the file whose chain named it, and no other", async () => {
  const facts = rememberingFacts();
  await readKept(facts, SOURCES);
  const sources = replacing(PARENT, edited(PARENT, ["public Parent() {}", "public Parent(int size) {}"]));
  const after = await readKept(facts, sources);
  assert.deepEqual(after, await cold(sources));
  assert.equal(after[0]!.kind, "unknown");
  assert.deepEqual(turn(facts), { hits: FILES_OF_SITES - 1, misses: FILES_OF_SITES + 1 });
});

test("a superclass that appears under a name an on-demand import leaves outside derives the file that wrote it, and no other", async () => {
  const facts = rememberingFacts();
  const before = await readKept(facts, SOURCES);
  const sources = [...SOURCES, WIDE];
  const after = await readKept(facts, sources);
  assert.deepEqual(after, await cold(sources));
  assert.notDeepEqual(after, before);
  assert.deepEqual(turn(facts), { hits: FILES_OF_SITES - 1, misses: FILES_OF_SITES + 1 });
});

test("a superclass that may gain constructors from an annotation leaves the chain unknown", async () => {
  const facts = rememberingFacts();
  const generating = replacing(PLAIN, edited(PLAIN, ["public class Plain", "@lombok.Data public class Plain"]));
  const generated = await readKept(facts, generating);
  assert.deepEqual(generated, await cold(generating));
  assert.equal(generated[1]!.kind, "unknown");
});

test("a call-rewriting annotation anywhere, or a JVM source no extractor reads, leaves every chain unknown and derives every file", async () => {
  const facts = rememberingFacts();
  await readKept(facts, SOURCES);
  const rewriting = [...SOURCES, java("Delegating", ["package app;", "", "@lombok.experimental.Delegate", "class Delegating {}"])];
  const unproven = await readKept(facts, rewriting);
  assert.deepEqual(unproven, await cold(rewriting));
  assert.deepEqual(unproven.map(({ kind }) => kind), ["unknown", "unknown", "unknown", "unknown"]);
  assert.deepEqual(turn(facts), { hits: 0, misses: FILES_OF_SITES * 2 });
  const paths = [...SOURCES.map(({ path }) => path), "src/main/kotlin/Twin.kt"];
  assert.deepEqual(await readKept(facts, SOURCES, SITES, paths), await cold(SOURCES, SITES, paths));
});
