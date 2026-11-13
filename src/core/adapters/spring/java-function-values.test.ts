import { test } from "node:test";
import assert from "node:assert/strict";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaNameBindings } from "./java-name-bindings.adapter.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { DispatchTargets } from "../../ports/import-origins.port.ts";

function java(path: string, lines: readonly string[]): SourceFile {
  return { path: `src/main/java/app/${path}`, content: `${lines.join("\n")}\n` };
}

/** `q` is declared at line 4: the port has one abstract method, so a function value may implement it. */
const PORT = java("Port.java", ["package app;", "", "public interface Port {", "  String q(String x);", "}"]);
const IMPL = java("Impl.java", ["package app;", "", "public class Impl implements Port {", "  public String q(String x) { return x; }", "}"]);
const HANDLER = java("Handler.java", ["package app;", "", "public interface Handler {", "  void on(String item);", "}"]);
const FACTORY = java("Factory.java", ["package app;", "", "public interface Factory {", "  Port create();", "}"]);
const SUB = java("Sub.java", ["package app;", "", "public interface Sub extends Port {}"]);

const BODIES: DispatchTargets = { kind: "bodies", bodies: [{ file: IMPL.path, start: 4, nameLine: 4 }] };
const VETOED: DispatchTargets = { kind: "unknown", reason: "dispatch not proven" };

/** The answer for `Port.q` when the repository also holds `member` in a class `Use` beside the helper declarations. */
async function answer(member: string, ...more: readonly SourceFile[]): Promise<DispatchTargets> {
  const use = java("Use.java", ["package app;", "import java.util.List;", "import java.util.function.Supplier;", "class Use {", member, "}"]);
  const [targets] = await createJavaNameBindings(createJavaParser, [PORT, IMPL, HANDLER, FACTORY, SUB, use, ...more]).dispatchTargets([{ file: PORT.path, line: 4, name: "q" }]);
  return targets!;
}

test("a function value whose repository context proves a type that is not the port or below it releases the one-implementation veto", async () => {
  const proven: Readonly<Record<string, string>> = {
    "a repository parameter at the call's arity": "void each(Handler h) {} void run() { each(i -> {}); }",
    "a repository parameter through this": "void each(Handler h) {} void run() { this.each(i -> {}); }",
    "a repository parameter of an enclosing type": "void each(Handler h) {} class Inner { void run() { each(i -> {}); } }",
    "a variable-arity repository parameter": "void each(String s, Handler... h) {} void run() { each(\"a\", i -> {}, i -> {}); }",
    "an overload of another arity": "void each(Handler h) {} void each(Port p, int n) {} void run() { each(i -> {}); }",
    "every overload of the arity": "void each(Handler h) {} void each(Runnable r) {} void run() { each(i -> {}); }",
    "a library type written on a declaration": "Runnable r = () -> {};",
    "a library type written on a field of a generic type": "Supplier<String> s = () -> \"a\";",
    "a cast to a library type": "Object o = (Runnable) () -> {};",
    "a return of a library type": "Runnable make() { return () -> {}; }",
    "a conditional with parenthesized arms": "Runnable r = true ? (() -> {}) : () -> {};",
    "a switch expression arm and a yield": "Runnable r = switch (1) { case 1 -> () -> {}; default -> { yield () -> {}; } };",
  };
  for (const [context, member] of Object.entries(proven)) {
    assert.deepEqual(await answer(member), BODIES, context);
  }
});

test("a function value nested in another takes the return type of the outer target's one abstract method", async () => {
  const richer = java("Maker.java", ["package app;", "", "public interface Maker {", "  Runnable create();", "}"]);

  assert.deepEqual(await answer("Maker m = () -> () -> {};", richer), BODIES);
  assert.deepEqual(await answer("Factory f = () -> () -> \"p\";"), VETOED, "the inner value's target is Port");
  assert.deepEqual(await answer("Factory make() { return () -> () -> \"p\"; }"), VETOED, "the inner value of a returned one");
  assert.deepEqual(await answer("Supplier<Runnable> s = () -> () -> {};"), VETOED, "a library outer target has no declaration to read the result from");
});

test("a function value whose target is the port or below it, or that its context leaves unsettled, keeps the veto", async () => {
  const kept: Readonly<Record<string, string>> = {
    "the port written on a declaration": "Port p = x -> null;",
    "an interface below the port": "Sub s = x -> null;",
    "the port in an intersection cast": "Object o = (java.io.Serializable & Port) x -> null;",
    "the port as a method reference": "Port p = String::trim;",
    "the port returned": "Port make() { return x -> null; }",
    "the port in a conditional arm": "Port p = true ? x -> null : x -> x;",
    "the port in a switch arm": "Port p = switch (1) { case 1 -> x -> null; default -> x -> x; };",
    "the port at a repository parameter": "void register(Port p) {} void run() { register(x -> null); }",
    "the port at one overload of the arity": "void each(Handler h) {} void each(Port p) {} void run() { each(x -> null); }",
    "the port at a variable-arity position": "void each(Port... p) {} void run() { each(x -> null); }",
    "a library call argument": "void run(List<String> items) { items.stream().map(i -> i.trim()); }",
    "a library call on a type that extends a library class": "class Slots extends java.util.ArrayList<Port> {} void run(Slots slots) { slots.add(() -> \"lambda\"); }",
    "a library static call with a sibling argument": "Port port; void run() { java.util.Objects.requireNonNullElse(port, x -> null); }",
    "a var declaration": "void run() { var p = x -> null; }",
    "an assignment": "Port p; void set() { p = x -> null; }",
    "a type variable parameter": "<T> T id(T t) { return t; } void run() { Port y = id(x -> null); }",
    "a type variable bounded by the port": "<T extends Port> void use(T t) {} void run() { use(x -> null); }",
    "a call no enclosing type declares": "void run() { elsewhere(x -> null); }",
    "a call on another receiver": "void run(Use other) { other.each(x -> null); } void each(Handler h) {}",
    "a constructor argument": "Use(Handler h) {} void run() { new Use(x -> null); }",
    "a private method of a superclass, which is not inherited": "class Base { private void each(Handler h) {} } class Child extends Base { void run() { each(x -> null); } } void each(Port p) {}",
    "a superclass outside the repository": "class Child extends Thread { void run2() { each(i -> {}); } void each(Handler h) {} }",
    "an anonymous class that inherits a member type of the written name": "class Base { interface Runnable extends Port {} } void run() { new Base() { void m() { Runnable r = x -> null; } }; }",
    "a block body that returns the port's type": "Factory f = () -> { return x -> null; };",
  };
  for (const [context, member] of Object.entries(kept)) assert.deepEqual(await answer(member), VETOED, context);
});

test("one function value left unsettled keeps the veto although another is proven", async () => {
  assert.deepEqual(await answer("Runnable r = () -> {}; Object o = java.util.stream.Stream.of(1).map(x -> x);"), VETOED);
  assert.deepEqual(await answer("Runnable r = () -> {}; Handler h = i -> {};"), BODIES);
});
