import { test } from "node:test";
import assert from "node:assert/strict";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaNameBindings } from "./java-name-bindings.adapter.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ReceiverFit } from "../../ports/import-origins.port.ts";

function java(path: string, lines: readonly string[]): SourceFile {
  return { path: `src/main/java/app/${path}`, content: `${lines.join("\n")}\n` };
}

const MAPPER = java("Mapper.java", ["package app;", "", "public interface Mapper<S, T> {", "  T convert(S source);", "}"]);
const TYPES = java("Types.java", ["package app;", "", "class Tax {}", "class Rate {}", "class Cat {}", "class Entry {}"]);

/** The class whose method `convert` is the origin: its clause binds the interface, and `convert` starts on line 6. */
function implementation(clause: string, typeParameters = ""): SourceFile {
  return java("TaxMapper.java", ["package app;", "", "import java.util.List;", "", `public class TaxMapper${typeParameters} ${clause} {`, "  public Rate convert(Tax source) { return null; }", "}"]);
}

const TAX_MAPPER = implementation("implements Mapper<Tax, Rate>");

/** A `Use` class of the given type parameters and fields, whose `run` calls `mapper.convert` on its last line. */
function use(fields: readonly string[], typeParameters = ""): SourceFile {
  return java("Use.java", ["package app;", "", "import java.util.List;", "", `class Use${typeParameters} {`, ...fields, "  void run() { mapper.convert(null); }", "}"]);
}

/** What the call in `user` says of a value of the class that declares the origin's method. */
async function fitOf(user: SourceFile, origin: SourceFile = TAX_MAPPER, more: readonly SourceFile[] = []): Promise<ReceiverFit> {
  const lines = user.content.split("\n");
  const at = lines.findIndex((line) => line.includes("mapper.convert("));
  const [fit] = await createJavaNameBindings(createJavaParser, [MAPPER, TYPES, origin, user, ...more]).receiverFits!([
    { file: user.path, line: at + 1, column: lines[at]!.indexOf("{ ") + 3, member: "convert", implementation: { file: origin.path, start: 6, name: "convert" } },
  ]);
  return fit!;
}

const DISJOINT: ReceiverFit = { kind: "disjoint" };
const UNKNOWN: ReceiverFit = { kind: "unknown" };

test("a receiver declared with type arguments is disjoint from an implementation whose class binds the interface to other ground types", async () => {
  assert.deepEqual(await fitOf(use(["  Mapper<Cat, Entry> mapper;"])), DISJOINT);
  assert.deepEqual(await fitOf(use(["  Mapper<Tax, Entry> mapper;"])), DISJOINT, "one position is enough");
  assert.deepEqual(await fitOf(use(["  Mapper<List<Tax>, Rate> mapper;"])), DISJOINT, "a platform type is not a repository type");
  assert.deepEqual(await fitOf(use(["  Mapper<List<Cat>, Rate> mapper;"]), implementation("implements Mapper<List<Tax>, Rate>")), DISJOINT, "the arguments of an argument");
});

test("equal arguments, or any argument that is not ground, leave the call unknown", async () => {
  const cases: [string, SourceFile, SourceFile?][] = [
    ["equal", use(["  Mapper<Tax, Rate> mapper;"])],
    ["raw", use(["  Mapper mapper;"])],
    ["not generic", use(["  TaxMapper mapper;"])],
    ["wildcard", use(["  Mapper<? extends Cat, Rate> mapper;"])],
    ["type variable", use(["  Mapper<A, Rate> mapper;"], "<A>")],
    ["array", use(["  Mapper<Cat[], Rate> mapper;"])],
    ["unresolved name", use(["  Mapper<Missing, Rate> mapper;"])],
    ["nested wildcard", use(["  Mapper<List<?>, Rate> mapper;"]), implementation("implements Mapper<List<Tax>, Rate>")],
    ["no declaration of the receiver", use([])],
  ];
  for (const [label, user, origin] of cases) assert.deepEqual(await fitOf(user, origin), UNKNOWN, label);
});

test("a position that is proven different stands where another is a type variable, in the receiver or in the clause", async () => {
  assert.deepEqual(await fitOf(use(["  Mapper<A, Entry> mapper;"], "<A>")), DISJOINT);
  assert.deepEqual(await fitOf(use(["  Mapper<Cat, Entry> mapper;"]), implementation("implements Mapper<A, Rate>", "<A>")), DISJOINT);
  assert.deepEqual(await fitOf(use(["  Mapper<Cat, Rate> mapper;"]), implementation("implements Mapper<A, Rate>", "<A>")), UNKNOWN);
});

test("an implementation that does not write the receiver's type itself in its own clause is not compared", async () => {
  const base = java("Base.java", ["package app;", "", "abstract class Base<S> implements Mapper<S, Rate> {}"]);
  assert.deepEqual(await fitOf(use(["  Mapper<Cat, Entry> mapper;"]), implementation("extends Base<Tax>"), [base]), UNKNOWN);
  assert.deepEqual(await fitOf(use(["  Mapper<Cat, Entry> mapper;"]), implementation("implements Mapper")), UNKNOWN);
});

test("a class is compared only through the generic type the receiver is declared with, and a place several calls start at must be disjoint in each", async () => {
  const other = java("Other.java", ["package app;", "", "interface Other<S, T> {}"]);
  assert.deepEqual(await fitOf(use(["  Mapper<Tax, Rate> mapper;"]), implementation("implements Other<Cat, Entry>"), [other]), UNKNOWN);
  const chain = java("Use.java", ["package app;", "", "class Use {", "  Mapper<Cat, Entry> mapper;", "  void run() { mapper.convert(null).convert(null); }", "}"]);
  assert.deepEqual(await fitOf(chain), UNKNOWN);
});

test("a source the reader cannot parse leaves every call unknown", async () => {
  assert.deepEqual(await fitOf(use(["  Mapper<Cat, Entry> mapper;"]), TAX_MAPPER, [java("Broken.java", ["package app;", "class Broken {", "  void f( {"])]), UNKNOWN);
});
