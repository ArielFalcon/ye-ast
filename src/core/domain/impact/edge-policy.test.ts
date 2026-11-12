import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeConfidence, followsEdge, followsRelation, edgeVerdict, isIgnoredEdge, type EdgeScore } from "./edge-policy.ts";
import type { ImportOrigin } from "../relations/resolved-reference.ts";

const follows = (kind: string, sourceKind: string, targetKind: string): boolean => followsEdge({ kind, sourceKind, targetKind });

test("calls and instantiations from code, a class field's initializer included, are followed into any declaration", () => {
  assert.equal(follows("calls", "method", "method"), true);
  assert.equal(follows("instantiates", "function", "class"), true);
  assert.equal(follows("calls", "variable", "function"), true);
  assert.equal(follows("calls", "file", "function"), false);
  assert.equal(follows("calls", "interface", "function"), false);
  assert.equal(follows("calls", "field", "function"), true);
  assert.equal(follows("instantiates", "property", "class"), true);
});

test("a reference into code, a class or a type that shapes data is followed", () => {
  assert.equal(follows("references", "method", "function"), true);
  assert.equal(follows("references", "route", "component"), true);
  assert.equal(follows("references", "function", "constant"), true);
  assert.equal(follows("references", "function", "interface"), true);
  assert.equal(follows("references", "type_alias", "interface"), true);
  assert.equal(follows("references", "function", "enum"), true);
});

test("a reference from a field, a parameter or a file, or into one, is not followed", () => {
  assert.equal(follows("references", "field", "class"), false);
  assert.equal(follows("references", "property", "interface"), false);
  assert.equal(follows("references", "parameter", "interface"), false);
  assert.equal(follows("references", "file", "function"), false);
  assert.equal(follows("references", "method", "field"), false);
  assert.equal(follows("references", "method", "property"), false);
});

test("a subtype depends on its supertype, whatever extends or implements it", () => {
  assert.equal(follows("extends", "class", "class"), true);
  assert.equal(follows("implements", "class", "interface"), true);
  assert.equal(follows("extends", "interface", "interface"), true);
  assert.equal(follows("implements", "method", "interface"), false);
  assert.equal(follows("extends", "class", "function"), false);
});

test("navigation, imports, containment and the other edge kinds are not followed", () => {
  for (const kind of ["navigates", "imports", "contains", "type_of", "returns", "overrides", "decorates", "exports"]) {
    assert.equal(follows(kind, "method", "method"), false, kind);
  }
});

test("the edges codegraph synthesizes for templates, events and interface bridges are ignored, others are not", () => {
  const edge = (synthesizedBy: string | null): EdgeScore => ({ confidence: null, provenance: "heuristic", synthesizedBy });
  for (const name of ["angular-template", "angular-event", "interface-impl"]) assert.equal(isIgnoredEdge(edge(name)), true, name);
  assert.equal(isIgnoredEdge(edge("callback")), false);
  assert.equal(isIgnoredEdge(edge(null)), false);
});

test("an edge counts its score, a certain one counts 1 and a heuristic one without a score 0.3", () => {
  assert.equal(edgeConfidence({ confidence: 0.4, provenance: "tree-sitter", synthesizedBy: null }), 0.4);
  assert.equal(edgeConfidence({ confidence: 0, provenance: "heuristic", synthesizedBy: null }), 0);
  assert.equal(edgeConfidence({ confidence: null, provenance: null, synthesizedBy: null }), 1);
  assert.equal(edgeConfidence({ confidence: null, provenance: "scip", synthesizedBy: null }), 1);
  assert.equal(edgeConfidence({ confidence: null, provenance: "heuristic", synthesizedBy: null }), 0.3);
});

test("source relations follow only the declaration kinds each rule permits", () => {
  const relation = (kind: string, sourceKind: string, targetKind: string): boolean => followsRelation({ kind, sourceKind, targetKind });
  for (const kind of ["injects", "uses-component", "uses-directive", "uses-pipe"]) {
    assert.equal(relation(kind, "component", "class"), true, kind);
    assert.equal(relation(kind, "class", "component"), true, kind);
    assert.equal(relation(kind, "method", "class"), false, kind);
    assert.equal(relation(kind, "class", "interface"), false, kind);
    assert.equal(relation(kind, "class", "function"), false, kind);
  }
  assert.equal(relation("references", "class", "interface"), true);
  assert.equal(relation("references", "interface", "enum"), true);
  assert.equal(relation("references", "method", "class"), false);
  assert.equal(relation("references", "class", "function"), false);
});

