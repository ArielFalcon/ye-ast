import assert from "node:assert/strict";
import test from "node:test";
import { createJavaParser, createJavaTreeHolds } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaRelations } from "./java-relations.adapter.ts";
import { heldJavaProject } from "./java-project.ts";

const sources = [
  { path: "app/Target.java", content: "package app; class Target {}" },
  { path: "app/Holder.java", content: [
    "package app;",
    "class Holder<T> {",
    "  private Target field;",
    "  Target copy(",
    "      Target input) {",
    "    return new Target();",
    "  }",
    "  T generic; String text; int number;",
    "  java.util.List<Target> many;",
    "}",
  ].join("\n") },
];

test("declared Java field, parameter, return and construction types are references with their own places", async () => {
  const answer = await createJavaRelations(createJavaParser).extract(sources);
  assert.deepEqual(answer.cuts, []);
  assert.deepEqual(answer.unresolved, []);
  assert.deepEqual(answer.relations.map((finding) => finding.status === "complete" && [finding.value.kind, finding.value.from, finding.value.to, finding.evidence[0]]), [3, 4, 5, 6, 9].map((line) => ["references", { path: "app/Holder.java", symbol: "Holder", line: 2 }, { path: "app/Target.java", symbol: "Target", line: 1 }, { path: "app/Holder.java", line }]));
});

test("unresolved, ambiguous and unread JVM types retain uncertainty rather than a complete empty stage", async () => {
  const reader = createJavaRelations(createJavaParser);
  const missing = await reader.extract([{ path: "Holder.java", content: "class Holder { Missing field; }" }]);
  assert.equal(missing.relations.length, 0);
  assert.ok(missing.unresolved.some((use) => use.file === "Holder.java" && use.line === 1 && use.name === "Missing"));
  const ambiguous = await reader.extract([...sources, { path: "app/Duplicate.java", content: "package app; class Target {}" }]);
  assert.equal(ambiguous.relations.length, 0);
  assert.ok(ambiguous.unresolved.some((use) => use.candidates?.includes("app.Target")));
  const unplaced = await reader.extract([{ path: "Types.java", content: "class Left { static class Target {} } class Right { static class Target {} } class User { Left.Target target; }" }]);
  assert.equal(unplaced.relations.length, 0);
  assert.ok(unplaced.unresolved.some((use) => use.candidates?.includes("Left.Target") && use.candidates.includes("Right.Target")));
  const outside = await reader.extract(sources, { paths: [...sources.map(({ path }) => path), "src/test/java/UnreadTest.java"] });
  assert.equal(outside.relations.length, 5);
  assert.deepEqual(outside.cuts, []);
  const unread = await reader.extract(sources, { paths: [...sources.map(({ path }) => path), "Other.kt"] });
  assert.equal(unread.relations.length, 0);
  assert.deepEqual(unread.cuts, [{ kind: "no-extractor", at: ["Other.kt"], reason: "language", reach: { kind: "anything" } }]);
  assert.deepEqual(unread.unresolved, []);
  const bounded = await reader.extract(sources, { completeSource: false });
  assert.equal(bounded.relations.length, 0);
  assert.ok(bounded.unresolved.some((use) => use.name === "Target"));
  const broken = await reader.extract([...sources, { path: "Broken.java", content: "class {" }]);
  assert.ok(broken.cuts.some((cut) => cut.at[0]?.startsWith("Broken.java:")));
});

test("the relation reader reuses the read's existing held Java project", async () => {
  const holds = createJavaTreeHolds();
  const hold = holds.open();
  const parser = await createJavaParser(holds);
  let parses = 0;
  const counted = async () => ({ parse: (source: (typeof sources)[number]) => { parses++; return parser.parse(source); } });
  try {
    await heldJavaProject(hold, counted, sources);
    const reader = createJavaRelations(counted);
    await reader.extract(sources, { hold });
    await reader.extract(sources, { hold });
    assert.equal(parses, sources.length);
  } finally {
    hold.release();
  }
});

test("annotations and qualified types use declaration binding while var remains inferred", async () => {
  const answer = await createJavaRelations(createJavaParser).extract([
    { path: "Marker.java", content: "@interface Marker {}" },
    { path: "model/Target.java", content: "package model; public class Target {}" },
    { path: "Use.java", content: "@Marker class Use {\n  model.Target field;\n  void run() { var value = new model.Target(); }\n}" },
    { path: "Port.java", content: "interface Port { model.Target copy(model.Target input); }" },
    { path: "model/PackageMarker.java", content: "package model; @interface PackageMarker {}" },
    { path: "model/package-info.java", content: "@PackageMarker package model;" },
  ]);
  assert.deepEqual(answer.cuts, []);
  assert.ok(answer.unresolved.some((use) => use.file === "model/package-info.java" && use.name === "PackageMarker"));
  assert.deepEqual(answer.relations.map((finding) => finding.status === "complete" && [finding.value.from.symbol, finding.value.to.symbol, finding.evidence[0]?.line]), [["Port", "Target", 1], ["Use", "Marker", 1], ["Use", "Target", 2], ["Use", "Target", 3]]);
});

