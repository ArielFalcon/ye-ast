import { test } from "node:test";
import assert from "node:assert/strict";
import { createJavaParser, createJavaTreeHolds } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaNameBindings } from "./java-name-bindings.adapter.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { DispatchTargets } from "../../ports/import-origins.port.ts";
import { closureOf, hierarchyOf } from "./java-dispatch-targets.ts";
import { withJavaSources } from "./java-project.ts";
import { createJavaProject } from "./java-symbols.ts";

function java(path: string, lines: readonly string[]): SourceFile {
  return { path: `src/main/java/app/${path}`, content: `${lines.join("\n")}\n` };
}

/** `send` is declared at line 4, so a site on line 3 (its annotation) or 4 names it. */
const PORT = java("Port.java", ["package app;", "", "public interface Port {", "  void send(String message);", "  void close();", "}"]);
const SENDER = java("Sender.java", ["package app;", "", "public class Sender implements Port {", "  public void send(String message) {}", "  public void close() {}", "}"]);

async function targetsOf(sources: readonly SourceFile[], port: SourceFile = PORT, line = 4): Promise<DispatchTargets> {
  const [targets] = await createJavaNameBindings(createJavaParser, [port, ...sources]).dispatchTargets([{ file: port.path, line, name: "send" }]);
  return targets!;
}

const body = (source: SourceFile, line: number) => ({ file: source.path, start: line, nameLine: line });

test("a body-less method runs, for each concrete class below its owner, that class's own declaration or the nearest one up its class chain", async () => {
  const loud = java("Loud.java", ["package app;", "", "public class Loud extends Sender {", "  @Override", "  public void send(String message) {}", "}"]);
  const quiet = java("Quiet.java", ["package app;", "", "public class Quiet extends Sender {}"]);
  const base = java("Base.java", ["package app;", "", "public abstract class Base implements Port {}"]);
  const leaf = java("Leaf.java", ["package app;", "", "public class Leaf extends Base {", "  public void send(String message) {}", "  public void close() {}", "}"]);

  assert.deepEqual(await targetsOf([SENDER, loud, quiet, base, leaf]), {
    kind: "bodies",
    bodies: [body(leaf, 4), { file: loud.path, start: 4, nameLine: 5 }, body(SENDER, 4)],
  });
});

test("an annotation other than the language's own on the owner or the method may make a generator or a proxy implement it, so the bodies are unknown", async () => {
  const mapped = { ...PORT, content: PORT.content.replace("public interface Port {", "@Mapper\npublic interface Port {") };
  const routed = { ...PORT, content: PORT.content.replace("  void send(String message);", "  @Deprecated @Get(\"/x\") void send(String message);") };
  const deprecated = { ...PORT, content: PORT.content.replace("  void send(String message);", "  @Deprecated void send(String message);") };

  assert.deepEqual(await targetsOf([SENDER], mapped, 5), { kind: "unknown", reason: "generated implementation" });
  assert.deepEqual(await targetsOf([SENDER], routed), { kind: "unknown", reason: "generated implementation" });
  assert.deepEqual(await targetsOf([SENDER], deprecated), { kind: "bodies", bodies: [body(SENDER, 4)] });
});

test("an owner whose hierarchy reaches a type outside the repository has unknown bodies", async () => {
  const framework = { ...PORT, content: PORT.content.replace("public interface Port {", "public interface Port extends org.springframework.data.repository.Repository<String, Long> {") };

  assert.deepEqual(await targetsOf([SENDER], framework), { kind: "unknown", reason: "generated implementation" });
});

test("an anonymous or a local class that implements the owner or a type below it makes the bodies unknown", async () => {
  const anonymous = java("Anonymous.java", ["package app;", "", "class Anonymous {", "  Port port = new Sender() {", "    public void send(String message) {}", "  };", "}"]);
  const local = java("Local.java", ["package app;", "", "class Local {", "  void run() {", "    class Inline implements Port { public void send(String m) {} public void close() {} }", "  }", "}"]);

  assert.deepEqual(await targetsOf([SENDER, anonymous]), { kind: "unknown", reason: "dispatch not proven" });
  assert.deepEqual(await targetsOf([SENDER, local]), { kind: "unknown", reason: "dispatch not proven" });
});

