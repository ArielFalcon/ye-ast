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
  assert.deepEqual(await read(["const a = { m() {} };"], "src/a.ts", reader), { names: [], functionValues: [], callables: [] });
  assert.equal(created, 0);
  assert.deepEqual(await read(["class {"], "src/A.java", reader), { names: [], functionValues: [], callables: [] });
  assert.equal(created, 1);
});

test("every method is a callable: overridable unless static, private or final, with a body only when written", async () => {
  assert.deepEqual((await read([
    "public interface Port {",
    "  void send();",
    "  default void run() {}",
    "  static void helper() {}",
    "  private void inner() {}",
    "}",
    "abstract class Base {",
    "  @Deprecated",
    "  abstract void area();",
    "  final void fixed() {}",
    "}",
  ])).callables, [
    { name: "send", start: 2, nameLine: 2, body: false, overridable: true },
    { name: "run", start: 3, nameLine: 3, body: true, overridable: true },
    { name: "helper", start: 4, nameLine: 4, body: true, overridable: false },
    { name: "inner", start: 5, nameLine: 5, body: true, overridable: false },
    { name: "area", start: 8, nameLine: 9, body: false, overridable: true },
    { name: "fixed", start: 10, nameLine: 10, body: true, overridable: false },
  ]);
});

test("a field, local or assigned name that takes a lambda or a method reference holds a function value; any other value is none", async () => {
  assert.deepEqual((await read([
    "public class A {",
    "  Supplier<Integer> supply = () -> 1;",
    "  Runnable task = this::work;",
    "  int count = 1;",
    "  Runnable later;",
    "  Runnable throughThis;",
    "  void work() {",
    "    Runnable local = A::helper;",
    "    later = () -> {};",
    "    this.throughThis = this::work;",
    "  }",
    "}",
  ])).functionValues, ["later", "local", "supply", "task", "throughThis"]);
});
