import { test } from "node:test";
import assert from "node:assert/strict";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaNameBindings } from "./java-name-bindings.adapter.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { DispatchTargets } from "../../ports/import-origins.port.ts";
import type { LibraryReading } from "../../ports/library-signatures.port.ts";
import { jdkTypes, librariesOf, member, withMember } from "./java-library.testing.ts";

function java(path: string, lines: readonly string[]): SourceFile {
  return { path: `src/main/java/app/${path}`, content: `${lines.join("\n")}\n` };
}

/** `q` is declared at line 4: the port has one abstract method, so a function value may implement it. */
const PORT = java("Port.java", ["package app;", "", "public interface Port {", "  String q(String x);", "}"]);
const IMPL = java("Impl.java", ["package app;", "", "public class Impl implements Port {", "  public String q(String x) { return x; }", "}"]);
const HANDLER = java("Handler.java", ["package app;", "", "public interface Handler {", "  void on(String item);", "}"]);
const FACTORY = java("Factory.java", ["package app;", "", "public interface Factory {", "  Port create();", "}"]);

const BODIES: DispatchTargets = { kind: "bodies", bodies: [{ file: IMPL.path, start: 4, nameLine: 4 }] };
const VETOED: DispatchTargets = { kind: "unknown", reason: "dispatch not proven" };
const WILDCARDS = ["import java.util.*;", "import java.util.function.*;", "import java.util.stream.*;"];

/** The answer for `Port.q` when the repository also holds `member` in a class `Use` that imports `imports`, read over `libraries`. */
async function answer(member: string, libraries: LibraryReading | null = librariesOf(), imports: readonly string[] = WILDCARDS, ...more: readonly SourceFile[]): Promise<DispatchTargets> {
  const use = java("Use.java", ["package app;", ...imports, "class Use {", member, "}"]);
  const reading = createJavaNameBindings(createJavaParser, [PORT, IMPL, HANDLER, FACTORY, use, ...more], undefined, undefined, undefined, [], libraries ?? undefined);
  const [targets] = await reading.dispatchTargets([{ file: PORT.path, line: 4, name: "q" }]);
  return targets!;
}

test("a function value passed to a member of a library class the declared JDK holds releases the veto", async () => {
  const released: Readonly<Record<string, string>> = {
    "a chain from a typed parameter through return types": "void run(List<String> items) { items.stream().map(x -> x).filter(x -> true).reduce((a, b) -> a).orElseThrow(IllegalStateException::new); }",
    "a method reference as the accumulator": "void run(List<String> items) { items.stream().reduce(String::concat); }",
    "a field": "List<String> items; void run() { items.forEach(x -> {}); }",
    "a field through this": "List<String> items; void run() { this.items.removeIf(x -> true); }",
    "a local with a written type": "void run() { Optional<String> maybe = null; maybe.map(x -> x); }",
    "a constructed receiver": "void run() { new ArrayList<String>().removeIf(x -> true); }",
    "a cast receiver": "void run(Object o) { ((List<String>) o).removeIf(x -> true); }",
    "a type name with a static member": "void run() { Objects.requireNonNullElseGet(null, () -> \"x\"); }",
    "a repository method that returns a library type": "List<String> names() { return null; } void run() { names().stream().map(x -> x); }",
    "a repository method of an enclosing type through this": "List<String> names() { return null; } void run() { this.names().removeIf(x -> true); }",
    "a repository method of another type": "void run(Holder holder) { holder.names().removeIf(x -> true); }",
    "a method inherited through a library interface": "void run(ArrayList<String> items) { items.removeIf(x -> true); }",
  };
  const holder = java("Holder.java", ["package app;", "import java.util.List;", "public class Holder {", "  public List<String> names() { return null; }", "}"]);
  for (const [context, member] of Object.entries(released)) assert.deepEqual(await answer(member, librariesOf(), WILDCARDS, holder), BODIES, context);
});