test("a lambda or a method reference makes the bodies of a functional interface unknown, not those of an interface with two abstract methods", async () => {
  const functional = java("Port.java", ["package app;", "", "public interface Port {", "  void send(String message);", "  boolean equals(Object other);", "}"]);
  const single = java("Sender.java", ["package app;", "", "public class Sender implements Port {", "  public void send(String message) {}", "}"]);
  const lambda = java("Tasks.java", ["package app;", "", "class Tasks {", "  Runnable task = () -> {};", "}"]);

  assert.deepEqual(await targetsOf([single, lambda], functional), { kind: "unknown", reason: "dispatch not proven" });
  assert.deepEqual(await targetsOf([single], functional), { kind: "bodies", bodies: [body(single, 4)] });
  assert.deepEqual(await targetsOf([SENDER, lambda]), { kind: "bodies", bodies: [body(SENDER, 4)] });
});

test("an enum below the owner makes the bodies unknown, since its constants may declare their own", async () => {
  const kinds = java("Kinds.java", ["package app;", "", "enum Kinds implements Port {", "  ONE;", "  public void send(String message) {}", "  public void close() {}", "}"]);

  assert.deepEqual(await targetsOf([SENDER, kinds]), { kind: "unknown", reason: "dispatch not proven" });
});

test("a concrete class whose chain reaches no single body of the method's signature makes the bodies unknown", async () => {
  const inherited = java("Listed.java", ["package app;", "", "import java.util.ArrayList;", "", "public class Listed extends ArrayList<String> implements Port {", "  public void close() {}", "}"]);
  const overload = java("Sender.java", ["package app;", "", "public class Sender implements Port {", "  public void send(Integer message) {}", "  public void close() {}", "}"]);

  assert.deepEqual(await targetsOf([SENDER, inherited]), { kind: "unknown", reason: "dispatch not proven" });
  assert.deepEqual(await targetsOf([overload]), { kind: "unknown", reason: "dispatch not proven" });
});

test("a supertype the strict reading leaves unsettled under the name of the owner or a type below it makes the bodies unknown", async () => {
  const elsewhere = java("other/Stranger.java", ["package app.other;", "", "public class Stranger implements Port {", "  public void send(String message) {}", "  public void close() {}", "}"]);
  const unrelated = java("other/Unrelated.java", ["package app.other;", "", "public class Unrelated implements Missing {}"]);

  assert.deepEqual(await targetsOf([SENDER, elsewhere]), { kind: "unknown", reason: "dispatch not proven" });
  assert.deepEqual(await targetsOf([SENDER, unrelated]), { kind: "bodies", bodies: [body(SENDER, 4)] });
});

test("a JDK API that implements an interface at run time, named anywhere, makes every body unknown", async () => {
  const proxy = java("Proxies.java", ["package app;", "", "import java.lang.reflect.Proxy;", "", "class Proxies {", "  Object make() { return Proxy.newProxyInstance(null, null, null); }", "}"]);

  assert.deepEqual(await targetsOf([SENDER, proxy]), { kind: "unknown", reason: "generated implementation" });
});

test("a default in a more specific interface overrides the abstract method it inherits, so an interface left with one abstract method is functional and a lambda makes its bodies unknown", async () => {
  const base = java("Base.java", ["package app; public interface Base { void close(); }"]);
  const port = java("Port.java", ["package app;", "public interface Port extends Base {", " void send(String s);", " default void close() {}", "}"]);
  const lambda = java("Refs.java", ["package app; class Refs { Port p = s -> System.exit(1); }"]);
  const sender = java("Sender.java", ["package app;", "public class Sender implements Port {", " public void send(String s) {}", " public void close() {}", "}"]);

  assert.deepEqual(await targetsOf([base, lambda, sender], port, 3), { kind: "unknown", reason: "dispatch not proven" });
});

test("a lambda that implements a functional interface below the owner makes the owner's bodies unknown", async () => {
  const sub = java("Sub.java", ["package app; public interface Sub extends Port { default void close() {} }"]);
  const lambda = java("Refs.java", ["package app; class Refs { Sub p = s -> System.exit(1); }"]);

  assert.deepEqual(await targetsOf([SENDER, sub, lambda]), { kind: "unknown", reason: "dispatch not proven" });
});

