import assert from "node:assert/strict";
import test from "node:test";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ImplementingSite, ReceiverCallSite } from "../../ports/import-origins.port.ts";
import { createJavaParser, createJavaTreeHolds } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaNameBindings } from "./java-name-bindings.adapter.ts";
import { rememberingFacts } from "./remembering-facts.testing.ts";

const ARGUMENTS = "java-argument-counts";
const ACCEPTED = "java-accepted-counts";
const java = (name: string, lines: readonly string[]): SourceFile => ({ path: `src/main/java/app/${name}.java`, content: `${lines.join("\n")}\n` });

const TOOL = java("Tool", ["package app;", "", "public class Tool {", "  public Tool(int size) {}", "  public void use(String... names) {}", "  public void use(int a, int b) {}", "}"]);
const FIRST = java("First", ["package app;", "", "class First {", "  void run(Tool tool) { tool.use(1, 2); new Tool(3); }", "}"]);
const SECOND = java("Second", ["package app;", "", "class Second {", "  void run(Tool tool) { tool.use(\"a\", \"b\", \"c\"); }", "}"]);
const UNRELATED = java("Unrelated", ["package app;", "", "class Unrelated {", "  int count() { return 1; }", "}"]);
const SOURCES = [TOOL, FIRST, SECOND, UNRELATED];

const call = (file: SourceFile, text: string, member: string): ReceiverCallSite => {
  const lines = file.content.split("\n");
  const line = lines.findIndex((each) => each.includes(text));
  return { file: file.path, line: line + 1, column: lines[line]!.indexOf(text) + 1, member };
};
const declared = (file: SourceFile, text: string, name: string): ImplementingSite => ({ file: file.path, start: file.content.split("\n").findIndex((each) => each.includes(text)) + 1, name });
const CALLS = [call(FIRST, "tool.use(1, 2)", "use"), call(FIRST, "new Tool(3)", "Tool"), call(SECOND, "tool.use(\"a\"", "use")];
const DECLARED = [declared(TOOL, "public Tool(", "Tool"), declared(TOOL, "String... names", "use"), declared(TOOL, "int a, int b", "use"), { file: UNRELATED.path, start: 1, name: "count" }];

type Facts = ReturnType<typeof rememberingFacts>;

async function readKept<A>(facts: Facts, sources: readonly SourceFile[], ask: (reading: ReturnType<typeof createJavaNameBindings>) => Promise<A>, paths = sources.map(({ path }) => path)) {
  const holds = createJavaTreeHolds();
  const hold = holds.open();
  try {
    return await ask(createJavaNameBindings(() => createJavaParser(holds), sources, paths, facts, hold));
  } finally {
    hold.release();
  }
}

const counts = (sites = CALLS) => (reading: ReturnType<typeof createJavaNameBindings>) => reading.argumentCounts!(sites);
const accepted = (sites = DECLARED) => (reading: ReturnType<typeof createJavaNameBindings>) => reading.acceptedCounts!(sites);
const cold = <A>(sources: readonly SourceFile[], ask: (reading: ReturnType<typeof createJavaNameBindings>) => Promise<A>, paths = sources.map(({ path }) => path)) => ask(createJavaNameBindings(createJavaParser, sources, paths));
const edited = (file: SourceFile, replace: [string, string]): SourceFile => ({ ...file, content: file.content.replace(...replace) });
const replacing = (file: SourceFile, next: SourceFile) => SOURCES.map((each) => (each === file ? next : each));

test("the argument counts kept per file answer the bytes of a read without facts, and an edit of a file without sites derives none", async () => {
  const facts = rememberingFacts();
  const first = await readKept(facts, SOURCES, counts());
  assert.deepEqual(first, await cold(SOURCES, counts()));
  assert.deepEqual(first, [{ kind: "count", count: 2 }, { kind: "count", count: 1 }, { kind: "count", count: 3 }]);
  assert.deepEqual(facts.readsOf(ARGUMENTS), { hits: 0, misses: 2 });
  const sources = replacing(UNRELATED, edited(UNRELATED, ["return 1;", "return 2;"]));
  assert.deepEqual(await readKept(facts, sources, counts()), first);
  assert.deepEqual(facts.readsOf(ARGUMENTS), { hits: 2, misses: 2 });
});

