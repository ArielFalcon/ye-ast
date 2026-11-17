import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { UseSite } from "../../ports/import-origins.port.ts";
import { createJavaParser, createJavaTreeHolds } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaDeclaredTypes } from "./java-declared-types.ts";
import { createJavaNameBindings } from "./java-name-bindings.adapter.ts";
import { java, edited, rememberingFacts } from "./remembering-facts.testing.ts";

const SLOT = "java-declared-types";
const GATE = "java-opens-platform-types";
const ORDERS = java("Orders", ["package app;", "", "import java.util.List;", "", "class Orders {", "  void run(List<String> items) {}", "}"]);
const ITEMS = java("Items", ["package app;", "", "import java.util.Map;", "", "class Items {", "  void put(Map<String, String> items) {}", "}"]);
const UNRELATED = java("Unrelated", ["package app;", "", "class Unrelated {", "  int count() { return 1; }", "}"]);
const SOURCES = [ORDERS, ITEMS, UNRELATED];

const at = (file: SourceFile, spelled: string): UseSite => {
  const lines = file.content.split("\n");
  const line = lines.findIndex((text) => text.includes(`${spelled}<`));
  return { file: file.path, line: line + 1, column: lines[line]!.indexOf(spelled) + 1, spelled, owner: { name: "run", line: line + 1, endLine: line + 1 } };
};
const SITES = [at(ORDERS, "List"), at(ITEMS, "Map")];
const FILES_OF_SITES = 2;

async function readKept(facts: ReturnType<typeof rememberingFacts>, sources: readonly SourceFile[]) {
  const holds = createJavaTreeHolds();
  const hold = holds.open();
  try {
    return await createJavaNameBindings(() => createJavaParser(holds), sources, sources.map(({ path }) => path), facts, hold).declaredTypes(SITES);
  } finally {
    hold.release();
  }
}

const cold = (sources: readonly SourceFile[]) => createJavaDeclaredTypes(createJavaParser, sources, sources.map(({ path }) => path))(SITES);
const turn = (facts: ReturnType<typeof rememberingFacts>, slot = SLOT) => facts.readsOf(slot);
const replacing = (file: SourceFile, next: SourceFile) => SOURCES.map((each) => (each === file ? next : each));

test("the declared types kept per file of sites answer the bytes of a read without facts, and a declaration added where no derivation's answer moves is a hit", async () => {
  const facts = rememberingFacts();
  const first = await readKept(facts, SOURCES);
  assert.deepEqual(first, await cold(SOURCES));
  assert.deepEqual(first, [{ kind: "package", module: "java.util", name: "List" }, { kind: "package", module: "java.util", name: "Map" }]);
  assert.deepEqual([turn(facts), turn(facts, GATE)], [{ hits: 0, misses: FILES_OF_SITES }, { hits: 0, misses: SOURCES.length }]);
  const sources = replacing(UNRELATED, edited(UNRELATED, ["class Unrelated {", "class Extra {}\nclass Unrelated {"]));
  assert.deepEqual(await readKept(facts, sources), first);
  assert.deepEqual([turn(facts), turn(facts, GATE)], [{ hits: FILES_OF_SITES, misses: FILES_OF_SITES }, { hits: SOURCES.length - 1, misses: SOURCES.length + 1 }]);
});

test("a source that claims the platform package derives each file of sites whose answer rested on the claim, and the answers turn unknown", async () => {
  const facts = rememberingFacts();
  await readKept(facts, SOURCES);
  const claiming = [...SOURCES, java("Own", ["package java.util.own;", "", "public class Own {}"], "java/util/own")];
  const after = await readKept(facts, claiming);
  assert.deepEqual(after, await cold(claiming));
  assert.deepEqual(after, [{ kind: "unknown" }, { kind: "unknown" }]);
  assert.deepEqual(turn(facts), { hits: 0, misses: FILES_OF_SITES * 2 });
});

test("a function value in any file opens every platform type, so no file of sites is derived and every answer is unknown", async () => {
  const facts = rememberingFacts();
  await readKept(facts, SOURCES);
  const opening = replacing(UNRELATED, edited(UNRELATED, ["return 1;", "Runnable r = () -> {}; return 1;"]));
  const after = await readKept(facts, opening);
  assert.deepEqual(after, await cold(opening));
  assert.deepEqual(after, [{ kind: "unknown" }, { kind: "unknown" }]);
  assert.deepEqual(turn(facts), { hits: 0, misses: FILES_OF_SITES });
});

test("the derivations of a file's declared types and of whether it opens platform types enumerate no type of the project", () => {
  const read = (file: string, from: string, to: string) => {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    return text.slice(text.indexOf(from), text.indexOf(to));
  };
  const kept = read("./java-name-bindings.adapter.ts", "async function keptDeclaredTypes", "const declaredPlaceOf");
  const derivations = read("./java-declared-types.ts", "export function declaredTypeAt", "export function supertypesOf");
  assert.ok(kept.length > 800 && derivations.length > 1200);
  for (const derivation of [kept, derivations]) assert.doesNotMatch(derivation, /\bproject\.(types|unreadable)\b/);
});