test("a record's accessor types a receiver by its component unless a method of the name or a static field replaces the reading", async () => {
  const record = (body: string) => java("Basket.java", ["package app;", "import java.util.List;", `public record Basket(List<String> lines, Object other) { ${body} }`]);
  const call = "void run(Basket basket) { basket.lines().removeIf(x -> true); }";

  assert.deepEqual(await answer(call, librariesOf(), WILDCARDS, record("")), BODIES, "the implicit accessor returns the component's written type");
  assert.deepEqual(await answer(call, librariesOf(), WILDCARDS, record("public List<String> lines() { return null; }")), BODIES, "an explicit accessor returns its own written type");
  assert.deepEqual(await answer(call, librariesOf(), WILDCARDS, record("public Object lines() { return null; }")), VETOED, "an explicit accessor of another type replaces the component's");
  assert.deepEqual(await answer("void run(Basket basket) { basket.other().removeIf(x -> true); }", librariesOf(), WILDCARDS, record("")), VETOED, "a component of another type");
  assert.deepEqual(await answer("void run(Basket basket) { basket.missing().removeIf(x -> true); }", librariesOf(), WILDCARDS, record("static List<String> missing = null;")), VETOED, "a static field is no accessor");
});

/** A repository class whose `rr` takes the port, beside a library `Holder.rr(Runnable)`: a field `h` of the library type is released, and a repository `Foo h` is not. */
const FOO = java("Foo.java", ["package app;", "public class Foo {", "  boolean rr(Port p) { return true; }", "}"]);
const HOLDER = "Holder<String> h; ";

test("a variable that any binding form of the grammar declares in the member is never the library-typed field of its name", async () => {
  assert.deepEqual(await answer(`${HOLDER}void r(Object o) { h.rr(() -> {}); }`, librariesOf(), WILDCARDS, FOO), BODIES, "the field alone is the library type");
  const hidden: Readonly<Record<string, string>> = {
    "an instanceof pattern": "void r(Object o) { if (o instanceof Foo h) { h.rr(id -> \"\"); } }",
    "a final instanceof pattern": "void r(Object o) { if (o instanceof final Foo h) { h.rr(id -> \"\"); } }",
    "an instanceof pattern in a conjunction": "void r(Object o) { if (o instanceof Foo h && h.rr(id -> \"\")) { } }",
    "a negated instanceof pattern that returns early": "void r(Object o) { if (!(o instanceof Foo h)) return; h.rr(id -> \"\"); }",
    "an instanceof pattern declared after the use": "void r(Object o) { h.rr(() -> {}); boolean b = o instanceof Foo h; }",
    "a type pattern of a switch": "void r(Object o) { switch (o) { case Foo h -> h.rr(id -> \"\"); default -> {} } }",
    "a record pattern component": "record Pair(Foo first) {} void r(Object o) { if (o instanceof Pair(Foo h)) { h.rr(id -> \"\"); } }",
    "a local in an old-style switch group, in scope in the next group": "void r(int k) { switch (k) { case 1: Foo h = new Foo(); break; case 2: h = new Foo(); h.rr(id -> \"\"); } }",
    "a local": "void r() { Foo h = new Foo(); h.rr(id -> \"\"); }",
    "a parameter": "void r(Foo h) { h.rr(id -> \"\"); }",
    "a for variable": "void r() { for (Foo h = new Foo(); h != null; h = null) { h.rr(id -> \"\"); } }",
    "an enhanced for variable": "void r(java.util.List<Foo> foos) { for (Foo h : foos) { h.rr(id -> \"\"); } }",
    "a resource": "void r() throws Exception { try (Foo h = new Foo()) { h.rr(id -> \"\"); } }",
    "a catch parameter": "void r() { try { } catch (RuntimeException h) { h.rr(id -> \"\"); } }",
    "an inferred lambda parameter": "void r(Consumer<Foo> c) { Consumer<Foo> d = h -> h.rr(id -> \"\"); }",
    "a typed lambda parameter": "void r() { Consumer<Foo> d = (Foo h) -> h.rr(id -> \"\"); }",
    "a var": "void r() { var h = new Foo(); h.rr(id -> \"\"); }",
    "a variable-arity parameter": "void r(Foo... h) { h.rr(id -> \"\"); }",
  };
  for (const [form, member] of Object.entries(hidden)) assert.deepEqual(await answer(`${HOLDER}${member}`, librariesOf(), WILDCARDS, FOO), VETOED, form);
});

