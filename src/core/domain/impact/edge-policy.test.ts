import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeConfidence, followsEdge, followsRelation, isIgnoredEdge, type EdgeScore } from "./edge-policy.ts";

const follows = (kind: string, sourceKind: string, targetKind: string): boolean => followsEdge({ kind, sourceKind, targetKind });

test("calls and instantiations from code are followed into any declaration", () => {
  assert.equal(follows("calls", "method", "method"), true);
  assert.equal(follows("instantiates", "function", "class"), true);
  assert.equal(follows("calls", "variable", "function"), true);
  assert.equal(follows("calls", "file", "function"), false);
  assert.equal(follows("calls", "interface", "function"), false);
  assert.equal(follows("calls", "field", "function"), false);
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

test("an injection or template use between two classes or components is followed, from and into anything else it is not", () => {
  const relation = (kind: string, sourceKind: string, targetKind: string): boolean => followsRelation({ kind, sourceKind, targetKind });
  for (const kind of ["injects", "uses-component", "uses-directive", "uses-pipe"]) {
    assert.equal(relation(kind, "component", "class"), true, kind);
    assert.equal(relation(kind, "class", "component"), true, kind);
    assert.equal(relation(kind, "method", "class"), false, kind);
    assert.equal(relation(kind, "class", "interface"), false, kind);
    assert.equal(relation(kind, "class", "function"), false, kind);
  }
  assert.equal(relation("references", "class", "class"), false);
});
