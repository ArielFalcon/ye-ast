import { test } from "node:test";
import assert from "node:assert/strict";
import { createJavaParser } from "./java-parser.adapter.ts";

test("a source with a syntax error is a fault at its line, never a throw", async () => {
  const parser = await createJavaParser();

  const result = parser.parse({ path: "src/a/A.java", content: "package a;\n\nclass A {\n  void run( {\n}\n" });

  assert.deepEqual(result, { ok: false, fault: { kind: "syntax-error", line: 4 } });
});