test("a local declared in an old-style switch group is in scope in the groups after it, and a block that has ended hides its locals", async () => {
  const library = "void r(int k) { switch (k) { case 1: Holder<String> h = null; break; case 2: h.rr(() -> {}); } }";
  const ended = "void r(int k) { { Foo h = new Foo(); } h.rr(() -> {}); }";

  assert.deepEqual(await answer(`${HOLDER}${library}`, librariesOf(), WILDCARDS, FOO), BODIES, "the local of the first group types the use in the second");
  assert.deepEqual(await answer(`${HOLDER}${ended}`, librariesOf(), WILDCARDS, FOO), BODIES, "the block's local is out of scope, so the field is meant");
});

test("a supertype outside the repository is assumed not to redefine a name that resolves to java.* by an import (ADR-0064)", async () => {
  const outside = (body: string) => `class Child extends org.other.Base { ${body} }`;
  const released: Readonly<Record<string, string>> = {
    "a single-type import": outside("void run(List<String> items) { items.removeIf(x -> true); }"),
    "an on-demand import": outside("void run(Optional<String> items) { items.map(x -> x); }"),
    "a type name used as a receiver": outside("void run() { Objects.requireNonNullElseGet(null, () -> \"x\"); }"),
    "an interface outside the repository": "class Child implements java.io.Serializable { void run(List<String> items) { items.removeIf(x -> true); } }",
  };
  for (const [context, member] of Object.entries(released)) assert.deepEqual(await answer(member, librariesOf(), ["import java.util.List;", ...WILDCARDS]), BODIES, context);

  const kept: Readonly<Record<string, string>> = {
    "a name the repository declares": outside("void run(Basket basket) { basket.lines().removeIf(x -> true); }"),
    "a name a non-java import gives": outside("void run(org.acme.List<String> items) { items.removeIf(x -> true); }"),
    "a field of the repository that obscures the type name": outside("List<Port> Objects; void run() { Objects.requireNonNullElseGet(null, () -> \"x\"); }"),
    "a method of a repository class that extends a library class": outside("List<String> names() { return null; } void run() { names().removeIf(x -> true); }"),
    "a variable that may be inherited": outside("void run() { items.removeIf(x -> true); }"),
  };
  const basket = java("Basket.java", ["package app;", "import java.util.List;", "public record Basket(List<String> lines) { }"]);
  for (const [context, member] of Object.entries(kept)) assert.deepEqual(await answer(member, librariesOf(), ["import java.util.List;", ...WILDCARDS], basket), VETOED, context);
});

test("the type arguments of a receiver are substituted through the declared type, the supertypes and the arguments of a generic method", async () => {
  const released: Readonly<Record<string, string>> = {
    "an optional of a list": "void run(List<String> items) { Optional.ofNullable(items).orElse(null).stream().map(x -> x); }",
    "a get of a declared argument": "void run(List<List<String>> lists) { lists.get(0).removeIf(x -> true); }",
    "an argument through a supertype": "void run(ArrayList<List<String>> lists) { lists.get(0).removeIf(x -> true); }",
    "an argument of a cast": "void run(Object o) { ((Optional<List<String>>) o).get().removeIf(x -> true); }",
    "an argument of a constructed receiver": "void run() { new ArrayList<List<String>>().get(0).removeIf(x -> true); }",
    "a nested library argument": "void run(Optional<Optional<List<String>>> maybe) { maybe.get().get().removeIf(x -> true); }",
  };
  for (const [context, member] of Object.entries(released)) assert.deepEqual(await answer(member), BODIES, context);

  const kept: Readonly<Record<string, string>> = {
    "a wildcard argument": "void run(Optional<? extends List<String>> maybe) { maybe.get().removeIf(x -> true); }",
    "a diamond, which states no argument": "void run() { new ArrayList<>().get(0).removeIf(x -> true); }",
    "an argument whose type is not settled": "void run(Object o) { Optional.ofNullable(o).get().removeIf(x -> true); }",
    "an argument of a generic method that disagrees with a second": "void run(List<String> a, Object b) { Objects.requireNonNullElse(a, b).get(0).removeIf(x -> true); }",
    "a raw receiver": "void run(Optional maybe) { maybe.get().removeIf(x -> true); }",
    "a result the arguments do not give": "void run(List<String> items) { items.stream().map(x -> x).reduce((a, b) -> a).get().removeIf(x -> true); }",
    "an argument that is a primitive": "void run() { Optional.ofNullable(1).get().removeIf(x -> true); }",
  };
  for (const [context, member] of Object.entries(kept)) assert.deepEqual(await answer(member), VETOED, context);
});