test("only a root a package or the language's libraries bind is outside the repository", () => {
  const evidence = [{ path: "src/a.ts", line: 1 }];
  const root = (value: ImportOrigin) => edgeVerdict({ status: "complete", value, evidence }, undefined, { id: "function", file: "src/b.ts" }).kind === "drop";

  assert.equal(root({ kind: "external", module: "typescript" }), true);
  assert.equal(root({ kind: "ambient", name: "Promise" }), true);
  assert.equal(root({ kind: "repository", file: "src/b.ts" }), false);
  assert.equal(root({ kind: "local-parameter", name: "x" }), false);
  assert.equal(edgeVerdict({ status: "unknown", reason: "unresolved", evidence }, undefined, { id: "function", file: "src/b.ts" }).kind, "keep");
});

test("a root spelled alone that an import binds to another proven declaration redirects the edge to it", () => {
  const evidence = [{ path: "src/a.ts", line: 1 }];
  const repository: ImportOrigin = { kind: "repository", file: "src/parts.ts" };

  assert.deepEqual(edgeVerdict({ status: "complete", value: repository, evidence, bare: true }, "constant", { id: "function", file: "src/parts.ts" }), { kind: "redirect", to: "constant" });
  assert.deepEqual(edgeVerdict({ status: "complete", value: repository, evidence, bare: true }, "constant", { id: "constant", file: "src/parts.ts" }), { kind: "keep" });
});

test("an unproven binding or a root a longer chain reaches keeps the edge on the graph's target", () => {
  const evidence = [{ path: "src/a.ts", line: 1 }];
  const repository: ImportOrigin = { kind: "repository", file: "src/parts.ts" };

  assert.deepEqual(edgeVerdict({ status: "complete", value: repository, evidence, bare: true }, undefined, { id: "function", file: "src/other.ts" }), { kind: "keep" });
  assert.deepEqual(edgeVerdict({ status: "complete", value: repository, evidence }, "Logger", { id: "error", file: "src/parts.ts" }), { kind: "keep" });
});

test("a root spelled alone whose declaration the graph places nowhere drops an edge into another file, and keeps one into its declaring file", () => {
  const evidence = [{ path: "src/web/Resource.java", line: 1 }];
  const declared: ImportOrigin = { kind: "repository", file: "src/web/Resource.java", declared: "app.web.Resource.Visits" };
  const elsewhere = { id: "constructor", file: "src/dto/Visits.java" };
  const inside = { id: "constructor", file: "src/web/Resource.java" };

  assert.deepEqual(edgeVerdict({ status: "complete", value: declared, evidence, bare: true }, undefined, elsewhere), { kind: "drop" });
  assert.deepEqual(edgeVerdict({ status: "complete", value: declared, evidence, bare: true }, undefined, inside), { kind: "keep" });
  assert.deepEqual(edgeVerdict({ status: "complete", value: declared, evidence, bare: true }, "type", inside), { kind: "keep" });
  assert.deepEqual(edgeVerdict({ status: "complete", value: declared, evidence }, undefined, elsewhere), { kind: "keep" });
});

test("a root spelled alone that a parameter binds drops the edge, whatever the graph matched it to", () => {
  const evidence = [{ path: "src/a.ts", line: 1 }];
  const parameter: ImportOrigin = { kind: "local-parameter", name: "redact" };

  assert.deepEqual(edgeVerdict({ status: "complete", value: parameter, evidence, bare: true }, undefined, { id: "redact", file: "src/redact.ts" }), { kind: "drop" });
  assert.deepEqual(edgeVerdict({ status: "complete", value: parameter, evidence }, undefined, { id: "redact", file: "src/redact.ts" }), { kind: "keep" });
});
