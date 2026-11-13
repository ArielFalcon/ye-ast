import { test } from "node:test";
import assert from "node:assert/strict";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaNameBindings } from "./java-name-bindings.adapter.ts";
import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ReceiverMethod } from "../../ports/import-origins.port.ts";

function javaIn(directory: string, path: string, lines: readonly string[]): SourceFile {
  return { path: `src/main/java/${directory}/${path}`, content: `${lines.join("\n")}\n` };
}

function java(path: string, lines: readonly string[]): SourceFile {
  return javaIn("app", path, lines);
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

const method = (source: SourceFile, line: number): ReceiverMethod => ({ kind: "method", ...place(source, line) });

/** A declaration of `source` starting and naming itself on `line`. */
const place = (source: SourceFile, line: number) => ({ file: source.path, start: line, nameLine: line });

const KOTLIN = (sources: readonly SourceFile[]) => [...sources.map(({ path }) => path), "src/main/kotlin/Twin.kt"];

test("a call on a parameter, a stated local or a private field names the method its declared repository type offers: the type's own, else the nearest up its class chain", async () => {
  const base = java("Base.java", ["package app;", "", "class Base {", "  void save(String value) {}", "}"]);
  const child = java("Child.java", ["package app;", "", "class Child extends Base {}"]);
  const own = java("Child.java", ["package app;", "", "class Child extends Base {", "  void save(String value) {}", "}"]);

  assert.deepEqual(await methodAt([STORE, JDBC, use("store.save(\"x\")")]), method(STORE, 4));
  assert.deepEqual(await methodAt([STORE, JDBC, use("store.save(/* one */ \"x\")")]), method(STORE, 4));
  assert.deepEqual(await methodAt([STORE, JDBC, use("this.kept.save(\"x\")", ["  private Store kept;"], "")]), method(STORE, 4));
  assert.deepEqual(await methodAt([STORE, JDBC, use("Store local = store; local.save(\"x\")")], "save", undefined, "local.save"), method(STORE, 4));
  assert.deepEqual(await methodAt([STORE, JDBC, use("var local = store; local.save(\"x\")")], "save", undefined, "local.save"), { kind: "unproven" });
  assert.deepEqual(await methodAt([base, child, use("child.save(\"x\")", [], "Child child")]), method(base, 4));
  assert.deepEqual(await methodAt([base, own, use("child.save(\"x\")", [], "Child child")]), method(own, 4));
});

test("a call on what a repository method declares it returns names the returned type's method; a bare or this call names the enclosing class's", async () => {
  const members = ["  private Store local() { return null; }", "  <T extends Store> T generic() { return null; }"];

  assert.deepEqual(await methodAt([STORE, JDBC, use("store.find().save(\"x\")")]), method(STORE, 4));
  assert.deepEqual(await methodAt([STORE, JDBC, use("local().save(\"x\")", members)]), method(STORE, 4));
  assert.deepEqual(await methodAt([STORE, JDBC, use("this.local().save(\"x\")", members)]), method(STORE, 4));
  assert.deepEqual(await methodAt([STORE, JDBC, use("generic().save(\"x\")", members)]), { kind: "unproven" });
});

test("a link of a chain whose receiver type has a supertype outside the repository, or a place two calls of the name start at, names no method", async () => {
  const listed = java("Listed.java", ["package app;", "", "class Listed extends java.util.ArrayList<String> {", "  app.Store find() { return null; }", "}"]);
  const plain = java("Plain.java", ["package app;", "", "class Plain {", "  Store find() { return null; }", "}"]);

  assert.deepEqual(await methodAt([STORE, JDBC, listed, use("listed.find().save(\"x\")", [], "Listed listed")]), { kind: "unproven" });
  assert.deepEqual(await methodAt([STORE, JDBC, plain, use("plain.find().find()", [], "Plain plain")], "find"), { kind: "unknown" });
});

test("a platform interface that declares no members leaves the receiver's method selectable, while a supertype with members or a homonym from another package still withholds it", async () => {
  const entity = (header: string, imports: readonly string[] = []) => java("Entity.java", ["package app;", ...imports, `class Entity ${header} {`, "  void save(String value) {}", "}"]);
  const select = (source: SourceFile) => methodAt([source, use("entity.save(\"x\")", [], "Entity entity")]);
  const imported = entity("implements Serializable", ["import java.io.Serializable;"]);

  assert.deepEqual(await select(imported), method(imported, 4));
  assert.deepEqual(await select(entity("implements Cloneable")), method(imported, 3));
  assert.deepEqual(await select(entity("implements Comparable<Entity>")), { kind: "unproven" });
  assert.deepEqual(await select(entity("implements Serializable", ["import com.vendor.Serializable;"])), { kind: "unproven" });
});

test("an interface a declared generator emits and the sources do not hold leaves the implementing class's own, private and typed receivers selectable, and nothing it could declare", async () => {
  const GENERATOR: SourceFile = { path: "pom.xml", content: "<project><build><plugins><plugin><groupId>org.openapitools</groupId><artifactId>openapi-generator-maven-plugin</artifactId></plugin></plugins></build></project>" };
  const implementing = (call: string, heritage = "implements Api", members: readonly string[] = []) => java("Use.java", ["package app; import app.api.Api;", "", `class Use ${heritage} {`, `  void run(Store store) { ${call}; }`, ...members, "}"]);
  const select = (use: SourceFile, member: string, generated = true) => {
    const line = use.content.split("\n")[3]!;
    return createJavaNameBindings(createJavaParser, [STORE, JDBC, use], undefined, undefined, undefined, generated ? [GENERATOR] : []).receiverMethods([{ file: use.path, line: 4, column: line.indexOf("{ ") + 3, member }]).then(([found]) => found!);
  };
  const helped = implementing("helper()", "implements Api", ["  private void helper() {}"]);
  const typed = implementing("store.save(\"x\")");

  assert.deepEqual(await select(typed, "save"), method(STORE, 4));
  assert.deepEqual(await select(helped, "helper"), method(helped, 5));
  assert.deepEqual(await select(typed, "save", false), { kind: "unproven" });
  assert.deepEqual(await select(helped, "helper", false), { kind: "unproven" });
  assert.notEqual((await select(implementing("getRequest()"), "getRequest")).kind, "method");
  const alsoStore = implementing("save(\"x\")", "implements Api, Store", ["  public void save(String value) {}"]);
  assert.deepEqual(await select(alsoStore, "save"), { kind: "unproven" });
  assert.deepEqual(await select({ ...typed, content: typed.content.replace("implements Api", "extends Api") }, "save"), { kind: "unproven" });
  assert.deepEqual(await select({ ...helped, content: helped.content.replace("implements Api", "extends Api") }, "helper"), { kind: "unproven" });
  assert.deepEqual(await select({ ...typed, content: typed.content.replace("implements Api", "implements org.springframework.context.ApplicationListener<Object>") }, "save"), { kind: "unproven" });
});

test("a call at an arity no member takes, varargs, inaccessible private members and Object methods retain an unproven call", async () => {
  const varargs = java("Store.java", ["package app;", "", "public interface Store {", "  void save(String... value);", "  Store find();", "}"]);
  const hidden = java("Plain.java", ["package app;", "", "class Plain {", "  private void save(String value) {}", "}"]);
  const named = java("Plain.java", ["package app;", "", "class Plain {", "  public String toString() { return \"\"; }", "}"]);

  assert.deepEqual(await methodAt([STORE, JDBC, use("store.save(\"x\", \"y\")")]), { kind: "unproven" });
  assert.deepEqual(await methodAt([varargs, use("store.save(\"x\")")]), { kind: "unproven" });
  assert.deepEqual(await methodAt([hidden, use("plain.save(\"x\")", [], "Plain plain")]), { kind: "unproven" });
  assert.deepEqual(await methodAt([named, use("plain.toString()", [], "Plain plain")], "toString"), { kind: "unproven" });
});

test("members whose parameter types settle to different types are distinct overloads, and the same type however spelled is one signature", async () => {
  const value = java("Value.java", ["package app;", "", "public class Value {}"]);
  const homonym = java("other/Value.java", ["package app.other;", "", "public class Value {}"]);
  const base = java("Base.java", ["package app;", "", "public class Base {", "  public void save(Value value) {}", "}"]);
  const overload = java("other/Sub.java", ["package app.other;", "", "public class Sub extends app.Base {", "  public void save(Value value) {}", "}"]);
  const override = java("other/Sub.java", ["package app.other;", "", "import app.Value;", "", "public class Sub extends app.Base {", "  public void save(Value value) {}", "}"]);
  const call = java("Use.java", ["package app;", "", "class Use {", "  void run(app.other.Sub sub, Value value) { sub.save(value); }", "}"]);

  assert.deepEqual(await methodAt([value, homonym, base, overload, call]), method(base, 4));
  assert.deepEqual(await methodAt([value, homonym, base, override, call]), method(override, 6));
});

test("a call on a receiver a type variable types names, as a dependence only, the method of the variable's one bound the repository declares; no bound, an intersection or a bound outside the repository names none", async () => {
  const named = java("Named.java", ["package app;", "", "public interface Named {", "  String name();", "}"]);
  const typed = (parameters: string, call = "item.save(\"x\")") => java("Use.java", ["package app;", "", `class Use${parameters} {`, `  void run(T item) { ${call}; }`, "}"]);
  const generic = java("Use.java", ["package app;", "", "class Use {", "  <T extends Store> void run(T item) { item.save(\"x\"); }", "}"]);

  assert.deepEqual(await methodAt([STORE, JDBC, typed("<T extends Store>")]), { ...method(STORE, 4), bound: true });
  assert.deepEqual(await methodAt([STORE, JDBC, generic]), { ...method(STORE, 4), bound: true });
  assert.deepEqual(await methodAt([STORE, JDBC, named, typed("<T extends Store & Named>")]), { kind: "unproven" });
  assert.deepEqual(await methodAt([STORE, JDBC, typed("<T>")]), { kind: "unproven" });
  assert.deepEqual(await methodAt([STORE, JDBC, typed("<T extends Runnable>", "item.run()")], "run"), { kind: "unproven" });
});

test("an enum names no method, since a constant may declare its own body", async () => {
  const kinds = java("Kinds.java", ["package app;", "", "enum Kinds {", "  ONE;", "  void save(String value) {}", "}"]);

  assert.deepEqual(await methodAt([kinds, use("kinds.save(\"x\")", [], "Kinds kinds")]), { kind: "unproven" });
});

test("an unread supertype withholds declaration selection; runtime replacements and aspects are dispatch obligations", async () => {
  const plain = java("Plain.java", ["package app;", "", "class Plain {", "  void save(String value) {}", "}"]);
  const framework = java("Plain.java", ["package app;", "", "class Plain extends java.util.ArrayList<String> {", "  void save(String value) {}", "}"]);
  const anonymous = java("Wiring.java", ["package app;", "", "class Wiring {", "  Plain make() { return new Plain() { void save(String value) {} }; }", "}"]);
  const elsewhere = java("Elsewhere.java", ["package app;", "", "class Elsewhere extends java.util.ArrayList<String> {", "  Runnable task = () -> {};", "  Object other = new Object() {};", "}"]);
  const aspect = java("Logging.java", ["package app;", "", "@org.aspectj.lang.annotation.Aspect", "class Logging {}"]);
  const call = use("plain.save(\"x\")", [], "Plain plain");

  assert.deepEqual(await methodAt([plain, elsewhere, call]), method(plain, 4));
  assert.deepEqual(await methodAt([framework, call]), { kind: "unproven" });
  assert.deepEqual(await methodAt([plain, anonymous, call]), method(plain, 4));
  assert.deepEqual(await methodAt([plain, aspect, call]), method(plain, 4));
});

test("an annotation by which a processor adds overloads or rewrites calls proves no method; a source that does not parse, a JVM source no extractor reads or a dynamic proxy leaves the call unproven", async () => {
  const delegating = java("Holder.java", ["package app;", "", "class Holder {", "  @lombok.experimental.Delegate private java.util.List<String> items;", "}"]);
  const broken = java("Broken.java", ["package app;", "", "class Broken {"]);
  const proxy = java("Proxies.java", ["package app;", "", "import java.lang.reflect.Proxy;", "", "class Proxies {", "  Object make() { return Proxy.newProxyInstance(null, null, null); }", "}"]);
  const sources = [STORE, JDBC, use("store.save(\"x\")")];

  assert.deepEqual(await methodAt([...sources, delegating]), { kind: "unproven" });
  assert.deepEqual(await methodAt([...sources, broken]), { kind: "unproven" });
  assert.deepEqual(await methodAt(sources, "save", KOTLIN(sources)), { kind: "unproven" });
  assert.deepEqual(await methodAt([...sources, proxy]), { kind: "unproven" });
});

test("unread sources withhold declared receiver proof, while a bare call or super without a declared type is unknown", async () => {
  const statics = java("Util.java", ["package app;", "", "class Util {", "  static void save(String value) {}", "}"]);
  const plain = java("Plain.java", ["package app;", "", "class Plain {", "  Store store;", "  void save(String value) {}", "}"]);
  const at = async (sources: readonly SourceFile[], start = "") => methodAt(sources, "save", KOTLIN(sources), start);

  assert.deepEqual(await at([STORE, use("var local = store; local.save(\"x\")")], "local.save"), { kind: "unproven" });
  assert.deepEqual(await at([STORE, plain, use("plain.store.save(\"x\")", [], "Plain plain")]), { kind: "unproven" });
  assert.deepEqual(await at([STORE, use("java.util.List.of(store).get(0).save(\"x\")")]), { kind: "unproven" });
  assert.deepEqual(await at([STORE, use("missing.save(\"x\")")]), { kind: "unproven" });
  assert.deepEqual(await at([STORE, statics, use("Util.save(\"x\")")]), { kind: "unproven" });
  assert.deepEqual(await at([STORE, statics, use("Util.save(\"x\")", ["  Store Util;"])]), { kind: "unproven" });
  assert.deepEqual(await at([STORE, statics, use("Store Util = store; Util.save(\"x\")")], "Util.save"), { kind: "unproven" });
  assert.deepEqual(await at([plain, use("save(\"x\")", ["  void save(String value) {}"])]), { kind: "unproven" });
  assert.deepEqual(await at([plain, use("this.save(\"x\")", ["  void save(String value) {}"])]), { kind: "unproven" });
  assert.deepEqual(await at([plain, use("super.save(\"x\")")]), { kind: "unknown" });
});

/** The constructor a `super(...)` or `this(...)` written on `line` of `source` names, by the column it starts at. */
async function chainedAt(sources: readonly SourceFile[], source: SourceFile, line: number, keyword: "super" | "this"): Promise<ReceiverMethod> {
  const column = source.content.split("\n")[line - 1]!.indexOf(`${keyword}(`) + 1;
  const [found] = await createJavaNameBindings(createJavaParser, sources).receiverMethods([{ file: source.path, line, column, member: keyword }]);
  return found!;
}

test("super(...) and this(...) name the one constructor of the superclass or of the class with the call's arity; several at that arity, or a superclass outside the repository, name none", async () => {
  const a = java("A.java", ["package app;", "", "public class A {", "  public A(int a) {}", "  public A(int a, int b) {}", "}"]);
  const b = java("B.java", ["package app;", "", "public class B extends A {", "  public B() { super(1); }", "  public B(String s) { this(); }", "}"]);
  const overloaded = java("A.java", ["package app;", "", "public class A {", "  public A(int a) {}", "  public A(String a) {}", "}"]);
  const outside = java("C.java", ["package app;", "", "public class C extends RuntimeException {", "  public C() { super(\"c\"); }", "}"]);

  assert.deepEqual(await chainedAt([a, b], b, 4, "super"), method(a, 4));
  assert.deepEqual(await chainedAt([a, b], b, 5, "this"), method(b, 4));
  assert.deepEqual(await chainedAt([overloaded, b], b, 4, "super"), { kind: "unproven" });
  assert.deepEqual(await chainedAt([outside], outside, 4, "super"), { kind: "unknown" });
});

test("this(...) in a record names its declared constructor of the call's arity, a compact canonical constructor by the record's components, and none for an implicit canonical one", async () => {
  const compact = java("R.java", ["package app;", "", "public record R(int a, int b) {", "  public R(int a) { this(a, 0); }", "  public R() { this(1); }", "  public R { System.out.println(a); }", "}"]);
  const implicit = java("V.java", ["package app;", "", "public record V(int a) {", "  public V() { this(0); }", "}"]);

  assert.deepEqual(await chainedAt([compact], compact, 4, "this"), method(compact, 6));
  assert.deepEqual(await chainedAt([compact], compact, 5, "this"), method(compact, 4));
  assert.deepEqual(await chainedAt([implicit], implicit, 4, "this"), { kind: "unknown" });
});

test("two overloads of an argument's settled type bind the exact match, never both and never by arity", async () => {
  const owner = java("Owner.java", ["package app;", "", "public class Owner {}"]);
  const port = java("Port.java", ["package app;", "", "interface Port {", "  Owner find(String id);", "  Owner find(Long id);", "}"]);
  const both = java("Both.java", ["package app;", "", "interface Left { Owner find(String id); }", "interface Right { Owner find(String id); }", "interface Both extends Left, Right {}"]);

  assert.deepEqual(await methodAt([owner, port, use("port.find(\"7\")", [], "Port port")], "find"), method(port, 4));
  assert.deepEqual(await methodAt([owner, port, use("port.find(value)", [], "Port port, Object value")], "find"), { kind: "unproven", candidates: [place(port, 4), place(port, 5)] });
  assert.deepEqual(await methodAt([owner, both, use("both.find(\"7\")", [], "Both both")], "find"), { kind: "unproven", candidates: [place(both, 3), place(both, 4)] });
});

test("an unproven receiver names the declarations of the call's arity its type offers, and none where no member takes that arity", async () => {
  const port = java("Port.java", ["package app;", "", "interface Port {", "  Store find(String id);", "  Store find(Long id);", "}"]);

  assert.deepEqual(await methodAt([STORE, port, use("port.find(1)", [], "Port port")], "find"), { kind: "unproven", candidates: [place(port, 4), place(port, 5)] });
  assert.deepEqual(await methodAt([STORE, port, use("port.find()", [], "Port port")], "find"), { kind: "unproven" });
});

test("an exact match binds among public overloads of one package, the caller's own", async () => {
  const overloads = java("C.java", ["package app;", "", "public class C {", "  public void f(String x) {}", "  public void f(Object x) {}", "}"]);

  assert.deepEqual(await methodAt([overloads, use("c.f(\"x\")", [], "C c")], "f"), method(overloads, 4));
});

test("a call binds only an overload the caller can reach: a package-private one of another package is no candidate, so the public overload it hides binds", async () => {
  const library = javaIn("a", "C.java", ["package a;", "", "public class C {", "  void f(String x) {}", "  public void f(Object x) {}", "}"]);
  const caller = javaIn("b", "Use.java", ["package b;", "", "class Use {", "  void run(a.C c) { c.f(\"x\"); }", "}"]);

  assert.deepEqual(await methodAt([library, caller], "f"), method(library, 5));
});

test("generic overloads prove no exact match, since a raw argument is applicable to each by unchecked conversion and javac finds the call ambiguous", async () => {
  const generic = java("C.java", ["package app;", "", "class C {", "  void f(java.util.List<String> x) {}", "  void f(java.util.Collection<Integer> x) {}", "}"]);

  assert.deepEqual(await methodAt([generic, use("c.f(raw)", [], "C c, java.util.List raw")], "f"), { kind: "unproven", candidates: [place(generic, 4), place(generic, 5)] });
});

test("a plain argument still binds its exact overload beside a generic one, since no unchecked conversion makes the call ambiguous", async () => {
  const plain = java("C.java", ["package app;", "", "class C {", "  void f(String x) {}", "  void f(java.util.List<String> x) {}", "}"]);
  const protectedSame = java("Base.java", ["package app;", "", "public class Base {", "  protected void f(String x) {}", "  public void f(Object x) {}", "}"]);

  assert.deepEqual(await methodAt([plain, use("c.f(s)", [], "C c, String s")], "f"), method(plain, 4));
  assert.deepEqual(await methodAt([protectedSame, use("base.f(\"x\")", [], "Base base")], "f"), method(protectedSame, 4));
});

test("a call on a type name binds only a static method: the instance overload the arguments select is no fallback, while a static one binds", async () => {
  const mixed = java("C.java", ["package app;", "", "class C {", "  static void f(Object x) {}", "  void f(String x) {}", "}"]);
  const statically = java("C.java", ["package app;", "", "class C {", "  static void f(String x) {}", "  void f(Object x) {}", "}"]);

  assert.deepEqual(await methodAt([mixed, use("C.f(\"x\")", [], "")], "f"), { kind: "unproven" });
  assert.deepEqual(await methodAt([statically, use("C.f(\"x\")", [], "")], "f"), method(statically, 4));
});

test("given derived facts, a second reader over the same sources answers the same sites without parsing them again", async () => {
  const kept = new Map<string, string>();
  const facts: DerivedFacts = {
    ofFile: (_slot, _file, derive) => derive(),
    async ofInputs(slot, inputs, derive) {
      const key = JSON.stringify([slot, inputs]);
      if (!kept.has(key)) kept.set(key, JSON.stringify(await derive()));
      return JSON.parse(kept.get(key)!);
    },
    fingerprint: (inputs) => JSON.stringify(inputs),
    drain: () => ({ hits: 0, misses: 0, admitted: 0, admittedBytes: 0, evicted: 0, skipped: 0, factBytes: 0, retainedBytes: 0 }),
  };
  let parsed = 0;
  const counting = async () => {
    const parser = await createJavaParser();
    return { ...parser, parse: (file: Parameters<typeof parser.parse>[0]) => (parsed += 1, parser.parse(file)) };
  };
  const sources = [STORE, JDBC, use("store.save(\"x\")")];
  const sites = [{ file: sources[2]!.path, line: 4, column: sources[2]!.content.split("\n")[3]!.indexOf("{ ") + 3, member: "save" }];

  const first = await createJavaNameBindings(counting, sources, undefined, facts).receiverMethods(sites);
  const afterFirst = parsed;
  const again = await createJavaNameBindings(counting, sources.map((source) => ({ ...source })), undefined, facts).receiverMethods(sites);

  assert.deepEqual(first, [method(STORE, 4)]);
  assert.deepEqual(again, first);
  assert.equal(parsed, afterFirst);
});

const OVERLOADED_PORT = java("Port.java", ["package app;", "public interface Port {", "  void save(String value);", "  void save(String value, int times);", "}"]);
const OVERLOADING_IMPL = java("Impl.java", ["package app;", "public class Impl implements Port {", "  public void save(String value) {}", "  public void save(String value, int times) {}", "}"]);
const GENERIC_BOX = java("Box.java", ["package app;", "public interface Box<T> {", "  void put(T value);", "}"]);
const GENERIC_CRATE = java("Crate.java", ["package app;", "public class Crate implements Box<String> {", "  public void put(String value) {}", "}"]);

test("a Java method names the supertype declaration of its own signature, and a generic contract stays unknown", async () => {
  const answers = await createJavaNameBindings(createJavaParser, [OVERLOADED_PORT, OVERLOADING_IMPL, GENERIC_BOX, GENERIC_CRATE]).implementedDeclarations([
    { file: OVERLOADING_IMPL.path, start: 3, name: "save" },
    { file: OVERLOADING_IMPL.path, start: 4, name: "save" },
    { file: GENERIC_CRATE.path, start: 3, name: "put" },
  ]);
  assert.deepEqual(answers, [
    { kind: "declarations", declarations: [{ file: OVERLOADED_PORT.path, start: 3, nameLine: 3 }] },
    { kind: "declarations", declarations: [{ file: OVERLOADED_PORT.path, start: 4, nameLine: 4 }] },
    { kind: "unknown" },
  ]);
});

const NARROWING_IMPL = java("Narrow.java", ["package app;", "public class Narrow implements Port {", "  public void save(int value) {}", "}"]);
const REMOTE_IMPL = java("RemoteImpl.java", ["package app;", "import com.acme.Remote;", "public class RemoteImpl implements Remote {", "  public void save(int value) {}", "}"]);
const REPOSITORY = java("UserRepository.java", ["package app;", "import org.springframework.data.jpa.repository.JpaRepository;", "public interface UserRepository extends JpaRepository<String, Long> {", "  int count(int value);", "}"]);

test("a method whose complete hierarchy holds no member of its signature answers an established empty list", async () => {
  const answers = await createJavaNameBindings(createJavaParser, [OVERLOADED_PORT, NARROWING_IMPL]).implementedDeclarations([
    { file: NARROWING_IMPL.path, start: 3, name: "save" },
  ]);
  assert.deepEqual(answers, [{ kind: "declarations", declarations: [] }]);
});

test("a method whose hierarchy names a type the sources do not declare is unknown, since that type may declare the contract", async () => {
  const answers = await createJavaNameBindings(createJavaParser, [OVERLOADED_PORT, REMOTE_IMPL]).implementedDeclarations([
    { file: REMOTE_IMPL.path, start: 4, name: "save" },
  ]);
  assert.deepEqual(answers, [{ kind: "unknown" }]);
});

test("a repository method whose supertypes are framework interfaces names no contract, since no library type extends a repository type", async () => {
  const answers = await createJavaNameBindings(createJavaParser, [OVERLOADED_PORT, REPOSITORY]).implementedDeclarations([
    { file: REPOSITORY.path, start: 4, name: "count" },
  ]);
  assert.deepEqual(answers, [{ kind: "declarations", declarations: [] }]);
});

const WILDCARD_IMPL = java("WildcardImpl.java", ["package web;", "import app.*;", "public class WildcardImpl implements Port {", "  public void save(int value) {}", "}"]);

test("a method whose repository contract is reached through a wildcard import is unknown, not an empty answer", async () => {
  const answers = await createJavaNameBindings(createJavaParser, [OVERLOADED_PORT, WILDCARD_IMPL]).implementedDeclarations([
    { file: WILDCARD_IMPL.path, start: 3, name: "save" },
  ]);
  assert.deepEqual(answers, [{ kind: "unknown" }]);
});

test("references select only a unique member or constructor without using invocation arity", async () => {
  const unique = java("Target.java", ["package app;", "class Target {", "  Target(String x) {}", "  void save(String x) {}", "}"]);
  const overloaded = java("Target.java", ["package app;", "class Target {", "  Target(String x) {}", "  Target() {}", "  void save(String x) {}", "  void save() {}", "}"]);
  assert.deepEqual(await methodAt([unique, use("consume(target::save)", [], "Target target")], "save", undefined, "target::save"), method(unique, 4));
  assert.deepEqual(await methodAt([unique, use("consume(Target::new)", [], "")], "Target", undefined, "Target::new"), method(unique, 3));
  assert.deepEqual(await methodAt([unique, use("consume(Target::save)", [], "")], "save", undefined, "Target::save"), method(unique, 4));
  const self = use("consume(this::save)", ["  void save(String x) {}"], "");
  assert.deepEqual(await methodAt([self], "save", undefined, "this::save"), method(self, 5));
  assert.deepEqual(await methodAt([overloaded, use("consume(target::save)", [], "Target target")], "save", undefined, "target::save"), { kind: "unproven", candidates: [place(overloaded, 5), place(overloaded, 6)] });
  assert.deepEqual(await methodAt([overloaded, use("consume(Target::new)", [], "")], "Target", undefined, "Target::new"), { kind: "unproven", candidates: [place(overloaded, 3), place(overloaded, 4)] });
});

test("constructor references preserve private and package accessibility", async () => {
  const hidden = java("Target.java", ["package app;", "public class Target {", "  private Target(String x) {}", "}"]);
  const packageLocal = java("other/Target.java", ["package app.other;", "public class Target {", "  Target(String x) {}", "}"]);
  const caller = use("consume(Target::new)", [], "");
  assert.deepEqual(await methodAt([hidden, caller], "Target", undefined, "Target::new"), { kind: "unproven" });
  assert.deepEqual(await methodAt([packageLocal, use("consume(app.other.Target::new)", [], "")], "Target", undefined, "app.other.Target::new"), { kind: "unproven", candidates: [] });
});