test("an inherited method of one name and arity spelled with other parameter types may be the same signature, so the interface may be functional and a lambda makes its bodies unknown", async () => {
  const base = java("Base.java", ["package app; public interface Base<T> { void send(T message); }"]);
  const port = java("Port.java", ["package app;", "public interface Port extends Base<String> {", " void close();", " void send(String message);", "}"]);
  const plain = java("Port.java", ["package app;", "public interface Port {", " void close();", " void send(String message);", " void send(Integer message);", "}"]);
  const lambda = java("Refs.java", ["package app; class Refs { Runnable task = () -> {}; }"]);
  const sender = java("Sender.java", ["package app;", "public class Sender implements Port {", " public void close() {}", " public void send(String message) {}", " public void send(Integer message) {}", "}"]);
  const closeOf = async (owner: SourceFile) => (await createJavaNameBindings(createJavaParser, [owner, base, lambda, sender]).dispatchTargets([{ file: owner.path, line: 3, name: "close" }]))[0];

  assert.deepEqual(await closeOf(port), { kind: "unknown", reason: "dispatch not proven" });
  assert.deepEqual(await closeOf(plain), { kind: "bodies", bodies: [{ file: sender.path, start: 3, nameLine: 3 }] });
});

test("an abstract method a more specific interface declares again overrides the default it inherits, so it still counts against a functional interface", async () => {
  const base = java("Base.java", ["package app; public interface Base { default void close() {} }"]);
  const strict = java("Strict.java", ["package app; public interface Strict extends Base { void close(); }"]);
  const port = java("Port.java", ["package app;", "public interface Port extends Strict, Base {", " void send(String message);", "}"]);
  const lambda = java("Refs.java", ["package app; class Refs { Runnable task = () -> {}; }"]);

  assert.deepEqual(await targetsOf([base, strict, lambda, SENDER], port, 3), { kind: "bodies", bodies: [body(SENDER, 4)] });
});

test("overloads of one name and arity whose parameter types hold a type variable of their interface may merge under a type argument, so the interface and every one below it may be functional and a lambda makes the bodies unknown", async () => {
  const port = java("Port.java", ["package app;", " public interface Port<T> {", " void send(T s);", " void send(String s);", " }"]);
  const sub = java("Sub.java", ["package app;", " interface Sub extends Port<String> {", "}"]);
  const lambda = java("Refs.java", ["package app;", " class Refs {", " Sub p = s -> {", "}", ";", " }"]);
  const sender = java("Sender.java", ["package app;", " public class Sender implements Port<String> {", " public void send(String s) {", "}", " }"]);
  const mid = java("Mid.java", ["package app;", " interface Mid<T> extends Port {", " void accept(T s);", " void accept(String s);", " default void send(String s) {", "}", " default void close() {", "}", " }"]);
  const deeper = java("Sub.java", ["package app;", " interface Sub extends Mid<String> {", "}"]);

  assert.deepEqual(await targetsOf([sub, lambda, sender], port, 4), { kind: "unknown", reason: "dispatch not proven" });
  assert.deepEqual(await targetsOf([SENDER, mid, deeper, lambda]), { kind: "unknown", reason: "dispatch not proven" });
});

test("overloads of one name and arity whose parameter types mention a type parameter of the method, bounded or not, a wildcard or a parameterized type may be one abstract method, so a lambda makes the bodies unknown", async () => {
  const lambda = java("Refs.java", ["package app;", "class Refs { Sub p = s -> {}; }"]);
  const sub = java("Sub.java", ["package app;", "interface Sub extends Port<String> {}"]);
  const sender = java("Sender.java", ["package app;", "class Sender implements Port<String> { public void send(String s) {} }"]);
  const portWith = (overload: string) => java("Port.java", ["package app;", "interface Port<T> {", ` ${overload}`, " void send(String s);", "}"]);

  for (const overload of ["<U extends T> void send(U s);", "<U> void send(U s);", "void send(java.util.List<?> s);", "void send(java.util.List<String> s);"]) {
    assert.deepEqual(await targetsOf([sub, lambda, sender], portWith(overload), 4), { kind: "unknown", reason: "dispatch not proven" }, overload);
  }
});