test("an edit of a file with sites derives that file, and no other", async () => {
  const facts = rememberingFacts();
  await readKept(facts, SOURCES, counts());
  const second = edited(SECOND, ["\"a\", \"b\", \"c\"", "\"a\", \"b\""]);
  const sources = replacing(SECOND, second);
  assert.deepEqual(await readKept(facts, sources, counts()), await cold(sources, counts()));
  assert.deepEqual(facts.readsOf(ARGUMENTS), { hits: 1, misses: 3 });
});

test("a call-rewriting annotation anywhere leaves every count unknown and derives every file, as a JVM source no extractor reads does", async () => {
  const facts = rememberingFacts();
  await readKept(facts, SOURCES, counts());
  const rewriting = [...SOURCES, java("Delegating", ["package app;", "", "@lombok.experimental.Delegate", "class Delegating {}"])];
  const unknown = await readKept(facts, rewriting, counts());
  assert.deepEqual(unknown, await cold(rewriting, counts()));
  assert.deepEqual(unknown, CALLS.map(() => ({ kind: "unknown" })));
  assert.deepEqual(facts.readsOf(ARGUMENTS), { hits: 0, misses: 4 });
  const paths = [...SOURCES.map(({ path }) => path), "src/main/kotlin/Twin.kt"];
  assert.deepEqual(await readKept(facts, SOURCES, counts(), paths), await cold(SOURCES, counts(), paths));
});

test("a place several calls of the member start at counts nothing", async () => {
  const facts = rememberingFacts();
  const twice = java("Twice", ["package app;", "", "class Twice {", "  Object run(Tool tool) { return tool.use(1, 2).use(1, 2); }", "}"]);
  const sources = [...SOURCES, twice];
  const sites = [call(twice, "tool.use(1, 2).use", "use")];
  const answers = await readKept(facts, sources, counts(sites));
  assert.deepEqual(answers, await cold(sources, counts(sites)));
  assert.deepEqual(answers, [{ kind: "unknown" }]);
});

test("the accepted counts kept per file answer the bytes of a read without facts: a constructor, a variable-arity method, a fixed one, and a place no method names", async () => {
  const facts = rememberingFacts();
  const first = await readKept(facts, SOURCES, accepted());
  assert.deepEqual(first, await cold(SOURCES, accepted()));
  assert.deepEqual(first, [{ kind: "counts", count: 1 }, { kind: "counts", count: 0, upward: true }, { kind: "counts", count: 2 }, { kind: "unknown" }]);
  assert.deepEqual(facts.readsOf(ACCEPTED), { hits: 0, misses: 2 });
  const sources = replacing(SECOND, edited(SECOND, ["\"c\"", "\"d\""]));
  assert.deepEqual(await readKept(facts, sources, accepted()), first);
  assert.deepEqual(facts.readsOf(ACCEPTED), { hits: 2, misses: 2 });
});

test("an edit of the file that declares a method derives its accepted counts, and a call-rewriting annotation anywhere leaves every one unknown", async () => {
  const facts = rememberingFacts();
  await readKept(facts, SOURCES, accepted());
  const tool = edited(TOOL, ["int a, int b", "int a, int b, int c"]);
  const sources = replacing(TOOL, tool);
  assert.deepEqual(await readKept(facts, sources, accepted()), await cold(sources, accepted()));
  assert.deepEqual(facts.readsOf(ACCEPTED), { hits: 1, misses: 3 });
  const rewriting = [...SOURCES, java("Delegating", ["package app;", "", "@lombok.experimental.Delegate", "class Delegating {}"])];
  const unknown = await readKept(facts, rewriting, accepted());
  assert.deepEqual(unknown, await cold(rewriting, accepted()));
  assert.deepEqual(unknown, DECLARED.map(() => ({ kind: "unknown" })));
});