const GENERATOR_POM = { path: "pom.xml", content: "<project><build><plugins><plugin><groupId>org.openapitools</groupId><artifactId>openapi-generator-maven-plugin</artifactId></plugin></plugins></build></project>" };
const PLAIN_POM = { path: "pom.xml", content: "<project><build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId></plugin></plugins></build></project>" };

/** A class under a supertype the snapshot does not hold, naming one imported type, one of its package and one nobody declares. */
function underAbsentSupertype(supertype: string): { path: string; content: string }[] {
  return [
    { path: "app/repo/Customer.java", content: "package app.repo; public class Customer {}" },
    { path: "app/web/Sibling.java", content: "package app.web; class Sibling {}" },
    { path: "app/web/Controller.java", content: `package app.web;\nimport app.repo.Customer;\nimport ${supertype};\nclass Controller implements ${supertype.split(".").at(-1)} {\n  Customer customer;\n  Sibling sibling;\n  Unknown unknown;\n}` },
  ];
}

const placedIn = (answer: Awaited<ReturnType<ReturnType<typeof createJavaRelations>["extract"]>>) =>
  answer.relations.map((finding) => finding.status === "complete" && [finding.value.from.symbol, finding.value.to.symbol, finding.evidence[0]?.line]);
const unplacedIn = (answer: Awaited<ReturnType<ReturnType<typeof createJavaRelations>["extract"]>>) => answer.unresolved.map((use) => [use.name, use.line]);

test("under a supertype a declared source generator explains, a repository type named by import or package is a placed reference and a name nobody declares stays unplaced", async () => {
  const sources = underAbsentSupertype("app.api.CustomersApi");
  const holds = createJavaTreeHolds();
  const hold = holds.open();
  try {
    for (const options of [{ context: [GENERATOR_POM] }, { context: [GENERATOR_POM], hold }]) {
      const answer = await createJavaRelations(() => createJavaParser(holds)).extract(sources, options);
      assert.deepEqual(answer.cuts, []);
      assert.deepEqual(placedIn(answer), [["Controller", "Customer", 5], ["Controller", "Sibling", 6]]);
      assert.deepEqual(unplacedIn(answer), [["CustomersApi", 4], ["Unknown", 7]]);
    }
  } finally {
    hold.release();
  }
});

test("under an absent supertype no declared generator explains, every simple type name stays unplaced", async () => {
  const strict = [["Customer", 5], ["CustomersApi", 4], ["Sibling", 6], ["Unknown", 7]];
  for (const [supertype, context] of [["app.api.CustomersApi", []], ["com.vendor.CustomersApi", [PLAIN_POM]]] as const) {
    const answer = await createJavaRelations(createJavaParser).extract(underAbsentSupertype(supertype), { context });
    assert.deepEqual(placedIn(answer), []);
    assert.deepEqual(unplacedIn(answer).toSorted(), strict);
  }
});

test("with a declared generator, the relation reader reuses the project the name-binding readers hold under that build", async () => {
  const sources = underAbsentSupertype("app.api.CustomersApi");
  const holds = createJavaTreeHolds();
  const hold = holds.open();
  const parser = await createJavaParser(holds);
  let parses = 0;
  const counted = async () => ({ parse: (source: (typeof sources)[number]) => { parses++; return parser.parse(source); } });
  try {
    await heldJavaProject(hold, counted, sources, [], { generatesInterfaces: true });
    await createJavaRelations(counted).extract(sources, { hold, context: [GENERATOR_POM] });
    assert.equal(parses, sources.length);
  } finally {
    hold.release();
  }
});

const STORE = { path: "fx/store/Store.java", content: "package fx.store;\npublic class Store {\n  public static final String CACHE = \"c\";\n  public static String helper() { return CACHE; }\n  public static class Inner { public static final String X = \"x\"; }\n  public static String Same = \"s\";\n  public static class Same {}\n}" };
const KIND = { path: "fx/store/Kind.java", content: "package fx.store;\npublic enum Kind { A, B }" };
const MARK = { path: "fx/store/Mark.java", content: "package fx.store;\npublic @interface Mark { String value() default \"\"; Kind kind() default Kind.A; }" };
const BASE = { path: "fx/base/Base.java", content: "package fx.base;\npublic class Base {\n  String fx;\n}" };
const qualified = (path: string, body: string) => ({ path, content: `package fx.use;\n${body}` });
const referencesIn = (answer: Awaited<ReturnType<ReturnType<typeof createJavaRelations>["extract"]>>) =>
  answer.relations.map((finding) => finding.status === "complete" && `${finding.value.from.symbol}->${finding.value.to.symbol}:${finding.evidence[0]?.line}`).toSorted();