test("a class below that declares the method's name over a parameter type the strict reading settles to another type declares an overload, so the bodies are unknown", async () => {
  const value = java("Value.java", ["package app;", "", "public class Value {}"]);
  const homonym = java("other/Value.java", ["package app.other;", "", "public class Value {}"]);
  const port = java("Port.java", ["package app;", "", "public interface Port {", "  void send(Value value);", "}"]);
  const base = java("Base.java", ["package app;", "", "public class Base implements Port {", "  public void send(Value value) {}", "}"]);
  const overload = java("other/Sub.java", ["package app.other;", "", "public class Sub extends app.Base {", "  public void send(Value value) {}", "}"]);
  const override = java("other/Sub.java", ["package app.other;", "", "import app.Value;", "", "public class Sub extends app.Base {", "  public void send(Value value) {}", "}"]);

  assert.deepEqual(await targetsOf([value, homonym, base, overload], port), { kind: "unknown", reason: "dispatch not proven" });
  assert.deepEqual(await targetsOf([value, homonym, base, override], port), { kind: "bodies", bodies: [body(base, 4), body(override, 6)] });
});

test("a type name nothing in the repository binds is one type only for files that read it from the same package and on-demand imports, and array dimensions tell signatures apart", async () => {
  const port = java("Port.java", ["package app;", "", "public interface Port {", "  void send(Text text);", "}"]);
  const near = java("Near.java", ["package app;", "", "public class Near implements Port {", "  public void send(Text text) {}", "}"]);
  const far = java("other/Far.java", ["package app.other;", "", "public class Far implements app.Port {", "  public void send(Text text) {}", "}"]);
  const arrays = java("Near.java", ["package app;", "", "public class Near implements Port {", "  public void send(Text[] text) {}", "}"]);

  assert.deepEqual(await targetsOf([near], port), { kind: "bodies", bodies: [body(near, 4)] });
  assert.deepEqual(await targetsOf([near, far], port), { kind: "unknown", reason: "dispatch not proven" });
  assert.deepEqual(await targetsOf([arrays], port), { kind: "unknown", reason: "dispatch not proven" });
});

test("a type variable in the method's signature, or a name the strict reading leaves unsettled, is not certainly the type an implementation states, so the bodies are unknown", async () => {
  const generic = java("Port.java", ["package app;", "", "public interface Port<T> {", "  void send(T value);", "}"]);
  const sender = java("Sender.java", ["package app;", "", "public class Sender implements Port<Text> {", "  public void send(Text value) {}", "}"]);
  const port = java("Port.java", ["package app;", "", "public interface Port {", "  void send(Text text);", "}"]);
  const listed = java("Listed.java", ["package app;", "", "public class Listed extends java.util.ArrayList<String> implements Port {", "  public void send(Text text) {}", "}"]);

  assert.deepEqual(await targetsOf([sender], generic), { kind: "unknown", reason: "dispatch not proven" });
  const relay = java("Sender.java", ["package app;", "", "public class Sender<U> implements Port<String> {", "  public void send(U value) {}", "}"]);
  assert.deepEqual(await targetsOf([relay], generic), { kind: "unknown", reason: "dispatch not proven" });
  assert.deepEqual(await targetsOf([listed], port), { kind: "unknown", reason: "dispatch not proven" });
});


test("global aspect veto reasons precede dynamic generators and owner annotations regardless of source order", async () => {
  const aspect = java("Hooks.java", ["package app; @Aspect class Hooks { @Around(\"bean(sender)\") Object run() { return null; } }"]);
  const proxy = java("ProxyUse.java", ["package app; class ProxyUse { Object p = java.lang.reflect.Proxy.newProxyInstance(null, null, null); }"]);
  const service = { ...PORT, content: PORT.content.replace("public interface Port", "@Service public interface Port") };
  for (const sources of [[SENDER, proxy, aspect], [aspect, proxy, SENDER]]) {
    assert.deepEqual(await targetsOf(sources, service), { kind: "unknown", reason: "aspect may replace the body" });
  }
  assert.deepEqual(await targetsOf([SENDER], service), { kind: "unknown", reason: "generated implementation" });
});

