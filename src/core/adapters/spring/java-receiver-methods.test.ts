import { test } from "node:test";
import assert from "node:assert/strict";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaNameBindings } from "./java-name-bindings.adapter.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ReceiverMethod } from "../../ports/import-origins.port.ts";

function java(path: string, lines: readonly string[]): SourceFile {
  return { path: `src/main/java/app/${path}`, content: `${lines.join("\n")}\n` };
}

const STORE = java("Store.java", ["package app;", "", "public interface Store {", "  void save(String value);", "  Store find();", "}"]);
const JDBC = java("Jdbc.java", ["package app;", "", "public class Jdbc implements Store {", "  public void save(String value) {}", "  public Store find() { return this; }", "}"]);

/** A `Use` class whose `run` body holds `call` on line 4, which starts at its first non-blank column. */
function use(call: string, members: readonly string[] = [], parameters = "Store store"): SourceFile {
  return java("Use.java", ["package app;", "", "class Use {", `  void run(${parameters}) { ${call}; }`, ...members, "}"]);
}

/** The method the call `Use.java` writes on line 4 names: the first call of the body, or the one that starts at `start`. */
async function methodAt(sources: readonly SourceFile[], member = "save", paths?: readonly string[], start = ""): Promise<ReceiverMethod> {
  const user = sources.find(({ path }) => path.endsWith("/Use.java"))!;
  const line = user.content.split("\n")[3]!;
  const column = start === "" ? line.indexOf("{ ") + 3 : line.indexOf(start) + 1;
  const [method] = await createJavaNameBindings(createJavaParser, sources, paths).receiverMethods([{ file: user.path, line: 4, column, member }]);
  return method!;
}

const method = (source: SourceFile, line: number): ReceiverMethod => ({ kind: "method", file: source.path, start: line, nameLine: line });

const KOTLIN = (sources: readonly SourceFile[]) => [...sources.map(({ path }) => path), "src/main/kotlin/Twin.kt"];

test("a call on a parameter, a stated local or a private field names the method its declared repository type offers: the type's own, else the nearest up its class chain", async () => {
  const base = java("Base.java", ["package app;", "", "class Base {", "  void save(String value) {}", "}"]);
  const child = java("Child.java", ["package app;", "", "class Child extends Base {}"]);
  const own = java("Child.java", ["package app;", "", "class Child extends Base {", "  void save(String value) {}", "}"]);

  assert.deepEqual(await methodAt([STORE, JDBC, use("store.save(\"x\")")]), method(STORE, 4));
  assert.deepEqual(await methodAt([STORE, JDBC, use("store.save(/* one */ \"x\")")]), method(STORE, 4));
  assert.deepEqual(await methodAt([STORE, JDBC, use("this.kept.save(\"x\")", ["  private Store kept;"], "")]), method(STORE, 4));
  assert.deepEqual(await methodAt([STORE, JDBC, use("Store local = store; local.save(\"x\")")], "save", undefined, "local.save"), method(STORE, 4));
  assert.deepEqual(await methodAt([STORE, JDBC, use("var local = store; local.save(\"x\")")], "save", undefined, "local.save"), { kind: "unknown" });
  assert.deepEqual(await methodAt([base, child, use("child.save(\"x\")", [], "Child child")]), method(base, 4));
  assert.deepEqual(await methodAt([base, own, use("child.save(\"x\")", [], "Child child")]), method(own, 4));
});

test("a call on what a repository method declares it returns names the returned type's method; a bare or this call names the enclosing class's", async () => {
  const members = ["  Store local() { return null; }", "  <T extends Store> T generic() { return null; }"];

  assert.deepEqual(await methodAt([STORE, JDBC, use("store.find().save(\"x\")")]), method(STORE, 4));
  assert.deepEqual(await methodAt([STORE, JDBC, use("local().save(\"x\")", members)]), method(STORE, 4));
  assert.deepEqual(await methodAt([STORE, JDBC, use("this.local().save(\"x\")", members)]), method(STORE, 4));
  assert.deepEqual(await methodAt([STORE, JDBC, use("generic().save(\"x\")", members)]), { kind: "unknown" });
});

test("a link of a chain whose receiver type has a supertype outside the repository, or a place two calls of the name start at, names no method", async () => {
  const listed = java("Listed.java", ["package app;", "", "class Listed extends java.util.ArrayList<String> {", "  app.Store find() { return null; }", "}"]);
  const plain = java("Plain.java", ["package app;", "", "class Plain {", "  Store find() { return null; }", "}"]);

  assert.deepEqual(await methodAt([STORE, JDBC, listed, use("listed.find().save(\"x\")", [], "Listed listed")]), { kind: "unknown" });
  assert.deepEqual(await methodAt([STORE, JDBC, plain, use("plain.find().find()", [], "Plain plain")], "find"), { kind: "unknown" });
});