test("a type an expression names by its package-qualified name is a reference at the line that writes it", async () => {
  const answer = await createJavaRelations(createJavaParser).extract([STORE, KIND, MARK, qualified("fx/use/Uses.java", [
    "import fx.store.Mark;",
    "import fx.store.Store;",
    "class Uses {",
    "  String read() { return fx.store.Store.CACHE; }",
    "  String call() { return fx.store.Store.helper().trim(); }",
    "  java.util.function.Supplier<String> ref() { return fx.store.Store::helper; }",
    "  @Mark(fx.store.Store.CACHE) void marked() {}",
    "  @Mark(kind = fx.store.Kind.B) void kinded() {}",
    "  int pick(Object kind) { return switch (kind) { case fx.store.Kind.A -> 1; default -> 2; }; }",
    "  String nested() { return fx.store.Store.Inner.X; }",
    "  String member() { return Store.Inner.X; }",
    "  String simple() { return Store.CACHE + java.util.Collections.emptyList(); }",
    "  String same() { return fx.store.Store.Same; }",
    "}",
  ].join("\n"))]);
  assert.deepEqual(answer.cuts, []);
  assert.deepEqual(answer.unresolved, []);
  assert.deepEqual(referencesIn(answer), ["Mark->Kind:2", "Uses->Inner:11", "Uses->Inner:12", "Uses->Kind:10", "Uses->Kind:9", "Uses->Mark:8", "Uses->Mark:9", "Uses->Store:14", "Uses->Store:5", "Uses->Store:6", "Uses->Store:7", "Uses->Store:8"]);
});

test("a variable in scope named like a package's first segment makes the qualified expression its own, whether a parameter, a local, a field or an inherited one", async () => {
  const answer = await createJavaRelations(createJavaParser).extract([STORE, KIND, BASE, { path: "fx/use/Holder.java", content: "package fx.use;\npublic class Holder { public Holder store; public Holder Store; public Holder Kind; public String CACHE; public String A; }" }, qualified("fx/use/Shadows.java", [
    "class Shadows extends fx.base.Base {",
    "  Holder fx;",
    "  Object parameter(Holder fx) { return fx.store.Store.CACHE; }",
    "  Object local() { Holder fx = null; return fx.store.Store.CACHE; }",
    "  Object field() { return fx.store.Store.CACHE; }",
    "  Object lambda() { java.util.function.Function<Holder, Object> f = fx -> fx.store.Store.CACHE; return f; }",
    "}",
  ].join("\n")), qualified("fx/use/Inherits.java", "class Inherits extends Sub { Object kind() { return fx.store.Kind.A; } }"), qualified("fx/use/Sub.java", "class Sub { protected Holder fx; }")]);
  assert.deepEqual(answer.unresolved, []);
  assert.deepEqual(referencesIn(answer), ["Inherits->Sub:2", "Shadows->Base:2", "Shadows->Holder:3", "Shadows->Holder:4", "Shadows->Holder:5", "Shadows->Holder:7", "Sub->Holder:2"]);
});

test("a field a superclass keeps private or to its package does not obscure the package, and one the sources cannot show leaves the type unplaced", async () => {
  const outside = qualified("fx/use/Outside.java", "class Outside extends Thread { Object read() { return fx.store.Store.CACHE; } }");
  const imported = qualified("fx/use/Imported.java", "import static org.vendor.Constants.*;\nclass Imported { Object read() { return fx.store.Store.CACHE; } }");
  const local = qualified("fx/use/Local.java", "class Local { Object read() { class Worker extends Thread { Object run(Object o) { return fx.store.Store.CACHE; } } return new Worker(); } }");
  const blocks = qualified("fx/use/Blocks.java", "class Blocks { Object read(Object o) { if (o instanceof String fx) return fx; return fx.store.Store.CACHE; } }");
  const hidden = qualified("fx/use/Hidden.java", "class Hidden extends fx.base.Base { Object read() { return fx.store.Store.CACHE; } }");
  const privateBase = qualified("fx/use/PrivateBase.java", "class PrivateBase { private PrivateBase fx; }");
  const kept = qualified("fx/use/Kept.java", "class Kept extends PrivateBase { Object read() { return fx.store.Store.CACHE; } }");
  const answer = await createJavaRelations(createJavaParser).extract([STORE, BASE, outside, imported, local, blocks, hidden, privateBase, kept]);
  assert.deepEqual(referencesIn(answer), ["Hidden->Base:2", "Hidden->Store:2", "Kept->PrivateBase:2", "Kept->Store:2"]);
  assert.deepEqual(answer.unresolved.filter((use) => use.name.includes(".")).map((use) => [use.file, use.line, use.name, use.candidates]).toSorted(), [blocks, imported, local, outside].map(({ path }) => [path, path === imported.path ? 3 : 2, "fx.store.Store", ["fx.store.Store"]]));
});
