import { test } from "node:test";
import assert from "node:assert/strict";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaNameBindings } from "./java-name-bindings.adapter.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { DispatchTargets } from "../../ports/import-origins.port.ts";

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

  assert.deepEqual(await targetsOf([SENDER], mapped, 5), { kind: "unknown" });
  assert.deepEqual(await targetsOf([SENDER], routed), { kind: "unknown" });
  assert.deepEqual(await targetsOf([SENDER], deprecated), { kind: "bodies", bodies: [body(SENDER, 4)] });
});

test("an owner whose hierarchy reaches a type outside the repository has unknown bodies", async () => {
  const framework = { ...PORT, content: PORT.content.replace("public interface Port {", "public interface Port extends org.springframework.data.repository.Repository<String, Long> {") };

  assert.deepEqual(await targetsOf([SENDER], framework), { kind: "unknown" });
});

test("an anonymous or a local class that implements the owner or a type below it makes the bodies unknown", async () => {
  const anonymous = java("Anonymous.java", ["package app;", "", "class Anonymous {", "  Port port = new Sender() {", "    public void send(String message) {}", "  };", "}"]);
  const local = java("Local.java", ["package app;", "", "class Local {", "  void run() {", "    class Inline implements Port { public void send(String m) {} public void close() {} }", "  }", "}"]);

  assert.deepEqual(await targetsOf([SENDER, anonymous]), { kind: "unknown" });
  assert.deepEqual(await targetsOf([SENDER, local]), { kind: "unknown" });
});

test("a lambda or a method reference makes the bodies of a functional interface unknown, not those of an interface with two abstract methods", async () => {
  const functional = java("Port.java", ["package app;", "", "public interface Port {", "  void send(String message);", "  boolean equals(Object other);", "}"]);
  const single = java("Sender.java", ["package app;", "", "public class Sender implements Port {", "  public void send(String message) {}", "}"]);
  const lambda = java("Tasks.java", ["package app;", "", "class Tasks {", "  Runnable task = () -> {};", "}"]);

  assert.deepEqual(await targetsOf([single, lambda], functional), { kind: "unknown" });
  assert.deepEqual(await targetsOf([single], functional), { kind: "bodies", bodies: [body(single, 4)] });
  assert.deepEqual(await targetsOf([SENDER, lambda]), { kind: "bodies", bodies: [body(SENDER, 4)] });
});

test("an enum below the owner makes the bodies unknown, since its constants may declare their own", async () => {
  const kinds = java("Kinds.java", ["package app;", "", "enum Kinds implements Port {", "  ONE;", "  public void send(String message) {}", "  public void close() {}", "}"]);

  assert.deepEqual(await targetsOf([SENDER, kinds]), { kind: "unknown" });
});

test("a concrete class whose chain reaches no single body of the method's signature makes the bodies unknown", async () => {
  const inherited = java("Listed.java", ["package app;", "", "import java.util.ArrayList;", "", "public class Listed extends ArrayList<String> implements Port {", "  public void close() {}", "}"]);
  const overload = java("Sender.java", ["package app;", "", "public class Sender implements Port {", "  public void send(Integer message) {}", "  public void close() {}", "}"]);

  assert.deepEqual(await targetsOf([SENDER, inherited]), { kind: "unknown" });
  assert.deepEqual(await targetsOf([overload]), { kind: "unknown" });
});

test("a supertype the strict reading leaves unsettled under the name of the owner or a type below it makes the bodies unknown", async () => {
  const elsewhere = java("other/Stranger.java", ["package app.other;", "", "public class Stranger implements Port {", "  public void send(String message) {}", "  public void close() {}", "}"]);
  const unrelated = java("other/Unrelated.java", ["package app.other;", "", "public class Unrelated implements Missing {}"]);

  assert.deepEqual(await targetsOf([SENDER, elsewhere]), { kind: "unknown" });
  assert.deepEqual(await targetsOf([SENDER, unrelated]), { kind: "bodies", bodies: [body(SENDER, 4)] });
});

test("a JDK API that implements an interface at run time, named anywhere, makes every body unknown", async () => {
  const proxy = java("Proxies.java", ["package app;", "", "import java.lang.reflect.Proxy;", "", "class Proxies {", "  Object make() { return Proxy.newProxyInstance(null, null, null); }", "}"]);

  assert.deepEqual(await targetsOf([SENDER, proxy]), { kind: "unknown" });
});

test("a default in a more specific interface overrides the abstract method it inherits, so an interface left with one abstract method is functional and a lambda makes its bodies unknown", async () => {
  const base = java("Base.java", ["package app; public interface Base { void close(); }"]);
  const port = java("Port.java", ["package app;", "public interface Port extends Base {", " void send(String s);", " default void close() {}", "}"]);
  const lambda = java("Refs.java", ["package app; class Refs { Port p = s -> System.exit(1); }"]);
  const sender = java("Sender.java", ["package app;", "public class Sender implements Port {", " public void send(String s) {}", " public void close() {}", "}"]);

  assert.deepEqual(await targetsOf([base, lambda, sender], port, 3), { kind: "unknown" });
});

test("a lambda that implements a functional interface below the owner makes the owner's bodies unknown", async () => {
  const sub = java("Sub.java", ["package app; public interface Sub extends Port { default void close() {} }"]);
  const lambda = java("Refs.java", ["package app; class Refs { Sub p = s -> System.exit(1); }"]);

  assert.deepEqual(await targetsOf([SENDER, sub, lambda]), { kind: "unknown" });
});

test("an inherited method of one name and arity spelled with other parameter types may be the same signature, so the interface may be functional and a lambda makes its bodies unknown", async () => {
  const base = java("Base.java", ["package app; public interface Base<T> { void send(T message); }"]);
  const port = java("Port.java", ["package app;", "public interface Port extends Base<String> {", " void close();", " void send(String message);", "}"]);
  const plain = java("Port.java", ["package app;", "public interface Port {", " void close();", " void send(String message);", " void send(Integer message);", "}"]);
  const lambda = java("Refs.java", ["package app; class Refs { Runnable task = () -> {}; }"]);
  const sender = java("Sender.java", ["package app;", "public class Sender implements Port {", " public void close() {}", " public void send(String message) {}", " public void send(Integer message) {}", "}"]);
  const closeOf = async (owner: SourceFile) => (await createJavaNameBindings(createJavaParser, [owner, base, lambda, sender]).dispatchTargets([{ file: owner.path, line: 3, name: "close" }]))[0];

  assert.deepEqual(await closeOf(port), { kind: "unknown" });
  assert.deepEqual(await closeOf(plain), { kind: "bodies", bodies: [{ file: sender.path, start: 3, nameLine: 3 }] });
});

test("an abstract method a more specific interface declares again overrides the default it inherits, so it still counts against a functional interface", async () => {
  const base = java("Base.java", ["package app; public interface Base { default void close() {} }"]);
  const strict = java("Strict.java", ["package app; public interface Strict extends Base { void close(); }"]);
  const port = java("Port.java", ["package app;", "public interface Port extends Strict, Base {", " void send(String message);", "}"]);
  const lambda = java("Refs.java", ["package app; class Refs { Runnable task = () -> {}; }"]);

  assert.deepEqual(await targetsOf([base, strict, lambda, SENDER], port, 3), { kind: "bodies", bodies: [body(SENDER, 4)] });
});
