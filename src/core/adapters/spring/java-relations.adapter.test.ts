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
  assert.deepEqual(referencesIn(answer), ["Mark->Kind:2", "Uses->Inner:11", "Uses->Inner:12", "Uses->Kind:10", "Uses->Kind:9", "Uses->Mark:8", "Uses->Mark:9", "Uses->Store:14", "Uses->Store:5", "Uses->Store:6", "Uses->Store:7", "Uses->Store:8", "helper->CACHE:4", "marked->CACHE:8", "member->X:12", "nested->X:11", "read->CACHE:5", "simple->CACHE:13"]);
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
  assert.deepEqual(answer.unresolved.map((use) => [use.file, use.line, use.name]), [["fx/use/Shadows.java", 7, "CACHE"]]);
  assert.deepEqual(referencesIn(answer), ["Inherits->Sub:2", "Shadows->Base:2", "Shadows->Holder:3", "Shadows->Holder:4", "Shadows->Holder:5", "Shadows->Holder:7", "Sub->Holder:2", "helper->CACHE:4"]);
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
  assert.deepEqual(referencesIn(answer), ["Hidden->Base:2", "Hidden->Store:2", "Kept->PrivateBase:2", "Kept->Store:2", "helper->CACHE:4", "read->CACHE:2", "read->CACHE:2"]);
  assert.deepEqual(answer.unresolved.filter((use) => use.name.includes(".")).map((use) => [use.file, use.line, use.name, use.candidates]).toSorted(), [blocks, imported, local, outside].map(({ path }) => [path, path === imported.path ? 3 : 2, "fx.store.Store", ["fx.store.Store"]]));
});

const SUB = { path: "fx/store/Sub.java", content: "package fx.store;\npublic class Sub extends Store {\n  public static String own() { return \"\"; }\n  static String hidden() { return \"\"; }\n  public String instance() { return \"\"; }\n}" };
const CONSTS = { path: "fx/store/Consts.java", content: "package fx.store;\npublic interface Consts { String NAME = \"n\"; int[] SIZES = {}; }" };
const REMOTE = { path: "fx/store/Remote.java", content: "package fx.store;\npublic class Remote extends Thread { public static final String CACHE = \"r\"; }" };
/** The unplaced references the static-import reading leaves, apart from the simple type names an on-demand static import already leaves open. */
const importedUnplaced = (answer: Awaited<ReturnType<ReturnType<typeof createJavaRelations>["extract"]>>) => answer.unresolved.filter((use) => use.name.startsWith("fx.")).map((use) => `${use.file}:${use.line} ${use.name} ${use.candidates?.join(",")}`).toSorted();
const PARENT = { path: "fx/use/Parent.java", content: "package fx.use;\nclass Parent {\n  protected String CACHE;\n  static String helper() { return \"\"; }\n}" };

test("a simple name a static import binds to a member of a repository type is a reference to the imported type at the line that writes it", async () => {
  const answer = await createJavaRelations(createJavaParser).extract([STORE, KIND, MARK, SUB, CONSTS, qualified("fx/use/Binds.java", [
    "import static fx.store.Store.CACHE;",
    "import static fx.store.Kind.*;",
    "import static fx.store.Sub.*;",
    "import static fx.store.Consts.*;",
    "import fx.store.Mark;",
    "class Binds {",
    "  String read() { return CACHE; }",
    "  String chain() { return CACHE.trim(); }",
    "  java.util.function.Supplier<String> ref() { return CACHE::trim; }",
    "  @Mark(CACHE) void marked() {}",
    "  @Mark(kind = B) void kinded() {}",
    "  int pick(String s) { switch (s) { case CACHE: return 1; default: return 2; } }",
    "  String name() { return NAME + valueOf(\"A\"); }",
    "  String unknown() { return OTHER + call() + hidden() + instance(); }",
    "  int size() { return SIZES.length; }",
    "}",
  ].join("\n")), qualified("fx/use/CaseLabel.java", "import static fx.store.Kind.A;\nclass CaseLabel { int kind(fx.store.Kind k) {\n  switch (k) { case A: return 1; default: return 2; } } }")]);
  assert.deepEqual(answer.cuts, []);
  assert.deepEqual(importedUnplaced(answer), []);
  assert.deepEqual(referencesIn(answer), ["Binds->Consts:14", "Binds->Consts:16", "Binds->Kind:12", "Binds->Kind:14", "Binds->Store:10", "Binds->Store:11", "Binds->Store:13", "Binds->Store:8", "Binds->Store:9", "CaseLabel->Kind:3", "Mark->Kind:2", "Sub->Store:2", "chain->CACHE:9", "helper->CACHE:4", "marked->CACHE:11", "read->CACHE:8", "ref->CACHE:10"]);
});

