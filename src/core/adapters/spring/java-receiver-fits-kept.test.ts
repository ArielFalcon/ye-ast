import assert from "node:assert/strict";
import test from "node:test";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ReceiverFitSite } from "../../ports/import-origins.port.ts";
import { createJavaParser, createJavaTreeHolds } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaNameBindings } from "./java-name-bindings.adapter.ts";
import { java, edited, rememberingFacts } from "./remembering-facts.testing.ts";

const SLOT = "java-receiver-fits";
const MAPPER = java("Mapper", ["package app;", "", "public interface Mapper<S, T> {", "  T convert(S source);", "}"]);
const TYPES = java("Types", ["package app;", "", "class Tax {}", "class Rate {}", "class Cat {}", "class Entry {}"]);
const TAX_MAPPER = java("TaxMapper", ["package app;", "", "public class TaxMapper implements Mapper<Tax, Rate> {", "", "  public Rate convert(int source) { return null; }", "  public Rate convert(Tax source) { return null; }", "}"]);
const user = (name: string, field: string): SourceFile => java(name, ["package app;", "", `class ${name} {`, `  ${field} mapper;`, "  void run() { mapper.convert(null); }", "}"]);
const OTHER = user("Other", "Mapper<Cat, Entry>");
const SAME = user("Same", "Mapper<Tax, Rate>");
const UNRELATED = java("Unrelated", ["package app;", "", "class Unrelated {", "  int count() { return 1; }", "}"]);
const SOURCES = [MAPPER, TYPES, TAX_MAPPER, OTHER, SAME, UNRELATED];

const siteIn = (file: SourceFile): ReceiverFitSite => {
  const line = file.content.split("\n").findIndex((text) => text.includes("mapper.convert("));
  return { file: file.path, line: line + 1, column: file.content.split("\n")[line]!.indexOf("{ ") + 3, member: "convert", implementation: { file: TAX_MAPPER.path, start: 6, name: "convert" } };
};
const SITES = [siteIn(OTHER), siteIn(SAME)];
const FILES_OF_SITES = 2;

async function readKept(facts: ReturnType<typeof rememberingFacts>, sources: readonly SourceFile[], paths = sources.map(({ path }) => path)) {
  const holds = createJavaTreeHolds();
  const hold = holds.open();
  try {
    return await createJavaNameBindings(() => createJavaParser(holds), sources, paths, facts, hold).receiverFits!(SITES);
  } finally {
    hold.release();
  }
}

const cold = (sources: readonly SourceFile[], paths = sources.map(({ path }) => path)) => createJavaNameBindings(createJavaParser, sources, paths).receiverFits!(SITES);
const turn = (facts: ReturnType<typeof rememberingFacts>) => facts.readsOf(SLOT);
const replacing = (file: SourceFile, next: SourceFile) => SOURCES.map((each) => (each === file ? next : each));

test("the receiver fits kept per file of calls answer the bytes of a read without facts, and an edit of a file no call read derives none", async () => {
  const facts = rememberingFacts();
  const first = await readKept(facts, SOURCES);
  assert.deepEqual(first, await cold(SOURCES));
  assert.deepEqual(first.map(({ kind }) => kind), ["disjoint", "unknown"]);
  assert.deepEqual(turn(facts), { hits: 0, misses: FILES_OF_SITES });
  const sources = replacing(UNRELATED, edited(UNRELATED, ["return 1;", "return 2;"]));
  assert.deepEqual(await readKept(facts, sources), first);
  assert.deepEqual(turn(facts), { hits: FILES_OF_SITES, misses: FILES_OF_SITES });
});

test("an edit of the class that declares the implementation derives the files whose calls read its clause", async () => {
  const facts = rememberingFacts();
  await readKept(facts, SOURCES);
  const sources = replacing(TAX_MAPPER, edited(TAX_MAPPER, ["Mapper<Tax, Rate>", "Mapper<Cat, Entry>"]));
  const after = await readKept(facts, sources);
  assert.deepEqual(after, await cold(sources));
  assert.deepEqual(after.map(({ kind }) => kind), ["unknown", "disjoint"]);
  assert.deepEqual(turn(facts), { hits: 0, misses: FILES_OF_SITES * 2 });
});

test("the types an argument names that stop being declared derive the file that wrote them, and the answer is unknown", async () => {
  const facts = rememberingFacts();
  await readKept(facts, SOURCES);
  const sources = replacing(TYPES, edited(TYPES, ["class Cat {}\nclass Entry {}\n", ""]));
  const after = await readKept(facts, sources);
  assert.deepEqual(after, await cold(sources));
  assert.deepEqual(after.map(({ kind }) => kind), ["unknown", "unknown"]);
  assert.ok(turn(facts).misses > FILES_OF_SITES);
});

test("a call-rewriting annotation anywhere, or a JVM source no extractor reads, leaves every fit unknown and derives every file", async () => {
  const facts = rememberingFacts();
  await readKept(facts, SOURCES);
  const rewriting = [...SOURCES, java("Delegating", ["package app;", "", "@lombok.experimental.Delegate", "class Delegating {}"])];
  const unknown = await readKept(facts, rewriting);
  assert.deepEqual(unknown, await cold(rewriting));
  assert.deepEqual(unknown.map(({ kind }) => kind), ["unknown", "unknown"]);
  assert.deepEqual(turn(facts), { hits: 0, misses: FILES_OF_SITES * 2 });
  const paths = [...SOURCES.map(({ path }) => path), "src/main/kotlin/Twin.kt"];
  assert.deepEqual(await readKept(facts, SOURCES, paths), await cold(SOURCES, paths));
});

test("a call whose implementation's file is absent is derived again when that file appears, and again when it leaves", async () => {
  const facts = rememberingFacts();
  const without = SOURCES.filter((source) => source !== TAX_MAPPER);
  assert.deepEqual(await readKept(facts, without), await cold(without));
  assert.deepEqual(await readKept(facts, SOURCES), await cold(SOURCES));
  assert.deepEqual(await readKept(facts, without), await cold(without));
  assert.deepEqual(await readKept(facts, SOURCES), await cold(SOURCES));
});

test("a hold released while a query derives file after file is refused at the next file, never read as an empty project", async () => {
  const facts = rememberingFacts();
  const holds = createJavaTreeHolds();
  const hold = holds.open();
  const releasing = { ...facts, ofReads: (async (...args: Parameters<typeof facts.ofReads>) => {
    const kept = await facts.ofReads(...args);
    hold.release();
    return kept;
  }) as typeof facts.ofReads };
  await assert.rejects(createJavaNameBindings(() => createJavaParser(holds), SOURCES, SOURCES.map(({ path }) => path), releasing, hold).receiverFits!(SITES), { name: "ReleasedParseHoldError" });
});