test("members of the name that are not one signature of the call's arity, a varargs, a private one or an Object method name no method", async () => {
  const overloaded = java("Store.java", ["package app;", "", "public interface Store {", "  void save(String value);", "  void save(Integer value);", "  Store find();", "}"]);
  const varargs = java("Store.java", ["package app;", "", "public interface Store {", "  void save(String... value);", "  Store find();", "}"]);
  const hidden = java("Plain.java", ["package app;", "", "class Plain {", "  private void save(String value) {}", "}"]);
  const named = java("Plain.java", ["package app;", "", "class Plain {", "  public String toString() { return \"\"; }", "}"]);

  assert.deepEqual(await methodAt([overloaded, use("store.save(\"x\")")]), { kind: "unknown" });
  assert.deepEqual(await methodAt([STORE, JDBC, use("store.save(\"x\", \"y\")")]), { kind: "unknown" });
  assert.deepEqual(await methodAt([varargs, use("store.save(\"x\")")]), { kind: "unknown" });
  assert.deepEqual(await methodAt([hidden, use("plain.save(\"x\")", [], "Plain plain")]), { kind: "unknown" });
  assert.deepEqual(await methodAt([named, use("plain.toString()", [], "Plain plain")], "toString"), { kind: "unknown" });
});

test("an enum names no method, since a constant may declare its own body", async () => {
  const kinds = java("Kinds.java", ["package app;", "", "enum Kinds {", "  ONE;", "  void save(String value) {}", "}"]);

  assert.deepEqual(await methodAt([kinds, use("kinds.save(\"x\")", [], "Kinds kinds")]), { kind: "unknown" });
});

test("a supertype outside the repository, an anonymous class, a lambda or an aspect withholds the proof only inside the declared type's hierarchy", async () => {
  const plain = java("Plain.java", ["package app;", "", "class Plain {", "  void save(String value) {}", "}"]);
  const framework = java("Plain.java", ["package app;", "", "class Plain extends java.util.ArrayList<String> {", "  void save(String value) {}", "}"]);
  const anonymous = java("Wiring.java", ["package app;", "", "class Wiring {", "  Plain make() { return new Plain() { void save(String value) {} }; }", "}"]);
  const elsewhere = java("Elsewhere.java", ["package app;", "", "class Elsewhere extends java.util.ArrayList<String> {", "  Runnable task = () -> {};", "  Object other = new Object() {};", "}"]);
  const aspect = java("Logging.java", ["package app;", "", "@org.aspectj.lang.annotation.Aspect", "class Logging {}"]);
  const call = use("plain.save(\"x\")", [], "Plain plain");

  assert.deepEqual(await methodAt([plain, elsewhere, call]), method(plain, 4));
  assert.deepEqual(await methodAt([framework, call]), { kind: "unknown" });
  assert.deepEqual(await methodAt([plain, anonymous, call]), { kind: "unknown" });
  assert.deepEqual(await methodAt([plain, aspect, call]), { kind: "unknown" });
});

test("an annotation by which a processor adds overloads or rewrites calls proves no method; a source that does not parse, a JVM source no extractor reads or a dynamic proxy leaves the call unproven", async () => {
  const delegating = java("Holder.java", ["package app;", "", "class Holder {", "  @lombok.experimental.Delegate private java.util.List<String> items;", "}"]);
  const broken = java("Broken.java", ["package app;", "", "class Broken {"]);
  const proxy = java("Proxies.java", ["package app;", "", "import java.lang.reflect.Proxy;", "", "class Proxies {", "  Object make() { return Proxy.newProxyInstance(null, null, null); }", "}"]);
  const sources = [STORE, JDBC, use("store.save(\"x\")")];

  assert.deepEqual(await methodAt([...sources, delegating]), { kind: "unknown" });
  assert.deepEqual(await methodAt([...sources, broken]), { kind: "unproven" });
  assert.deepEqual(await methodAt(sources, "save", KOTLIN(sources)), { kind: "unproven" });
  assert.deepEqual(await methodAt([...sources, proxy]), { kind: "unproven" });
});

test("an unproven call is one on a value it reads; a bare call, a call on this or super, or on a type name is unknown", async () => {
  const statics = java("Util.java", ["package app;", "", "class Util {", "  static void save(String value) {}", "}"]);
  const plain = java("Plain.java", ["package app;", "", "class Plain {", "  Store store;", "  void save(String value) {}", "}"]);
  const at = async (sources: readonly SourceFile[], start = "") => methodAt(sources, "save", KOTLIN(sources), start);

  assert.deepEqual(await at([STORE, use("var local = store; local.save(\"x\")")], "local.save"), { kind: "unproven" });
  assert.deepEqual(await at([STORE, plain, use("plain.store.save(\"x\")", [], "Plain plain")]), { kind: "unproven" });
  assert.deepEqual(await at([STORE, use("java.util.List.of(store).get(0).save(\"x\")")]), { kind: "unproven" });
  assert.deepEqual(await at([STORE, use("missing.save(\"x\")")]), { kind: "unproven" });
  assert.deepEqual(await at([STORE, statics, use("Util.save(\"x\")")]), { kind: "unknown" });
  assert.deepEqual(await at([STORE, statics, use("Util.save(\"x\")", ["  Store Util;"])]), { kind: "unproven" });
  assert.deepEqual(await at([STORE, statics, use("Store Util = store; Util.save(\"x\")")], "Util.save"), { kind: "unproven" });
  assert.deepEqual(await at([plain, use("save(\"x\")", ["  void save(String value) {}"])]), { kind: "unknown" });
  assert.deepEqual(await at([plain, use("this.save(\"x\")", ["  void save(String value) {}"])]), { kind: "unknown" });
  assert.deepEqual(await at([plain, use("super.save(\"x\")")]), { kind: "unknown" });
});
