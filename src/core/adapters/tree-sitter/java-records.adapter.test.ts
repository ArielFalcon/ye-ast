import { test } from "node:test";
import assert from "node:assert/strict";
import { createJavaParser } from "./java-parser.adapter.ts";
import { createJavaRecordsReader } from "./java-records.adapter.ts";

const TOP_LEVEL = "package a;\n\npublic record Point(int x, int y) {\n  public boolean origin() { return x == 0 && y == 0; }\n}\n";
const NESTED = "package a;\n\npublic class Shape {\n  public record Size(int width, int height) {}\n}\n";
const CLASS_ONLY = "package a;\n\n// a record of the visits\npublic class Record {\n  private final int record = 1;\n}\n";

test("a record declared at the top level or nested in a class marks its file, in path order", async () => {
  const reader = createJavaRecordsReader(await createJavaParser());

  const files = await reader.extract([
    { path: "src/b/Shape.java", content: NESTED },
    { path: "src/a/Point.java", content: TOP_LEVEL },
  ]);

  assert.deepEqual(files, ["src/a/Point.java", "src/b/Shape.java"]);
});

test("a class named or commented record and a non-Java source declaring one mark no file", async () => {
  const reader = createJavaRecordsReader(await createJavaParser());

  const files = await reader.extract([
    { path: "src/a/Record.java", content: CLASS_ONLY },
    { path: "src/a/Point.kt", content: TOP_LEVEL },
  ]);

  assert.deepEqual(files, []);
});