test("an annotation type in the sources is read like any type declaration: a class implementing it keeps other owners' bodies, and its elements name no body", async () => {
  const marker = java("Marker.java", ["package app;", "", "public @interface Marker {", "  String value();", "}"]);
  const tagged = java("Tagged.java", ["package app;", "", "public class Tagged extends Sender implements Marker {", "  public String value() { return \"\"; }", "  public Class<? extends java.lang.annotation.Annotation> annotationType() { return Marker.class; }", "}"]);

  assert.deepEqual(await targetsOf([SENDER, marker, tagged]), { kind: "bodies", bodies: [body(SENDER, 4)] });
  const [element] = await createJavaNameBindings(createJavaParser, [PORT, SENDER, marker, tagged]).dispatchTargets([{ file: marker.path, line: 4, name: "value" }]);
  assert.deepEqual(element, { kind: "unknown", reason: "dispatch not proven" });
});

/** Reads `owner.method` over `sources` with the syntax trees alive for `use`. */
async function reading<T>(sources: readonly SourceFile[], owner: string, method: string, use: (read: { project: ReturnType<typeof createJavaProject>; hierarchy: NonNullable<ReturnType<typeof hierarchyOf>>; type: any; method: any }) => T): Promise<T> {
  const parser = await createJavaParser();
  return withJavaSources(parser, (parse) => {
    const { files } = parse(sources);
    const project = createJavaProject(files);
    const hierarchy = hierarchyOf(files, project);
    if (hierarchy === undefined) throw new Error("hierarchy vetoed");
    const type = project.types.find((candidate) => candidate.name === owner)!;
    return use({ project, hierarchy, type, method: type.methods.find((candidate) => candidate.name === method)! });
  });
}

test("the owner states the candidate bodies of a vetoed closure and the port still answers unknown", async () => {
  const port = java("Port.java", ["package app;", "", "public interface Port {", "  void send(String m);", "}"]);
  const sender = java("Sender.java", ["package app;", "", "public class Sender implements Port {", "  public void send(String m) {}", "}"]);
  const lambda = java("Tasks.java", ["package app;", "", "class Tasks {", "  Runnable task = () -> {};", "}"]);

  assert.deepEqual(await targetsOf([sender, lambda], port), { kind: "unknown", reason: "dispatch not proven" });
  await reading([port, sender, lambda], "Port", "send", ({ project, hierarchy, method }) => {
    const impl = project.types.find((candidate) => candidate.name === "Sender")!;
    const closure = closureOf(method, hierarchy);
    assert.equal(closure.kind, "vetoed");
    assert.equal(closure.kind === "vetoed" ? closure.reason : undefined, "dispatch not proven");
    assert.equal(closure.candidates.length, 1, "the candidate a veto hides is the body the port refuses to state");
    assert.equal(closure.candidates[0]!.receiver, impl);
    assert.equal(closure.candidates[0]!.method, impl.methods[0]);
  });
});

test("a closed owner keeps both candidate bodies in file and line order, and the port answers them unchanged", async () => {
  const loud = java("Loud.java", ["package app;", "", "public class Loud extends Sender {", "  @Override", "  public void send(String message) {}", "}"]);
  const quiet = java("Quiet.java", ["package app;", "", "public class Quiet extends Sender {}"]);

  assert.deepEqual(await targetsOf([SENDER, loud, quiet]), { kind: "bodies", bodies: [{ file: loud.path, start: 4, nameLine: 5 }, body(SENDER, 4)] });
  await reading([PORT, SENDER, loud, quiet], "Port", "send", ({ hierarchy, method }) => {
    const closure = closureOf(method, hierarchy);
    assert.equal(closure.kind, "closed");
    assert.deepEqual(closure.candidates.map(({ method: body, receiver }) => `${receiver.name}.${body.owner.name}`), ["Loud.Loud", "Quiet.Sender", "Sender.Sender"]);
  });
});

test("two files of one text at two paths are two implementations, read with or without a parse hold", async () => {  const impl = (module: string): SourceFile => ({ path: `${module}/src/main/java/app/Sender.java`, content: SENDER.content });
  const twins = [impl("m1"), impl("m2")];
  const holds = createJavaTreeHolds();
  const hold = holds.open();
  const kept = hold.keep([PORT, ...twins]);
  try {
    const [held] = await createJavaNameBindings(() => createJavaParser(holds), kept).dispatchTargets([{ file: PORT.path, line: 4, name: "send" }]);
    assert.deepEqual(held, { kind: "bodies", bodies: twins.map((twin) => body(twin, 4)) });
    assert.deepEqual(await targetsOf(twins), held);
  } finally {
    hold.release();
  }
});

