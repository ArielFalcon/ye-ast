import assert from "node:assert/strict";
import test from "node:test";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ReceiverCallSite } from "../../ports/import-origins.port.ts";
import { createJavaParser, createJavaTreeHolds } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaNameBindings } from "./java-name-bindings.adapter.ts";
import { java, edited, rememberingFacts } from "./remembering-facts.testing.ts";

const SLOT = "java-receiver-sites";
const BASE = java("Base", ["package app;", "", "public class Base {", "  public void touch() {}", "}"]);
const STORE = java("Store", ["package app;", "", "public interface Store extends com.lib.Outside<String> {", "  void save(String value);", "}"]);
const DISK = java("Disk", ["package app;", "", "public class Disk extends Base implements Store {", "  public void save(String value) {}", "}"]);
const FIRST = java("First", ["package app;", "", "class First {", "  void run(Store store) { store.save(\"x\"); }", "}"]);
const SECOND = java("Second", ["package app;", "", "class Second {", "  void run(Store store) { store.save(\"y\"); }", "}"]);
const TOOL = java("Tool", ["package app;", "", "public class Tool {", "  public void use() {}", "}"]);
const THIRD = java("Third", ["package app;", "", "class Third {", "  void run(Tool tool) { tool.use(); }", "}"]);
const UNRELATED = java("Unrelated", ["package app;", "", "class Unrelated {", "  int count() { return 1; }", "}"]);
const SOURCES = [BASE, STORE, DISK, FIRST, SECOND, TOOL, THIRD, UNRELATED];
const PLACE = (file: SourceFile, member: string): ReceiverCallSite => {
  const lines = file.content.split("\n");
  const line = lines.findIndex((text) => text.includes(`.${member}(`));
  return { file: file.path, line: line + 1, column: lines[line]!.indexOf(`.${member}(`) - lines[line]!.split(".")[0]!.split(" ").at(-1)!.length + 1, member };
};
const SITES = [PLACE(FIRST, "save"), PLACE(SECOND, "save"), PLACE(THIRD, "use")];
const SITE_FILES = 3;

async function readKept(facts: ReturnType<typeof rememberingFacts>, sources: readonly SourceFile[], sites = SITES, signal?: AbortSignal, around: { paths?: readonly string[]; context?: readonly SourceFile[] } = {}) {
  const holds = createJavaTreeHolds();
  const hold = holds.open();
  try {
    return await createJavaNameBindings(() => createJavaParser(holds), sources, around.paths ?? sources.map(({ path }) => path), facts, hold, around.context).receiverMethods(sites, signal);
  } finally {
    hold.release();
  }
}

const cold = async (sources: readonly SourceFile[], sites = SITES) => createJavaNameBindings(createJavaParser, sources, sources.map(({ path }) => path)).receiverMethods(sites);
const turn = (facts: ReturnType<typeof rememberingFacts>) => facts.readsOf(SLOT);
const without = (...files: SourceFile[]) => SOURCES.filter((file) => !files.includes(file));

test("the receiver methods kept per file of sites answer the bytes of a read without facts, keyed by the sites asked, and an edit of a file no site read derives none", async () => {
  const facts = rememberingFacts();
  const first = await readKept(facts, SOURCES);
  assert.deepEqual(first, await cold(SOURCES));
  assert.deepEqual(first.map(({ kind }) => kind), ["unproven", "unproven", "method"]);
  assert.deepEqual(turn(facts), { hits: 0, misses: SITE_FILES });
  assert.deepEqual([facts.keyedBy.get(SLOT), facts.keyedBy.get("java-receiver-methods")], ["request", "request"]);
  const sources = SOURCES.map((file) => (file === UNRELATED ? edited(UNRELATED, ["return 1;", "return 2;"]) : file));
  assert.deepEqual(await readKept(facts, sources), first);
  assert.deepEqual(turn(facts), { hits: SITE_FILES, misses: SITE_FILES });
});

test("an edit of a file with sites derives that file, and no other", async () => {
  const facts = rememberingFacts();
  await readKept(facts, SOURCES);
  const second = edited(SECOND, ["void run", "void again() {}\n  void run"]);
  const sources = SOURCES.map((file) => (file === SECOND ? second : file));
  const sites = [SITES[0]!, PLACE(second, "save"), SITES[2]!];
  assert.deepEqual(await readKept(facts, sources, sites), await cold(sources, sites));
  assert.deepEqual(turn(facts), { hits: SITE_FILES - 1, misses: SITE_FILES + 1 });
});

test("an edit of a file the receivers' types are read from derives every file whose sites read it, though they share the type, and the files whose sites did not hit", async () => {
  const facts = rememberingFacts();
  await readKept(facts, SOURCES);
  const sources = SOURCES.map((file) => (file === BASE ? edited(BASE, ["public void touch() {}", "public void touch() {}\n  public void save(String value) {}"]) : file));
  assert.deepEqual(await readKept(facts, sources), await cold(sources));
  assert.deepEqual(turn(facts), { hits: 1, misses: SITE_FILES + 2 });
});

