import assert from "node:assert/strict";
import test from "node:test";
import { createJavaParser } from "./java-parser.adapter.ts";
import { createJavaMemberNames } from "./java-member-names.adapter.ts";

const read = (lines: readonly string[], path = "src/A.java", reader = createJavaMemberNames(createJavaParser)) => reader.memberNames({ path, content: lines.join("\n") });

test("methods and fields of classes, interfaces, local and anonymous classes are names", async () => {
  assert.deepEqual((await read([
    "public class A {",
    "  private int count, total;",
    "  void run() {",
    "    class Local { void localOnly() {} }",
    "    Runnable task = new Runnable() { public void anonymousOnly() {} };",
    "  }",
    "  interface Port { int LIMIT = 1; void send(); }",
    "}",
  ])).names, ["LIMIT", "anonymousOnly", "count", "localOnly", "run", "send", "total"]);
});

test("a record's components are its accessor names, beside its own methods", async () => {
  assert.deepEqual((await read(["public record Point(int x, int y) {", "  int sum() { return x + y; }", "}"])).names, ["sum", "x", "y"]);
});

test("enum constants are names", async () => {
  assert.deepEqual((await read(["enum Color { RED, GREEN; void paint() {} }"])).names, ["GREEN", "RED", "paint"]);
});

test("a source of another language or one that does not parse declares none, and the parser is made only for a Java source", async () => {
  let created = 0;
  const reader = createJavaMemberNames(async () => (created += 1, createJavaParser()));
  assert.deepEqual(await read(["const a = { m() {} };"], "src/a.ts", reader), { names: [] });
  assert.equal(created, 0);
  assert.deepEqual(await read(["class {"], "src/A.java", reader), { names: [] });
  assert.equal(created, 1);
});
