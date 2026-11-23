import assert from "node:assert/strict";
import { test } from "node:test";
import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import { createJavaNameBindings } from "../core/adapters/spring/java-name-bindings.adapter.ts";
import { createJavaParser, createJavaTreeHolds } from "../core/adapters/tree-sitter/java-parser.adapter.ts";
import { createDerivedFacts } from "../core/application/snapshot/derived-facts.ts";
import { createSnapshotDataCache } from "../core/application/snapshot/snapshot-data-cache.ts";
import type { DerivedFacts } from "../core/ports/derived-facts.port.ts";
import type { SourceFile } from "../core/ports/entrypoint-extractor.port.ts";
import type { ImplementingSite } from "../core/ports/import-origins.port.ts";

const SLOT = "java-outside-supertypes";
const java = (name: string, lines: readonly string[], directory = "app"): SourceFile => ({ path: `src/main/java/${directory}/${name}.java`, content: `${lines.join("\n")}\n` });
const API = java("Api", ["package app;", "", "public class Api implements java.io.Serializable, Comparable<Api> {", "  public String get(String key) { return key; }", "  public static String make(String key) { return key; }", "  public int compareTo(Api other) { return 0; }", "}"]);
const SUB = java("Sub", ["package app;", "", "public class Sub extends Api implements java.util.function.Supplier<String> {", "  public String get() { return \"\"; }", "}"]);
const HANDLER = java("Handler", ["package app;", "", "public interface Handler {", "  void on(String event);", "}"]);
const PORT = java("Port", ["package app;", "", "public interface Port {", "  String handle(String in);", "}"]);
const UNRELATED = java("Unrelated", ["package app;", "", "class Unrelated {", "  int count() { return 1; }", "}"]);
const SOURCES = [API, SUB, HANDLER, PORT, UNRELATED];
const SITES: ImplementingSite[] = [{ file: API.path, start: 4, name: "get" }, { file: API.path, start: 5, name: "make" }, { file: HANDLER.path, start: 4, name: "on" }, { file: PORT.path, start: 4, name: "handle" }, { file: SUB.path, start: 4, name: "get" }];
const PATHS = (sources: readonly SourceFile[]) => sources.map(({ path }) => path);

/** One process: a memory tier kept across reads, over which each read lists the files whose outside supertypes were derived again. */
function oneProcess() {
  const cache = createSnapshotDataCache(32 * 1024 * 1024);
  const digest = createSha256Digest();
  const holds = createJavaTreeHolds();
  return async (sources: readonly SourceFile[], paths: readonly string[] = PATHS(sources)) => {
    const facts = createDerivedFacts(cache, digest, "untrusted");
    const derived = new Set<string>();
    const listing: DerivedFacts = { ...facts, ofReads: (slot, subject, answers, derive) => facts.ofReads(slot, subject, answers, (record) => (slot === SLOT && derived.add((subject as { path: string }).path), derive(record))) };
    const hold = holds.open();
    try {
      const answers = await createJavaNameBindings(() => createJavaParser(holds), sources, paths, listing, hold).outsideSupertypes!(SITES);
      return { answers: JSON.stringify(answers), derived: [...derived].sort() };
    } finally {
      hold.release();
    }
  };
}

const cold = async (sources: readonly SourceFile[], paths: readonly string[] = PATHS(sources)) => JSON.stringify(await createJavaNameBindings(createJavaParser, sources, paths).outsideSupertypes!(SITES));
const replaced = (file: SourceFile, from: string, to: string): SourceFile => ({ path: file.path, content: file.content.replace(from, to) });
const swap = (sources: readonly SourceFile[], file: SourceFile) => sources.map((source) => (source.path === file.path ? file : source));

test("after a body edit of a file no closure reads, only the outside supertypes of closures with a functional interface are derived again", async () => {
  const read = oneProcess();
  await read(SOURCES);
  const after = await read(swap(SOURCES, replaced(UNRELATED, "return 1;", "return 2;")));
  assert.deepEqual(after.derived, [HANDLER.path, PORT.path]);
});

test("a signature edit that changes a supertype outside the repository of a type below the owner derives the owner's file again, and equals a cold read", async () => {
  const read = oneProcess();
  const before = await read(SOURCES);
  const sources = swap(SOURCES, replaced(SUB, "java.util.function.Supplier<String>", "java.util.concurrent.Callable<String>"));
  const after = await read(sources);
  assert.ok(after.derived.includes(API.path));
  assert.notEqual(after.answers, before.answers);
  assert.equal(after.answers, await cold(sources));
});

test("after every kind of edit the kept outside supertypes equal a cold read", async () => {
  const edits: readonly { name: string; sources: readonly SourceFile[]; paths?: readonly string[] }[] = [
    { name: "a type renamed", sources: swap(SOURCES, replaced(API, "class Api implements", "class Root implements")) },
    { name: "a package moved", sources: swap(SOURCES, replaced(SUB, "package app;", "package app.inner;")) },
    { name: "a platform package claimed", sources: swap(SOURCES, replaced(API, "package app;", "package java.io;")) },
    { name: "an introduction", sources: swap(SOURCES, replaced(UNRELATED, "int count()", "@DeclareParents(\"app.*\") Object mixin; int count()")) },
    { name: "an anonymous class below the owner", sources: swap(SOURCES, replaced(UNRELATED, "return 1;", "Object o = new Api() {}; return 1;")) },
    { name: "a function value of the functional interface", sources: swap(SOURCES, replaced(UNRELATED, "return 1;", "Port port = in -> in; return 1;")) },
    { name: "a file that appears", sources: [...SOURCES, java("Late", ["package app;", "", "class Late extends Sub implements Runnable {", "  public void run() {}", "}"])] },
    { name: "a file that disappears", sources: SOURCES.filter((source) => source !== SUB) },
    { name: "a file that stops parsing", sources: swap(SOURCES, { path: UNRELATED.path, content: "package app; class {" }) },
    { name: "a body that stops parsing", sources: swap(SOURCES, replaced(UNRELATED, "return 1;", "return 1 +;")) },
    { name: "the inputs", sources: SOURCES, paths: [...PATHS(SOURCES), "src/main/kotlin/Twin.kt"] },
  ];
  const base = await cold(SOURCES);
  for (const edit of edits) {
    const read = oneProcess();
    await read(SOURCES);
    const expected = await cold(edit.sources, edit.paths);
    assert.notEqual(expected, base, edit.name);
    assert.equal((await read(edit.sources, edit.paths)).answers, expected, edit.name);
  }
});
