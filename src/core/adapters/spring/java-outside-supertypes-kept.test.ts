import assert from "node:assert/strict";
import test from "node:test";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ImplementingSite } from "../../ports/import-origins.port.ts";
import { createJavaParser, createJavaTreeHolds } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaNameBindings } from "./java-name-bindings.adapter.ts";
import { java, rememberingFacts } from "./remembering-facts.testing.ts";

const SLOT = "java-outside-supertypes";
const API = java("Api", ["package app;", "", "public class Api {", "  public String get(String key) { return key; }", "  public static String make(String key) { return key; }", "}"]);
const SUB = java("Sub", ["package app;", "", "public class Sub extends Api implements java.util.function.Supplier<String> {", "  public String get() { return \"\"; }", "}"]);
const UNRELATED = java("Unrelated", ["package app;", "", "class Unrelated {", "  int count() { return 1; }", "}"]);
const SOURCES = [API, UNRELATED];
const SITES: ImplementingSite[] = [{ file: API.path, start: 4, name: "get" }, { file: API.path, start: 5, name: "make" }];

async function readKept(facts: ReturnType<typeof rememberingFacts>, sources: readonly SourceFile[], sites = SITES, paths = sources.map(({ path }) => path)) {
  const holds = createJavaTreeHolds();
  const hold = holds.open();
  try {
    return await createJavaNameBindings(() => createJavaParser(holds), sources, paths, facts, hold).outsideSupertypes!(sites);
  } finally {
    hold.release();
  }
}

const cold = (sources: readonly SourceFile[], sites = SITES, paths = sources.map(({ path }) => path)) => createJavaNameBindings(createJavaParser, sources, paths).outsideSupertypes!(sites);
const turn = (facts: ReturnType<typeof rememberingFacts>) => facts.readsOf(SLOT);

test("the outside supertypes kept answer the bytes of a read without facts, and an unchanged read derives nothing", async () => {
  const facts = rememberingFacts();
  const first = await readKept(facts, SOURCES);
  assert.deepEqual(first, await cold(SOURCES));
  assert.deepEqual(first.map(({ kind }) => kind), ["types", "types"]);
  assert.deepEqual(turn(facts), { hits: 0, misses: 1 });
  assert.deepEqual(await readKept(facts, SOURCES), first);
  assert.deepEqual(turn(facts), { hits: 1, misses: 1 });
});

test("an edit of any source derives the answer again, so a type that appears below the owner is listed", async () => {
  const facts = rememberingFacts();
  const before = await readKept(facts, SOURCES);
  const sources = [...SOURCES, SUB];
  const after = await readKept(facts, sources);
  assert.deepEqual(after, await cold(sources));
  assert.notDeepEqual(after, before);
  assert.deepEqual(turn(facts), { hits: 0, misses: 2 });
});

test("another set of sites is another derivation, and a JVM source no extractor reads leaves every method unknown", async () => {
  const facts = rememberingFacts();
  await readKept(facts, SOURCES);
  await readKept(facts, SOURCES, [SITES[0]!]);
  assert.deepEqual(turn(facts), { hits: 0, misses: 2 });
  const paths = [...SOURCES.map(({ path }) => path), "src/main/kotlin/Twin.kt"];
  const unknown = await readKept(facts, SOURCES, SITES, paths);
  assert.deepEqual(unknown, await cold(SOURCES, SITES, paths));
  assert.deepEqual(unknown, [{ kind: "unknown" }, { kind: "unknown" }]);
  assert.deepEqual(turn(facts), { hits: 0, misses: 3 });
});
