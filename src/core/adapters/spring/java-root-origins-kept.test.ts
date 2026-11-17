import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ResolvedNameSite } from "../../ports/import-origins.port.ts";
import { createJavaParser, createJavaTreeHolds } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaNameBindings } from "./java-name-bindings.adapter.ts";
import { java, edited, rememberingFacts } from "./remembering-facts.testing.ts";

const SLOT = "java-root-origins";
const HELPER = java("Helper", ["package app;", "", "public class Helper {", "  public static int run() { return 1; }", "}"]);
const THING = java("Thing", ["package app;", "", "public class Thing {}"]);
const CALLER = java("Caller", ["package app;", "", "class Caller {", "  int go() { return Helper.run(); }", "}"]);
const MAKER = java("Maker", ["package app;", "", "class Maker {", "  Object make() { new Thread(); return new Thing(); }", "}"]);
const UNRELATED = java("Unrelated", ["package app;", "", "class Unrelated {", "  int count() { return 1; }", "}"]);
const SOURCES = [HELPER, THING, CALLER, MAKER, UNRELATED];

const at = (file: SourceFile, written: string, kind: ResolvedNameSite["kind"], name: string): ResolvedNameSite => {
  const lines = file.content.split("\n");
  const line = lines.findIndex((text) => text.includes(written));
  return { file: file.path, line: line + 1, column: lines[line]!.indexOf(written) + 1, kind, name };
};
const SITES = [at(CALLER, "Helper.run()", "calls", "run"), at(MAKER, "new Thread()", "instantiates", "Thread"), at(MAKER, "new Thing()", "instantiates", "Thing")];
const FILES_OF_SITES = 2;

async function readKept(facts: ReturnType<typeof rememberingFacts>, sources: readonly SourceFile[]) {
  const holds = createJavaTreeHolds();
  const hold = holds.open();
  try {
    return await createJavaNameBindings(() => createJavaParser(holds), sources, sources.map(({ path }) => path), facts, hold).rootOrigins(SITES);
  } finally {
    hold.release();
  }
}

const cold = (sources: readonly SourceFile[]) => createJavaNameBindings(createJavaParser, sources).rootOrigins(SITES);
const turn = (facts: ReturnType<typeof rememberingFacts>) => facts.readsOf(SLOT);
const replacing = (file: SourceFile, next: SourceFile) => SOURCES.map((each) => (each === file ? next : each));
const rooted = (origins: Awaited<ReturnType<typeof cold>>) => origins.map((origin) => (origin.status === "complete" ? origin.value : origin.status));

test("the root origins kept per file of sites answer the bytes of a read without facts, and a declaration added where no derivation's answer moves is a hit", async () => {
  const facts = rememberingFacts();
  const first = await readKept(facts, SOURCES);
  assert.deepEqual(first, await cold(SOURCES));
  assert.deepEqual(rooted(first), [{ kind: "repository", file: HELPER.path, declared: "app.Helper" }, { kind: "external", module: "java.lang" }, { kind: "repository", file: THING.path, declared: "app.Thing" }]);
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
  assert.deepEqual(rooted(after)[0], "unknown");
  assert.deepEqual(turn(facts), { hits: 1, misses: FILES_OF_SITES + 1 });
});

test("a call-rewriting annotation anywhere derives the file whose platform root rested on the strict binding, and leaves that root unknown", async () => {
  const facts = rememberingFacts();
  await readKept(facts, SOURCES);
  const rewriting = [...SOURCES, java("Delegating", ["package app;", "", "@lombok.experimental.Delegate", "class Delegating {}"])];
  const after = await readKept(facts, rewriting);
  assert.deepEqual(after, await cold(rewriting));
  assert.deepEqual(rooted(after)[1], "unknown");
  assert.deepEqual(turn(facts), { hits: 1, misses: FILES_OF_SITES + 1 });
});

test("the derivation of a file's roots enumerates no type of the project: a read of another file goes through a recorded question", () => {
  const text = readFileSync(new URL("./java-name-bindings.adapter.ts", import.meta.url), "utf8");
  const derivation = text.slice(text.indexOf("function rootsAt"), text.indexOf("function declaredBy"));
  assert.ok(derivation.length > 3000);
  assert.doesNotMatch(derivation, /\bproject\.types\b/);
});
