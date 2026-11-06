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
  assert.deepEqual(await read(["const a = { m() {} };"], "src/a.ts", reader), { names: [], functionValueCalls: [], callables: [], receiverBindings: [] });
  assert.equal(created, 0);
  assert.deepEqual(await read(["class {"], "src/A.java", reader), { names: [], functionValueCalls: [], callables: [], receiverBindings: [] });
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

test("a member call is a function-value call when its own file binds the receiver to a lambda or a method reference: this.<field>, a bare field, a local or an assignment", async () => {
  assert.deepEqual((await read([
    "public class A {",
    "  Supplier<Integer> supply = () -> 1;",
    "  Runnable task = this::work;",
    "  Runnable later;",
    "  Runnable throughThis;",
    "  void work() {",
    "    Runnable local = A::helper;",
    "    later = () -> {};",
    "    this.throughThis = this::work;",
    "    this.supply.get();",
    "    task.run();",
    "    local.run();",
    "    later.run();",
    "    throughThis.run();",
    "  }",
    "}",
  ])).functionValueCalls, [
    { line: 10, receiver: "supply", member: "get" },
    { line: 11, receiver: "task", member: "run" },
    { line: 12, receiver: "local", member: "run" },
    { line: 13, receiver: "later", member: "run" },
    { line: 14, receiver: "throughThis", member: "run" },
  ]);
});

test("a value is a function value through parentheses and casts at any depth, and a conditional is one when either branch is", async () => {
  assert.deepEqual((await read([
    "public class W {",
    "  Supplier<Integer> field = ((Supplier<Integer>) (() -> 1));",
    "  Runnable later;",
    "  void go(boolean flag, Runnable other, Runnable plain) {",
    "    Runnable paren = (this::go2);",
    "    Runnable chosen = flag ? other : (flag ? () -> {} : other);",
    "    Runnable neither = flag ? other : plain;",
    "    later = (Runnable) (flag ? this::go2 : other);",
    "    field.get();",
    "    paren.run();",
    "    chosen.run();",
    "    neither.run();",
    "    later.run();",
    "  }",
    "  void go2() {}",
    "}",
  ])).functionValueCalls, [
    { line: 9, receiver: "field", member: "get" },
    { line: 10, receiver: "paren", member: "run" },
    { line: 11, receiver: "chosen", member: "run" },
    { line: 13, receiver: "later", member: "run" },
  ]);
});

test("a receiver bound to a non-function value, or shadowed by a parameter or a local, is no function-value call", async () => {
  assert.deepEqual((await read([
    "public class B {",
    "  Supplier<Integer> supply = () -> 1;",
    "  List<Integer> items = new ArrayList<>();",
    "  void take(Supplier<Integer> supply) { supply.get(); }",
    "  void list() { items.add(1); }",
    "  void shadow() { Supplier<Integer> supply = other(); supply.get(); }",
    "}",
  ])).functionValueCalls, []);
});
