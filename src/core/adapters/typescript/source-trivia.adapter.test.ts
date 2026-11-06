import assert from "node:assert/strict";
import test from "node:test";
import { createTypeScriptTrivia } from "./source-trivia.adapter.ts";

const trivia = async (lines: readonly string[]) => [...(await createTypeScriptTrivia().triviaLines({ path: "src/a.ts", content: lines.join("\n") }))];

test("blank lines, line comments and whole block comments are trivia, and a line that holds code beside a comment is not", async () => {
  assert.deepEqual(await trivia(["", "// note", "/* opens", "   closes */", "run(); // trailing", "/* a */ run();"]), [1, 2, 3, 4]);
});

test("a line inside a template literal is code, however it reads, also after a substitution", async () => {
  assert.deepEqual(await trivia(['const marker = "`";', "const page = `", "/*", "`;", "const tail = `${marker}", "// not a comment", "`;", "// a comment"]), [8]);
});

test("a string or a regular expression that spells a comment opener keeps its line code and opens no comment", async () => {
  assert.deepEqual(await trivia(['const url = "http://host";', "const re = /\\/*/;", "register();", "// a comment"]), [4]);
});

test("a file that does not parse, or of another language, has no trivia, so every line counts as code", async () => {
  assert.deepEqual(await trivia(["", "function (", ""]), []);
  assert.deepEqual([...(await createTypeScriptTrivia().triviaLines({ path: "src/A.java", content: "\n// x\n" }))], []);
});