test("a static method a repository type declares or inherits is called through its static import when nothing around the call declares the name", async () => {
  const sources = [STORE, SUB, qualified("fx/use/Calls.java", "import static fx.store.Sub.*;\nclass Calls {\n  String mine() { return own(); }\n  String inherited() { return helper(); }\n}"), qualified("fx/use/Single.java", "import static fx.store.Store.helper;\nclass Single { String call() { return helper(); } }")];
  const answer = await createJavaRelations(createJavaParser).extract(sources);
  assert.deepEqual(importedUnplaced(answer), []);
  assert.deepEqual(referencesIn(answer), ["Calls->Sub:4", "Calls->Sub:5", "Single->Store:3", "Sub->Store:2", "helper->CACHE:4"]);
  const bounded = await createJavaRelations(createJavaParser).extract(sources, { completeSource: false });
  assert.deepEqual(referencesIn(bounded), []);
  assert.deepEqual(importedUnplaced(bounded), ["fx/use/Calls.java:4 fx.store.Sub fx.store.Sub", "fx/use/Calls.java:5 fx.store.Sub fx.store.Sub", "fx/use/Single.java:3 fx.store.Store fx.store.Store"]);
});

test("a parameter, a local, a lambda or loop variable, an own or inherited field, or an own, inherited or record accessor method hides the member a static import brings", async () => {
  const answer = await createJavaRelations(createJavaParser).extract([STORE, PARENT, qualified("fx/use/Shadows.java", [
    "import static fx.store.Store.*;",
    "class Shadows extends Parent {",
    "  String parameter(String CACHE) { return CACHE; }",
    "  String local() { String CACHE = \"\"; return CACHE; }",
    "  String inheritedField() { return CACHE; }",
    "  String inheritedMethod() { return helper(); }",
    "}",
    "record Rec(String helper) { String call() { return helper(); } }",
    "class Own {",
    "  String CACHE;",
    "  String helper() { return \"\"; }",
    "  String field() { return CACHE + helper(); }",
    "}",
    "class Scoped {",
    "  Object lambda() { java.util.function.Function<String, String> f = CACHE -> CACHE; return f; }",
    "  Object loop(java.util.List<String> all) { for (String CACHE : all) return CACHE; return null; }",
    "}",
    "class After { String after() { return CACHE; } }",
  ].join("\n"))]);
  assert.deepEqual(importedUnplaced(answer), []);
  assert.deepEqual(referencesIn(answer), ["After->Store:19", "after->CACHE:19", "helper->CACHE:4"]);
});

