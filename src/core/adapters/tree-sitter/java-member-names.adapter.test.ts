import assert from "node:assert/strict";
import test from "node:test";
import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
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

test("a source that does not parse declares none", async () => {
  let created = 0;
  const reader = createJavaMemberNames(async () => (created += 1, createJavaParser()));
  assert.deepEqual(await read(["class {"], "src/A.java", reader), { names: [], functionValueCalls: [], callables: [], receiverBindings: [], functionValues: [] });
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

/** The 1-based place of the `occurrence`-th `needle` in `lines`. */
function placeOf(lines: readonly string[], needle: string, occurrence = 1): { line: number; column: number } {
  let seen = 0;
  for (const [index, text] of lines.entries()) {
    for (let column = text.indexOf(needle); column >= 0; column = text.indexOf(needle, column + 1)) if (++seen === occurrence) return { line: index + 1, column: column + 1 };
  }
  throw new Error(`${needle} is not written`);
}

test("a member call on a parameter, a local, a typed lambda parameter or a private field of the enclosing class is held by the type its one declaration states", async () => {
  const lines = [
    "package app;",
    "import java.util.List;",
    "import java.util.Map;",
    "import org.springframework.web.client.RestTemplate;",
    "class Orders {",
    "  private final RestTemplate rest;",
    "  private Map.Entry<String, String> entry;",
    "  Orders(RestTemplate rest) { this.rest = rest; }",
    "  void run(List<String> items) {",
    "    items.add(\"a\");",
    "    this.rest.getForObject(\"/x\", String.class);",
    "    entry.getKey();",
    "    String label = \"x\";",
    "    label.trim();",
    "    for (String each : items) each.strip();",
    "    items.forEach((String item) -> item.length());",
    "  }",
    "}",
  ];
  const annotated = (call: string, receiver: string, member: string, type: string, declared: string, occurrence = 1) => {
    const at = placeOf(lines, call);
    const head = placeOf(lines, declared, occurrence);
    return { ...at, receiver, member, holds: { kind: "annotated", type, ...head } };
  };
  assert.deepEqual((await read(lines)).receiverBindings, [
    annotated("items.add", "items", "add", "List", "List<String> items"),
    annotated("this.rest.getForObject", "rest", "getForObject", "RestTemplate", "RestTemplate rest;"),
    annotated("entry.getKey", "entry", "getKey", "Map", "Map.Entry"),
    annotated("label.trim", "label", "trim", "String", "String label"),
    annotated("each.strip", "each", "strip", "String", "String each"),
    annotated("items.forEach", "items", "forEach", "List", "List<String> items"),
    annotated("item.length", "item", "length", "String", "String item"),
  ]);
});

test("a call on a var, varargs, untyped lambda, pattern or resource variable, or on a field that is not private, is declared twice, is named through another receiver or reflection, or is shadowed, is held by no annotation", async () => {
  const header = ["package app;", "import java.util.Map;", "import org.springframework.web.client.RestTemplate;"];
  for (const body of [
    ["class A { void run(String... names) { var built = new StringBuilder(); built.append(\"a\"); names.clone(); } }"],
    ["class A { void run() { java.util.List.of(\"a\").forEach(name -> name.trim()); } }"],
    ["class A { RestTemplate shared; void run() { shared.getForObject(\"/y\", String.class); } }"],
    ["class A { private Map<String, String> other; void run() { this.other.get(\"k\"); } static void copy(A from) { from.other.clear(); } }"],
    ["class A { private Map<String, String> patterned; void run(Object value) { if (value instanceof Map patterned) patterned.size(); } }"],
    ["class A { private Map<String, String> held; void run() throws Exception { try (java.io.StringReader held = new java.io.StringReader(\"\")) { held.read(); } } }"],
    ["class A { private Map<String, String> cache; void run() throws Exception { cache.get(\"k\"); getClass().getDeclaredField(\"x\"); } }"],
    ["class A { private Map<String, String> cache, cache; void run() { cache.get(\"k\"); } }"],
    ["class A { int[] counts; private int size; void run() { counts.clone(); } }"],
  ]) assert.deepEqual((await read([...header, ...body])).receiverBindings, [], body[0]);
});

test("a variable of a field's name declared anywhere in the type body but as a field, in another method, a constructor's lambda or an initializer, keeps a bare call from the field; a nested type's field does not", async () => {
  const header = ["package app;", "import java.util.Map;"];
  for (const body of [
    "class A { private Map<String, String> cache; void run() { cache.get(\"k\"); } void other() { String cache = \"\"; } }",
    "class A { private Map<String, String> cache; { Object cache = null; } void run() { cache.get(\"k\"); } }",
    "class A { private Map<String, String> cache; A() { Runnable r = () -> { int cache = 1; }; } void run() { cache.get(\"k\"); } }",
  ]) assert.deepEqual((await read([...header, body])).receiverBindings, [], body);
  const lines = [...header, "class A { private Map<String, String> cache; static class B { private String cache; } void run() { cache.get(\"k\"); } }"];
  assert.deepEqual((await read(lines)).receiverBindings.map(({ receiver, holds }) => [receiver, holds.kind === "annotated" ? holds.type : holds.kind]), [["cache", "Map"]]);
});

test("lambdas, method references and anonymous class bodies are function values, each whole; a named class body and a method are not", async () => {
  const values = (await read([
    "class A {",
    "  void run() { Runnable r = () -> go(); list.forEach(this::send);",
    "    Runnable t = new Runnable() { public void run() { go(); } }; }",
    "}",
  ])).functionValues;
  assert.deepEqual(values.map(({ start, end }) => [start.line, start.column, end.line, end.column]), [[2, 28, 2, 38], [2, 53, 2, 63], [3, 32, 3, 63]]);
});

test("given derived facts, a Java source is parsed once by its content across readers, and answers what it answers without facts", async () => {
  const kept = new Map<string, string>();
  const facts: DerivedFacts = {
    ofFile(slot, file, derive) {
      const key = JSON.stringify([slot, file.path, file.content]);
      if (!kept.has(key)) kept.set(key, JSON.stringify(derive()));
      return JSON.parse(kept.get(key)!);
    },
    ofInputs: (_slot, _inputs, derive) => derive(),
    fingerprint: (inputs) => JSON.stringify(inputs),
    drain: () => ({ hits: 0, misses: 0, admitted: 0, admittedBytes: 0, evicted: 0, skipped: 0, factBytes: 0, retainedBytes: 0 }),
  };
  let parsed = 0;
  const counting = async () => {
    const parser = await createJavaParser();
    return { ...parser, parse: (file: Parameters<typeof parser.parse>[0]) => (parsed += 1, parser.parse(file)) };
  };
  const file = { path: "src/A.java", content: ["class A {", "  void run() { B b = new B(); b.go(); Runnable r = () -> run(); }", "}"].join("\n") };
  const alone = await createJavaMemberNames(createJavaParser).memberNames(file);

  const first = await createJavaMemberNames(counting).memberNames(file, facts);
  const again = await createJavaMemberNames(counting).memberNames({ ...file }, facts);

  assert.ok(alone.receiverBindings.length > 0 && (alone.calls?.length ?? 0) > 0);
  assert.equal(parsed, 1);
  assert.deepEqual(first, alone);
  assert.deepEqual(again, alone);
});