test("a type that appears below a receiver's type derives the files whose sites asked for the types below it", async () => {
  const facts = rememberingFacts();
  const before = await readKept(facts, SOURCES);
  const sources = [...SOURCES, java("Late", ["package app;", "", "class Late implements Store {", "  public void save(String value) {}", "}"])];
  const after = await readKept(facts, sources);
  assert.deepEqual(after, await cold(sources));
  assert.notDeepEqual(after, before);
  assert.deepEqual(turn(facts), { hits: 1, misses: SITE_FILES + 2 });
});

test("an anonymous class that appears under the name of a receiver's type derives the files whose sites asked, and the answer is the unplaced one", async () => {
  const facts = rememberingFacts();
  const before = await readKept(facts, SOURCES);
  const sources = [...SOURCES, java("Wiring", ["package app;", "", "class Wiring {", "  Store make() { return new Store() { public void save(String value) {} }; }", "}"])];
  const after = await readKept(facts, sources);
  assert.deepEqual(after, await cold(sources));
  assert.notDeepEqual(after, before);
  assert.deepEqual(turn(facts), { hits: 1, misses: SITE_FILES + 2 });
});

test("a method reference that appears under the method's name derives the files whose sites asked whether one names it", async () => {
  const facts = rememberingFacts();
  const before = await readKept(facts, SOURCES);
  const sources = [...SOURCES, java("Refs", ["package app;", "", "class Refs {", "  java.util.function.Consumer<String> ref(Store store) { return store::save; }", "}"])];
  const after = await readKept(facts, sources);
  assert.deepEqual(after, await cold(sources));
  assert.notDeepEqual(after, before);
  assert.deepEqual(turn(facts), { hits: 1, misses: SITE_FILES + 2 });
});

test("a call-rewriting annotation that appears anywhere derives every file of sites, and a source that does not parse does too", async () => {
  const facts = rememberingFacts();
  await readKept(facts, SOURCES);
  const rewriting = [...SOURCES, java("Delegating", ["package app;", "", "@lombok.experimental.Delegate", "class Delegating {}"])];
  const unproven = await readKept(facts, rewriting);
  assert.deepEqual(unproven, await cold(rewriting));
  assert.ok(unproven.every(({ kind }) => kind === "unproven"));
  assert.deepEqual(turn(facts), { hits: 0, misses: SITE_FILES * 2 });
  const broken = [...SOURCES, java("Broken", ["package app;", "class {"])];
  assert.deepEqual(await readKept(facts, broken), await cold(broken));
  assert.deepEqual(turn(facts), { hits: 0, misses: SITE_FILES * 3 });
});

test("what the build states is part of what keeps a file: a lombok configuration in the listing or a declared source generator derives every file of sites", async () => {
  const facts = rememberingFacts();
  const paths = SOURCES.map(({ path }) => path);
  await readKept(facts, SOURCES);
  const lombok = { paths: [...paths, "lombok.config"] };
  assert.deepEqual(await readKept(facts, SOURCES, SITES, undefined, lombok), await cold(SOURCES));
  assert.deepEqual(turn(facts), { hits: 0, misses: SITE_FILES * 2 });
  const generator = { context: [{ path: "pom.xml", content: "<project><build><plugins><plugin><groupId>org.openapitools</groupId><artifactId>openapi-generator-maven-plugin</artifactId></plugin></plugins></build></project>" }] };
  assert.deepEqual(await readKept(facts, SOURCES, SITES, undefined, generator), await cold(SOURCES));
  assert.deepEqual(turn(facts), { hits: 0, misses: SITE_FILES * 3 });
});

test("a file the index marks as naming a dynamic implementation proves nothing only where the project resolves the name to the JDK's", async () => {
  const facts = rememberingFacts();
  const own = [...SOURCES, java("Proxy", ["package app;", "", "class Proxy {}"]), java("Holder", ["package app;", "", "class Holder {", "  Proxy proxy;", "}"])];
  const jdk = [...SOURCES, java("Dynamic", ["package app;", "", "class Dynamic {", "  Object make() { return java.lang.reflect.Proxy.newProxyInstance(null, null, null); }", "}"])];
  assert.deepEqual((await readKept(facts, own)).map(({ kind }) => kind), ["unproven", "unproven", "method"]);
  assert.deepEqual(await readKept(facts, own), await cold(own));
  const unproven = await readKept(facts, jdk);
  assert.deepEqual(unproven, await cold(jdk));
  assert.deepEqual(unproven.map(({ kind }) => kind), ["unproven", "unproven", "unproven"]);
});

test("a read cut by its deadline keeps nothing", async () => {
  const facts = rememberingFacts();
  await readKept(facts, SOURCES, SITES, AbortSignal.abort());
  const after = await readKept(facts, SOURCES);
  assert.deepEqual(after, await cold(SOURCES));
  assert.deepEqual(turn(facts), { hits: 0, misses: SITE_FILES });
});

test("a read of sites in a file the sources do not hold answers unknown and keeps none", async () => {
  const facts = rememberingFacts();
  const answers = await readKept(facts, without(THIRD, TOOL), [SITES[0]!, SITES[2]!]);
  assert.deepEqual(answers.map(({ kind }) => kind), ["unproven", "unknown"]);
  assert.deepEqual(turn(facts), { hits: 0, misses: 1 });
});
