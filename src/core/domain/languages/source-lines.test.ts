import assert from "node:assert/strict";
import test from "node:test";
import { linesWithoutCode } from "./source-lines.ts";

test("a line inside a template literal or a text block is code, however it reads", () => {
  assert.deepEqual([...linesWithoutCode("src/a.ts", ["const page = `", "// not a comment", "`;", "// a comment"].join("\n"))], [4]);
  assert.deepEqual([...linesWithoutCode("src/A.java", ['String page = """', "  // not a comment", '  """;', "// a comment"].join("\n"))], [4]);
});

test("a block comment that code follows on its closing line leaves that line code", () => {
  assert.deepEqual([...linesWithoutCode("src/a.ts", ["/* opens", "closes */ register();", "/* whole */", "/* one */ run();"].join("\n"))], [1, 3]);
});
