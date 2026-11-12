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