test("a name that only on-demand imports can supply is the library class exactly one of them holds", async () => {
  const names = (imports: readonly string[]) => answer("void run(List<String> items) { items.removeIf(x -> true); }", librariesOf(), imports);

  assert.deepEqual(await names(["import java.util.*;"]), BODIES, "one container holds it");
  assert.deepEqual(await names(["import java.util.*;", "import org.acme.model.*;"]), BODIES, "another package cannot offer it too, since a reference both offer does not compile");
  assert.deepEqual(await names(["import java.util.*;", "import java.awt.*;"]), VETOED, "two containers hold it");
  assert.deepEqual(await names(["import org.acme.model.*;"]), VETOED, "no container holds it");
  assert.deepEqual(await names(["import java.util.List;"]), BODIES, "a single-type import");
  assert.deepEqual(await names(["import java.util.*;", "import static org.acme.Util.*;"]), VETOED, "a static import may bring a member type of the name");
  assert.deepEqual(await names(["import java.util.*;", "import org.acme.List;"]), VETOED, "a single-type import of another list binds the name");
});

test("a repository type of the name binds before the library class of an on-demand import", async () => {
  const own = java("List.java", ["package app;", "public interface List<T> { void removeIf(Handler h); }"]);

  assert.deepEqual(await answer("void run(List<String> items) { items.removeIf(x -> true); }", librariesOf(), ["import java.util.*;"], own), VETOED, "the receiver is a repository type, whose members this reading does not take");
});

