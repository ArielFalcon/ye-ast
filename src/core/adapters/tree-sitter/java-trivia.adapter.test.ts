import assert from "node:assert/strict";
import test from "node:test";
import { createJavaParser } from "./java-parser.adapter.ts";
import { createJavaTrivia } from "./java-trivia.adapter.ts";

const trivia = async (lines: readonly string[], path = "src/A.java") => [...(await createJavaTrivia(createJavaParser).triviaLines({ path, content: lines.join("\n") }))];

test("blank lines and comments are trivia, and a line that holds code beside a comment is not", async () => {
  assert.deepEqual(await trivia(["", "// note", "/* opens", "   closes */", "class A { // trailing", "  /** doc */ void run() {}", "}"]), [1, 2, 3, 4]);
});

test("a line inside a text block or a string that spells a comment is code", async () => {
  assert.deepEqual(await trivia(["class A {", '  String page = """', "    // not a comment", "    /* nor this", '    """;', '  String url = "http://host";', "}", "// a comment"]), [8]);
});

test("a file that does not parse has no trivia, so every line counts as code", async () => {
  assert.deepEqual(await trivia(["", "class {", ""]), []);
});

test("the parser is created once however many sources are read", async () => {
  let created = 0;
  const reader = createJavaTrivia(async () => (created += 1, createJavaParser()));
  await reader.triviaLines({ path: "src/A.java", content: "class A {}\n" });
  await reader.triviaLines({ path: "src/B.java", content: "class B {}\n" });
  assert.equal(created, 1);
});