test("a statically imported name is a reference when one import alone may bind it or a field it brings is certain, and an unplaced reference to the imported type where the sources cannot show what else binds it, unless its class already references that type", async () => {
  const answer = await createJavaRelations(createJavaParser).extract([STORE, REMOTE,
    qualified("fx/use/Outside.java", "import static fx.store.Store.*;\nclass Outside extends Thread { Object read() { return CACHE; } }"),
    qualified("fx/use/Pattern.java", "import static fx.store.Store.*;\nclass Pattern { Object read(Object o) { if (o instanceof String CACHE) return CACHE; return null; } }"),
    qualified("fx/use/Library.java", "import static org.vendor.Lib.CACHE;\nimport static fx.store.Store.*;\nclass Library { Object read() { return CACHE; } }"),
    qualified("fx/use/Overloads.java", "import static org.vendor.Lib.*;\nimport static fx.store.Store.*;\nclass Overloads { Object call() { return helper(); } }"),
    qualified("fx/use/Certain.java", "import static org.vendor.Lib.*;\nimport static fx.store.Store.*;\nclass Certain { Object call() { return helper(); }\n  Object read() { return CACHE; } }"),
    qualified("fx/use/Lone.java", "import static fx.store.Remote.*;\nclass Lone { Object read() { return MAX_PRIORITY; } }"),
    qualified("fx/use/Inherited.java", "import static fx.store.Remote.*;\nimport static org.vendor.Lib.*;\nclass Inherited { Object read() { return MAX_PRIORITY; } }"),
    qualified("fx/use/Head.java", "import static fx.store.Remote.*;\nclass Head { Object read() { return out.toString() + System.out; } }"),
  ]);
  assert.deepEqual(referencesIn(answer), ["Certain->Store:5", "Lone->Remote:3", "helper->CACHE:4", "read->CACHE:5"]);
  assert.deepEqual(importedUnplaced(answer), ["fx/use/Head.java:3 fx.store.Remote fx.store.Remote", "fx/use/Inherited.java:4 fx.store.Remote fx.store.Remote", "fx/use/Library.java:4 fx.store.Store fx.store.Store", "fx/use/Outside.java:3 fx.store.Store fx.store.Store", "fx/use/Overloads.java:4 fx.store.Store fx.store.Store", "fx/use/Pattern.java:3 fx.store.Store fx.store.Store"]);
});

test("static imports of types the repository does not declare add no reference and leave no name unplaced", async () => {
  const answer = await createJavaRelations(createJavaParser).extract([STORE, qualified("fx/use/Vendor.java", "import static org.vendor.Lib.*;\nimport static org.vendor.Other.CACHE;\nclass Vendor { Object read() { return CACHE + helper() + System.out; } }")]);
  assert.deepEqual(referencesIn(answer), ["helper->CACHE:4"]);
  assert.deepEqual(importedUnplaced(answer), []);
});

const KEYS = { path: "fx/store/Keys.java", content: "package fx.store;\npublic class Keys {\n  public static final String CACHE = \"c\";\n  private static final int LIMIT = 1;\n  public static String plain = \"p\";\n  public final String owned = \"o\";\n  public static Keys INSTANCE;\n  public Keys next;\n  static String own() { return LIMIT + \"\"; }\n}" };
const constantsIn = (answer: Awaited<ReturnType<ReturnType<typeof createJavaRelations>["extract"]>>) =>
  answer.relations.flatMap((finding) => (finding.status === "complete" && finding.value.to.path === KEYS.path && finding.value.to.symbol !== "Keys" && finding.value.from.path !== KEYS.path ? [`${finding.value.from.symbol}@${finding.value.from.line}->${finding.value.to.symbol}:${finding.evidence[0]?.line}`] : [])).toSorted();
const unsettledIn = (answer: Awaited<ReturnType<ReturnType<typeof createJavaRelations>["extract"]>>) => answer.unresolved.filter((use) => use.name === "CACHE").map((use) => `${use.file}:${use.line} ${use.name}`).toSorted();

test("a read of a constant is a reference from the declaration that writes it, wherever the sources prove which constant the name denotes", async () => {
  const answer = await createJavaRelations(createJavaParser).extract([KEYS, qualified("fx/use/Reads.java", [
    "import fx.store.Keys;",
    "class Reads extends Keys {",
    "  static final String COPY = Keys.CACHE, OTHER = fx.store.Keys.CACHE;",
    "  static { System.out.println(CACHE); }",
    "  Reads() { super(); String s = this.CACHE",
    "    + super.CACHE; }",
    "  @SuppressWarnings(Keys.CACHE) String annotated() { return \"\"; }",
    "  String inherited() { return CACHE; }",
    "  String typed(Keys keys, Keys[] many) { Keys local = keys; return keys.CACHE",
    "    + local.CACHE",
    "    + keys.next.CACHE",
    "    + Keys.INSTANCE.CACHE",
    "    + many.length; }",
    "  java.util.function.Supplier<String> lambda() { return () -> Keys.CACHE; }",
    "  int pick(String s) { switch (s) { case Keys.CACHE: return 1; default: return 0; } }",
    "  String values() { return Keys.plain + new Keys().owned; }",
    "  enum Mode { ON(Keys.CACHE); Mode(String s) {} }",
    "}",
  ].join("\n")), qualified("fx/use/Imports.java", "import static fx.store.Keys.CACHE;\nclass Imports { String read() { return CACHE; } }"), qualified("fx/use/OnDemand.java", "import static fx.store.Keys.*;\nclass OnDemand { String read() { return CACHE.trim(); } }")]);
  assert.deepEqual(constantsIn(answer), [
    "COPY@4->CACHE:4", "Mode@18->CACHE:18", "OTHER@4->CACHE:4", "Reads@3->CACHE:5", "Reads@6->CACHE:6", "Reads@6->CACHE:7", "annotated@8->CACHE:8", "inherited@9->CACHE:9",
    "lambda@15->CACHE:15", "pick@16->CACHE:16", "read@3->CACHE:3", "read@3->CACHE:3", "typed@10->CACHE:10", "typed@10->CACHE:11", "typed@10->CACHE:12", "typed@10->CACHE:13",
  ].toSorted());
  assert.deepEqual(unsettledIn(answer), []);
  assert.deepEqual(answer.unresolved.filter((use) => use.name === "owned"), []);
});

