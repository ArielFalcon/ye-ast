import assert from "node:assert/strict";
import test from "node:test";
import { importDeclarationMultiset, tokenTexts, tokensOutsideImports } from "../../domain/change/token-lines.ts";
import type { SourceReading, TokenReading } from "../../domain/change/source-tokens.ts";
import { createJavaParser } from "./java-parser.adapter.ts";
import { createJavaTokens } from "./java-tokens.adapter.ts";

const read = (lines: readonly string[]): Promise<SourceReading> => createJavaTokens(createJavaParser).tokensOf({ path: "src/A.java", content: lines.join("\n") });
const reading = async (lines: readonly string[]): Promise<TokenReading> => {
  const held = await read(lines);
  assert.equal(held.status, "read");
  return held as TokenReading;
};
const texts = async (lines: readonly string[]): Promise<readonly string[]> => tokenTexts((await reading(lines)).tokens);
const same = async (base: readonly string[], head: readonly string[]): Promise<void> => assert.deepEqual(await texts(head), await texts(base));
const differs = async (base: readonly string[], head: readonly string[]): Promise<void> => assert.notDeepEqual(await texts(head), await texts(base));

const MEMBERS = ["class A {", "  void one() {}", "  void two() {}", "}"];

test("blank lines and plain comments are trivia, so editing either leaves every token equal", async () => {
  await same(MEMBERS, ["class A {", "", "  void one() {}", "  // between members", "  void two() {}", "}"]);
  await same(["class A {", "  // note", "  void run() {}", "}"], ["class A {", "  // another note", "  void run() {}", "}"]);
  await same(["class A {", "  /* note */", "  void run() {}", "}"], ["class A {", "  /* another */", "  void run() {}", "}"]);
});

test("a re-wrapped call keeps its tokens", async () => {
  await same(["class A {", "  void run() { foo(a, b); }", "}"], ["class A {", "  void run() {", "    foo(a,", "      b);", "  }", "}"]);
});

test("a doc comment, a Markdown doc comment and a comment holding a unicode escape are tokens", async () => {
  await differs(["class A {", "  /** one */", "  void run() {}", "}"], ["class A {", "  /** two */", "  void run() {}", "}"]);
  await differs(["class A {", "  /// one", "  void run() {}", "}"], ["class A {", "  /// two", "  void run() {}", "}"]);
  await differs(["class A {", "  // \\u000a", "  void run() {}", "}"], ["class A {", "  // \\u000b", "  void run() {}", "}"]);
  const held = await reading(["class A {", "  /** doc */", "  void run() {}", "}"]);
  assert.ok(held.tokens.some((token) => token.text === "/** doc */"));
});

test("a real edit, an added import, a reordered enum and a swapped annotation pair all change the tokens", async () => {
  await differs(["class A {", "  int two() { return 2; }", "}"], ["class A {", "  int two() { return 3; }", "}"]);
  await differs(["import a.B;", "class A {}"], ["import a.B;", "import a.C;", "class A {}"]);
  await differs(["enum E { ONE, TWO }"], ["enum E { TWO, ONE }"]);
  await differs(["@One @Two class A {}"], ["@Two @One class A {}"]);
  await differs(["class A { java.util.List<A> all; }"], ["class A { java.util.List<B> all; }"]);
});

test("two swapped imports keep the file's import multiset while their sequence differs", async () => {
  const base = await reading(["import a.B;", "import a.C;", "class A {}"]);
  const head = await reading(["import a.C;", "import a.B;", "class A {}"]);
  assert.notDeepEqual(tokenTexts(head.tokens), tokenTexts(base.tokens));
  assert.deepEqual(importDeclarationMultiset(head), importDeclarationMultiset(base));
  assert.deepEqual(head.imports.map(({ start, end }) => ["import a.C;", "import a.B;", "class A {}"].join("\n").slice(start, end)), ["import a.C;", "import a.B;"]);
});

test("an import declaration's span ends before code that shares its line", async () => {
  const content = "import java.util.List; class C { int x=1; }";
  const held = await reading([content]);
  assert.deepEqual(held.imports.map(({ start, end }) => content.slice(start, end)), ["import java.util.List;"]);
  assert.deepEqual(tokensOutsideImports(held, { start: 1, end: 1 }).map(({ text }) => text), ["class", "C", "{", "int", "x", "=", "1", ";", "}"]);
});

test("a token after an astral character keeps its own spelling", async () => {
  const held = await reading(["class A {", '  String s = "😀";', "  void run() {}", "}"]);
  assert.ok(held.tokens.some((token) => token.text === "run"));
});

test("a source that does not parse is unread", async () => {
  assert.deepEqual(await read(["", "class {", ""]), { status: "unread", reason: "unparsed" });
});

test("the same source read twice gives the same reading", async () => {
  const source = ["class A {}", "// note"];
  assert.deepEqual(await read(source), await read(source));
});
