import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { UseSite } from "../../ports/import-origins.port.ts";
import { createJavaParser, createJavaTreeHolds } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaNameBindings } from "./java-name-bindings.adapter.ts";
import { createJavaRootBindings } from "./java-root-bindings.ts";
import { java, edited, rememberingFacts } from "./remembering-facts.testing.ts";

const SLOT = "java-root-bindings";
const HELPER = java("Helper", ["package app;", "", "public class Helper {", "  public static int run() { return 1; }", "}"]);
const CALLER = java("Caller", ["package app;", "", "class Caller {", "  int go() { return Helper.run(); }", "}"]);
const MAKER = java("Maker", ["package app;", "import java.util.Optional;", "", "class Maker {", "  Object make() { return Optional.empty(); }", "}"]);
const UNRELATED = java("Unrelated", ["package app;", "", "class Unrelated {", "  int count() { return 1; }", "}"]);
const SOURCES = [HELPER, CALLER, MAKER, UNRELATED];

const at = (file: SourceFile, written: string, spelled: string, owner: string): UseSite => {
  const lines = file.content.split("\n");
  const line = lines.findIndex((text) => text.includes(written));
  return { file: file.path, line: line + 1, column: lines[line]!.indexOf(written) + 1, spelled, owner: { name: owner, line: line + 1, endLine: line + 1 } };
};
const SITES = [at(CALLER, "Helper.run()", "Helper", "go"), at(MAKER, "Optional.empty()", "Optional", "make")];
const FILES_OF_SITES = 2;

async function readKept(facts: ReturnType<typeof rememberingFacts>, sources: readonly SourceFile[]) {
  const holds = createJavaTreeHolds();
  const hold = holds.open();
  try {
    return await createJavaNameBindings(() => createJavaParser(holds), sources, sources.map(({ path }) => path), facts, hold).rootBindings(SITES);
  } finally {
    hold.release();
  }
}

const cold = (sources: readonly SourceFile[]) => createJavaRootBindings(createJavaParser(), sources)(SITES);
const turn = (facts: ReturnType<typeof rememberingFacts>) => facts.readsOf(SLOT);
const replacing = (file: SourceFile, next: SourceFile) => SOURCES.map((each) => (each === file ? next : each));

test("the root bindings kept per file of sites answer the bytes of a read without facts, and a declaration added where no derivation's answer moves is a hit", async () => {
  const facts = rememberingFacts();
  const first = await readKept(facts, SOURCES);
  assert.deepEqual(first, await cold(SOURCES));
  assert.deepEqual(first, [{ kind: "located", root: "Helper", file: HELPER.path, path: "app.Helper" }, { kind: "import", root: "Optional", origin: { kind: "external", module: "java.util" } }]);
  assert.deepEqual(turn(facts), { hits: 0, misses: FILES_OF_SITES });
  const sources = replacing(UNRELATED, edited(UNRELATED, ["class Unrelated {", "class Extra {}\nclass Unrelated {"]));
  assert.deepEqual(await readKept(facts, sources), first);
  assert.deepEqual(turn(facts), { hits: FILES_OF_SITES, misses: FILES_OF_SITES });
});

test("an edit of another file that changes a recorded answer derives the file of sites that asked it, and the other file is a hit", async () => {
  const facts = rememberingFacts();
  await readKept(facts, SOURCES);
  const sources = replacing(HELPER, edited(HELPER, ["class Helper", "class Assistant"]));
  const after = await readKept(facts, sources);
  assert.deepEqual(after, await cold(sources));
  assert.deepEqual(after[0], { kind: "unknown" });
  assert.deepEqual(turn(facts), { hits: 1, misses: FILES_OF_SITES + 1 });
});

test("a type declared under a platform name's package claims it, so the file whose platform import rested on the claim derives again", async () => {
  const facts = rememberingFacts();
  await readKept(facts, SOURCES);
  const claiming = [...SOURCES, java("Own", ["package java.util.own;", "", "public class Own {}"], "java/util/own")];
  const after = await readKept(facts, claiming);
  assert.deepEqual(after, await cold(claiming));
  assert.deepEqual(turn(facts), { hits: 1, misses: FILES_OF_SITES + 1 });
});

test("the derivation of a file's bindings enumerates no type of the project: a read of another file goes through a recorded question", () => {
  const text = readFileSync(new URL("./java-root-bindings.ts", import.meta.url), "utf8");
  const derivation = text.slice(text.indexOf("function bindingsAt"));
  assert.ok(derivation.length > 3000);
  assert.doesNotMatch(derivation, /\bproject\.types\b/);
});
