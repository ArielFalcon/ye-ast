import assert from "node:assert/strict";
import test from "node:test";
import { createJavaParser } from "./java-parser.adapter.ts";
import { createJavaTrivia } from "./java-trivia.adapter.ts";

const trivia = async (lines: readonly string[], path = "src/A.java") => [...(await createJavaTrivia(await createJavaParser()).triviaLines({ path, content: lines.join("\n") }))];

test("blank lines and comments are trivia, and a line that holds code beside a comment is not", async () => {
  assert.deepEqual(await trivia(["", "// note", "/* opens", "   closes */", "class A { // trailing", "  /** doc */ void run() {}", "}"]), [1, 2, 3, 4]);
});

test("a line inside a text block or a string that spells a comment is code", async () => {
  assert.deepEqual(await trivia(["class A {", '  String page = """', "    // not a comment", "    /* nor this", '    """;', '  String url = "http://host";', "}", "// a comment"]), [8]);
});

test("a file that does not parse, or of another language, has no trivia, so every line counts as code", async () => {
  assert.deepEqual(await trivia(["", "class {", ""]), []);
  assert.deepEqual(await trivia(["", "// x"], "src/a.ts"), []);
});