test("a function value whose library parameter, receiver or candidates are not settled keeps the veto", async () => {
  const kept: Readonly<Record<string, string>> = {
    "a type variable parameter (fixture 1: an element added to a list of the port)": "void run(List<Port> ports) { ports.add(() -> \"lambda\"); }",
    "a type variable parameter beside a sibling (fixture 4)": "Port port; void run() { Objects.requireNonNullElse(port, x -> null); }",
    "an array parameter": "void run(List<String> items) { items.toArray(() -> null); }",
    "a primitive parameter": "void run(List<String> items) { items.get(() -> 1); }",
    "a receiver of a type outside the declared JDK": "void run(org.other.Mapper mapper) { mapper.map(x -> x); }",
    "a receiver imported from outside the JDK": "void run(Mapper mapper) { mapper.map(x -> x); }",
    "a var receiver": "void run() { var items = new ArrayList<String>(); items.removeIf(x -> true); }",
    "a lambda parameter receiver": "void run(List<List<String>> lists) { lists.forEach(inner -> inner.removeIf(x -> true)); }",
    "a result that is a wildcard argument": "void run(List<? extends List<String>> lists) { lists.get(0).removeIf(x -> true); }",
    "a result that is a raw type's variable": "void run(List lists) { lists.get(0).removeIf(x -> true); }",
    "a result whose argument is a type variable": "<T> void run(List<T> lists) { lists.get(0).removeIf(x -> true); }",
    "a result of a call through a type variable of the repository": "<T extends List<String>> T make() { return null; } void run() { make().removeIf(x -> true); }",
    "a receiver chain through a repository class that extends a library class (fixture 1)": "class Slots extends java.util.ArrayList<Port> {} void run(Slots slots) { slots.add(() -> \"lambda\"); }",
    "a sublist of a repository class that extends a library class (fixture 1)": "class Slots extends java.util.ArrayList<Port> {} void run(Slots slots) { slots.subList(0, 0).add(() -> \"sub\"); }",
    "a chain through a method inherited from a library class by a repository class": "class Slots extends java.util.ArrayList<String> { List<String> names() { return null; } } void run(Slots slots) { slots.names().removeIf(x -> true); }",
    "a method no member of the receiver's class has": "void run(List<String> items) { items.noSuchMember(x -> true); }",
    "an arity no member of the class has": "void run(List<String> items) { items.removeIf(x -> true, 1); }",
    "repository overloads of the arity that return different classes": "List<String> pick(int i) { return null; } Optional<String> pick(Integer i) { return null; } void run() { pick(1).removeIf(x -> true); }",
    "a call of a name that is also one of Object's": "List<String> toString(int i) { return null; } void run() { toString(1).removeIf(x -> true); }",
    "a receiver whose name is a variable that shadows a type": "List<Port> Objects; void run() { Objects.requireNonNullElseGet(null, () -> \"x\"); }",
    "a variable declared in a block that has ended, so a field is meant": "Object items; void run() { { List<String> items = null; } items.removeIf(x -> true); }",
    "a variable declared after its use, so a field it hides is meant": "void run() { items.removeIf(x -> true); List<String> items = null; } List<Port> ports; Object items;",
    "a receiver declared as a pattern variable": "void run(Object o) { if (o instanceof List<?> items) { items.removeIf(x -> true); } }",
    "the port in a nested function value (fixture 2)": "void run() { Factory f = () -> () -> \"lambda\"; }",
    "the port written on a declaration (fixture 3)": "Port p = x -> null;",
    "a var declaration (fixture 5)": "void run() { var p = x -> null; }",
  };
  for (const [context, member] of Object.entries(kept)) assert.deepEqual(await answer(member, librariesOf(), [...WILDCARDS, "import org.other.Mapper;"]), VETOED, context);
});

test("fixtures 1 to 6 of ADR-0044 stay vetoed with a JDK declared", async () => {
  const slots = "class Slots extends java.util.ArrayList<Port> {} ";
  const fixtures: Readonly<Record<string, string>> = {
    "1 a lambda added to a subclass of a library list": `${slots}void f(Slots slots) { slots.add(() -> "lambda"); }`,
    "1 a method reference": `${slots}void f(Slots slots) { slots.add(Use::body); } static Port body() { return null; }`,
    "1 a conditional": `${slots}void f(Slots slots, boolean c) { slots.add(c ? () -> "a" : () -> "b"); }`,
    "1 a switch expression": `${slots}void f(Slots slots, int c) { slots.add(switch (c) { case 1 -> () -> "a"; default -> () -> "b"; }); }`,
    "1 a sublist": `${slots}void f(Slots slots) { slots.subList(0, 0).add(() -> "sub"); }`,
    "2 a nested value": "Factory factory = () -> () -> \"lambda\"; Factory make() { return () -> () -> \"returned\"; }",
    "3 a declaration and a repository parameter": "void register(Port p) {} void f() { Port p = x -> null; register(x -> null); }",
    "4 a sibling argument of a generic method": "Port port; void f() { Objects.requireNonNullElse(port, x -> null); }",
    "5 a var": "Port make() { return null; } <T> void use(T a, T b) {} void f() { var p = make(); use(p, x -> null); }",
    "5 a generic identity": "<T> T id(T t) { return t; } void f() { Port y = id(x -> null); }",
    "5 a generic superclass": "class Base<T> { T get() { return null; } } class Svc extends Base<Port> { <T> void use(T a, T b) {} void f() { use(get(), x -> null); } }",
    "6 this below the port": "interface Sub extends Port { default Port self() { return this::q; } }",
  };
  for (const [fixture, member] of Object.entries(fixtures)) assert.deepEqual(await answer(member), VETOED, fixture);
});