test("an aspect vetoes dispatch only where a pointcut of the closed subset may match the bodies, and everywhere when any pointcut is outside it", async () => {
  const advising = (...pointcuts: string[]) => java("Hooks.java", ["package app;", "@Aspect class Hooks {", ...pointcuts.map((pointcut, index) => `  @Around(${JSON.stringify(pointcut)}) Object a${index}() { return null; }`), "}"]);
  const repository = { ...SENDER, content: SENDER.content.replace("public class Sender", "@org.springframework.stereotype.Repository public class Sender") };
  const timed = { ...SENDER, content: SENDER.content.replace("  public void send", "  @Timed public void send") };
  const VETO: DispatchTargets = { kind: "unknown", reason: "aspect may replace the body" };
  const RUNS: DispatchTargets = { kind: "bodies", bodies: [body(SENDER, 4)] };

  for (const pointcut of ["within(@org.springframework.stereotype.Repository *)", "@within(Repository)", "@annotation(Timed)", "execution(* other..*.*(..))", "within(other.*)", "within(app.Port) && execution(* app..*.close(..))"]) {
    assert.deepEqual(await targetsOf([SENDER, advising(pointcut)]), RUNS, pointcut);
  }
  assert.deepEqual(await targetsOf([repository, advising("within(@org.springframework.stereotype.Repository *)")]), VETO);
  assert.deepEqual(await targetsOf([repository, advising("@within(Repository)")]), VETO);
  assert.deepEqual(await targetsOf([timed, advising("@annotation(com.acme.Timed)")]), VETO);
  for (const pointcut of ["execution(* app.Sender.send(..))", "execution(public * app..*.*(..))", "within(app.*)", "within(other.*) || execution(* *(..))"]) {
    assert.deepEqual(await targetsOf([SENDER, advising(pointcut)]), VETO, pointcut);
  }
  for (const pointcut of ["bean(sender)", "!within(other.*)", "monitored()", "@annotation(timed)", "within(Sender)", "within(app.Port+)", "execution(@Timed * *(..))", "args(String)"]) {
    assert.deepEqual(await targetsOf([SENDER, advising("execution(* other..*.*(..))", pointcut)]), VETO, pointcut);
  }
  const timedClose = { ...SENDER, content: SENDER.content.replace("  public void close", "  @Timed public void close") };
  assert.deepEqual(await targetsOf([timedClose, advising("@annotation(Timed)")]), { kind: "bodies", bodies: [body(timedClose, 4)] }, "another method carries the annotation");
  const base = java("Base.java", ["package app;", "", "@Repository public class Base {", "  public void send(String message) {}", "}"]);
  const inherits = java("Leaf.java", ["package app;", "", "public class Leaf extends Base implements Port {", "  public void close() {}", "}"]);
  assert.deepEqual(await targetsOf([base, inherits, advising("@within(Repository)")]), VETO, "the body a class inherits is declared by an annotated class above it");
  const based = { ...SENDER, content: SENDER.content.replace("public class Sender implements Port", "public class Sender implements Port, java.io.Serializable") };
  const close = async (pointcut: string) => (await createJavaNameBindings(createJavaParser, [PORT, based, advising(pointcut)]).dispatchTargets([{ file: PORT.path, line: 5, name: "close" }]))[0];
  assert.deepEqual(await close("@within(Repository)"), VETO, "a supertype outside the repository may carry an inherited annotation");
  assert.deepEqual(await close("within(other.*)"), { kind: "bodies", bodies: [body(based, 5)] });
  const introduced = java("Hooks.java", ["package app;", "@Aspect class Hooks {", "  @DeclareParents(value = \"other.*\", defaultImpl = Object.class) static Port mixin;", "}"]);
  const concatenated = java("Hooks.java", ["package app;", "@Aspect class Hooks {", "  @Around(\"within(other.*)\" + \"\") Object a() { return null; }", "}"]);
  for (const aspect of [introduced, concatenated]) assert.deepEqual(await targetsOf([SENDER, aspect]), VETO, aspect.content);
});