test("a local or a parameter of the constant's name, a private constant read outside its type, and a field that is not a constant are no read of a constant", async () => {
  const answer = await createJavaRelations(createJavaParser).extract([KEYS, qualified("fx/use/Hides.java", [
    "import static fx.store.Keys.CACHE;",
    "class Hides {",
    "  String parameter(String CACHE) { return CACHE; }",
    "  String local() { String CACHE = \"\"; return CACHE; }",
    "  String field() { return fx.store.Keys.plain + fx.store.Keys.LIMIT; }",
    "}",
    "class Holder { String CACHE; String own() { return CACHE; } }",
    "class Heir extends fx.store.Keys { String parameter(String CACHE) { return CACHE; } }",
  ].join("\n"))]);
  assert.deepEqual(constantsIn(answer), []);
  assert.deepEqual(unsettledIn(answer), []);
});

test("a read of a constant the sources cannot settle is an unresolved use of its name at the place, unless the same declaration already reads that constant where they do", async () => {
  const answer = await createJavaRelations(createJavaParser).extract([KEYS, qualified("fx/use/Open.java", [
    "import static fx.store.Keys.CACHE;",
    "import static org.vendor.Lib.*;",
    "class Open extends Thread {",
    "  String inherited() { return CACHE; }",
    "  String inferred() { var keys = new fx.store.Keys(); return keys.CACHE; }",
    "  String called() { return make().CACHE; }",
    "  String prefix() { return fx.store.Keys.CACHE; }",
    "  static fx.store.Keys make() { return null; }",
    "}",
  ].join("\n"))]);
  assert.deepEqual(constantsIn(answer), []);
  assert.deepEqual(unsettledIn(answer), ["fx/use/Open.java:5 CACHE", "fx/use/Open.java:6 CACHE", "fx/use/Open.java:7 CACHE", "fx/use/Open.java:8 CACHE"]);
  const once = await createJavaRelations(createJavaParser).extract([KEYS, qualified("fx/use/Once.java", "class Once extends fx.store.Keys {\n  String read(String s) { switch (s) { case CACHE: return fx.store.Keys.CACHE; default: return \"\"; } }\n  String label(String s) { switch (s) { case CACHE: return \"\"; default: return \"\"; } }\n}")]);
  assert.deepEqual(constantsIn(once), ["read@3->CACHE:3"]);
  assert.deepEqual(unsettledIn(once), ["fx/use/Once.java:4 CACHE"]);
});

test("a type an annotation's argument names by its simple name is a reference of the annotated declaration's type", async () => {
  const answer = await createJavaRelations(createJavaParser).extract([KEYS, qualified("fx/use/Marked.java", "import fx.store.Keys;\nclass Marked {\n  @SuppressWarnings(Keys.CACHE) void read() {}\n  String plain() { return Keys.CACHE.trim(); }\n}")]);
  assert.deepEqual(referencesIn(answer).filter((entry) => typeof entry === "string" && entry.startsWith("Marked->")), ["Marked->Keys:4"]);
});