test("a declared JDK that does not hold the types leaves every library context unsettled", async () => {
  const empty = librariesOf({});
  const members = ["void run(List<String> items) { items.removeIf(x -> true); }", "void run() { Objects.requireNonNullElseGet(null, () -> \"x\"); }"];

  for (const member of members) assert.deepEqual(await answer(member, empty), VETOED, member);
  for (const member of members) assert.deepEqual(await answer(member, null), VETOED, `${member} with no JDK declared`);
});

test("the flags of a table entry decide whether a variable-arity, a static or a nested value is settled", async () => {
  const varargs = "void run() { Collector.of(() -> null, (a, t) -> {}, (x, y) -> x); }";
  const named = "void run() { Comparator.comparing(i -> i); }";
  const nested = "Supplier<Function<String, String>> s = () -> i -> i;";
  const types = jdkTypes();

  assert.deepEqual(await answer(varargs), BODIES, "fixture 27: three arguments select the variable-arity declaration");
  assert.deepEqual(await answer(varargs, librariesOf(withMember(types, "java.util.stream.Collector", "of", { varargs: false }))), VETOED, "fixture 27: without the flag no declaration applies at the arity");
  assert.deepEqual(await answer(named), BODIES, "fixture 28: a static interface method selected through its type name");
  assert.deepEqual(await answer(named, librariesOf(withMember(types, "java.util.Comparator", "comparing", { static: false }))), VETOED, "fixture 28: without the flag no member is static");
  assert.deepEqual(await answer(nested), BODIES, "fixture 29: the inner value's target is Function, from Supplier.get and the type argument");
  assert.deepEqual(await answer(nested, librariesOf(withMember(types, "java.util.function.Supplier", "get", { abstract: false }))), VETOED, "fixture 29: without the flag the interface has no abstract method");
  assert.deepEqual(await answer("Supplier<Function<String, String>> s = () -> i -> i; Consumer<Function<String, String>> c = f -> {};"), BODIES);
  assert.deepEqual(await answer("Supplier<Port> s = () -> x -> null;"), VETOED, "the inner value's target is the port");
  assert.deepEqual(await answer("Supplier<? extends Port> s = () -> x -> null;"), VETOED, "a wildcard argument is not read");
  assert.deepEqual(await answer("Supplier s = () -> x -> null;"), VETOED, "a raw type states no argument");
});

test("a chain step whose library candidates return different classes is unsettled", async () => {
  const types = jdkTypes();
  const list = types["java.util.List"]!;
  const overloaded = { ...types, "java.util.List": { ...list, members: [...list.members, member("subList", ["int", "int"], "java.util.Collection<E>")] } };

  assert.deepEqual(await answer("void run(List<String> items) { items.subList(0, 0).removeIf(x -> true); }"), BODIES);
  assert.deepEqual(await answer("void run(List<String> items) { items.subList(0, 0).removeIf(x -> true); }", librariesOf(overloaded)), VETOED);
});

test("an interface static member is inherited by no subtype, and a class name selects no instance member", async () => {
  const types = jdkTypes();
  const inherited = { ...types, "java.util.List": { ...types["java.util.List"]!, members: [] }, "java.util.Collection": { ...types["java.util.Collection"]!, members: [{ ...types["java.util.Collection"]!.members[2]!, name: "of", static: true }] } };

  assert.deepEqual(await answer("void run(List<String> items) { items.of(x -> true); }", librariesOf(inherited)), VETOED, "the static member of a superinterface is not a member of the list");
  assert.deepEqual(await answer("void run() { Objects.requireNonNull(\"a\", () -> \"x\"); }", librariesOf(withMember(types, "java.util.Objects", "requireNonNull", { static: false }))), VETOED, "an instance member is no member of a type name");
});
