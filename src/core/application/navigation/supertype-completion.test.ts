import { test } from "node:test";
import assert from "node:assert/strict";
import { EDGE_POLICY } from "../../domain/impact/edge-policy.ts";
import { CAPABILITY_ABSENT } from "../../domain/shared/fact.ts";
import type { GraphSymbol } from "../../ports/code-graph.port.ts";
import type { DeclaredSupertypes, ImportOrigins } from "../../ports/import-origins.port.ts";
import { fakeCodeGraph, fakeNode, type FakeEdge, type FakeUnresolved } from "./fake-code-graph.testing.ts";
import { SUPERTYPE_EDGES } from "./graph-navigation.ts";
import { completedHierarchy, unplacedReached } from "./supertype-completion.ts";

const NAMED = "src/NameRepo.java";
const NODES = [
  fakeNode("Repo", "interface", "src/Repo.java", 2, 4),
  fakeNode("Plain", "interface", "src/Plain.java", 2, 4),
  fakeNode("NameRepo", "class", NAMED, 3, 9),
  fakeNode("find", "method", NAMED, 6, 6),
  fakeNode("Sub", "class", "src/Sub.java", 2, 5),
  fakeNode("size", "method", "src/Sub.java", 3, 3),
  fakeNode("Other", "class", "src/Other.java", 2, 5),
  fakeNode("other", "method", "src/Other.java", 3, 3),
];
const EDGES: FakeEdge[] = [
  { from: "NameRepo", to: "find", kind: "contains" },
  { from: "NameRepo", to: "Plain", kind: "implements", line: 5, column: 30 },
  { from: "Sub", to: "size", kind: "contains" },
  { from: "Sub", to: "NameRepo", kind: "extends", line: 2, column: 25 },
  { from: "Other", to: "other", kind: "contains" },
];
const GENERIC: FakeUnresolved = { from: "NameRepo", name: "Repo<String>", kind: "implements", file: NAMED, line: 5, column: 15 };
const DECORATES: FakeUnresolved = { from: "NameRepo", name: "Deprecated", kind: "decorates", file: NAMED, line: 3, column: 0 };

function originsAnswering(answer: DeclaredSupertypes): { origins: ImportOrigins; asked: unknown[] } {
  const asked: unknown[] = [];
  const declaredSupertypes: ImportOrigins["declaredSupertypes"] = async (sites) => {
    asked.push(...sites);
    return sites.map(() => answer);
  };
  return { origins: { declaredSupertypes } as Partial<ImportOrigins> as ImportOrigins, asked };
}

const PLACED: DeclaredSupertypes = { kind: "supertypes", supertypes: [{ relation: "implements", written: "Repo", kind: "placed", name: "Repo", file: "src/Repo.java", start: 2, nameLine: 2 }] };

const ids = (symbols: readonly GraphSymbol[]): string[] => symbols.map(({ id }) => id);

test("a supertype the pack places is an edge at the reference's place, in the store's order, and the reference is no longer unresolved", async () => {
  const store = fakeCodeGraph(NODES, EDGES, [DECORATES, GENERIC]);
  const { reader } = await completedHierarchy(store, [NAMED], originsAnswering(PLACED).origins);

  assert.deepEqual(reader.outgoingEdges(["NameRepo" as never], SUPERTYPE_EDGES).map(({ target, column }) => [target, column]), [["Repo", 15], ["Plain", 30]]);
  assert.deepEqual(reader.incomingEdges(["Repo" as never]).map(({ source, kind, line }) => [source, kind, line]), [["NameRepo", "implements", 5]]);
  assert.deepEqual(reader.outgoingEdges(["NameRepo" as never], ["contains"]).map(({ target }) => target), ["find"]);
  assert.deepEqual(reader.unresolvedReferences([NAMED]).map(({ name }) => name), ["Deprecated"]);
});

test("a type whose pack declares the stage absent keeps the index as it is, with nothing unplaced", async () => {
  const store = fakeCodeGraph(NODES, EDGES, [GENERIC]);
  const completed = await completedHierarchy(store, [NAMED], originsAnswering({ kind: "unknown", reason: CAPABILITY_ABSENT }).origins);

  assert.equal(completed.reader, store);
  assert.deepEqual(completed.unplaced, []);
});

test("a supertype reference the index left unresolved without type arguments is asked of the pack and placed by the name it writes", async () => {
  const store = fakeCodeGraph(NODES, EDGES, [{ ...GENERIC, name: "shop.Repo" }]);
  const qualified: DeclaredSupertypes = { kind: "supertypes", supertypes: [{ ...PLACED.supertypes[0]!, written: "shop.Repo" }] };
  const { reader } = await completedHierarchy(store, [NAMED], originsAnswering(qualified).origins);

  assert.deepEqual(reader.outgoingEdges(["NameRepo" as never], ["implements"]).map(({ target }) => target), ["Repo", "Plain"]);
});

test("an unresolved reference of a kind other than a supertype's is the index's own reading, never asked of the pack", async () => {
  const store = fakeCodeGraph(NODES, EDGES, [DECORATES]);
  const { origins, asked } = originsAnswering(PLACED);
  const completed = await completedHierarchy(store, [NAMED], origins);

  assert.equal(completed.reader, store);
  assert.deepEqual(asked, []);
});

test("a supertype the pack does not place is unplaced for the answers reaching its type or a type below it, and only those", async () => {
  const store = fakeCodeGraph(NODES, EDGES, [GENERIC]);
  const completed = await completedHierarchy(store, [NAMED], originsAnswering({ kind: "supertypes", supertypes: [{ relation: "implements", written: "Repo", kind: "unknown" }] }).origins);
  const [find, size, other] = ["find", "size", "other"].map((id) => store.symbolsByIds([id as never])[0]!);

  assert.equal(completed.reader, store);
  assert.deepEqual(unplacedReached(completed, [find!]).map(({ type, reference }) => [type.id, reference.name]), [["NameRepo", "Repo<String>"]]);
  assert.deepEqual(ids(unplacedReached(completed, [size!]).map(({ type }) => type)), ["NameRepo"]);
  assert.deepEqual(unplacedReached(completed, [other!]), []);
});

const UNIT = "src/Unit.java";
const ENUM_NODES = [
  fakeNode("Unit", "enum", UNIT, 3, 11),
  fakeNode("ONE", "enum_member", UNIT, 4, 7),
  fakeNode("bodyArea", "method", UNIT, 5, 6, "area"),
  fakeNode("TWO", "enum_member", UNIT, 8, 8),
  fakeNode("area", "method", UNIT, 10, 10),
];
const ENUM_EDGES: FakeEdge[] = [
  { from: "Unit", to: "ONE", kind: "contains" },
  { from: "ONE", to: "bodyArea", kind: "contains" },
  { from: "Unit", to: "TWO", kind: "contains" },
  { from: "Unit", to: "area", kind: "contains" },
];
const EXTENDS_UNIT: DeclaredSupertypes = { kind: "supertypes", supertypes: [{ relation: "extends", written: "Unit", kind: "placed", name: "Unit", file: UNIT, start: 3, nameLine: 3 }] };

test("an enum member holding a declaration is asked of the pack, and one it places below a type reads as a type extending it at its own place", async () => {
  const store = fakeCodeGraph(ENUM_NODES, ENUM_EDGES);
  const { origins, asked } = originsAnswering(EXTENDS_UNIT);
  const { reader } = await completedHierarchy(store, [UNIT], origins);

  assert.deepEqual(asked, [{ file: UNIT, line: 4, name: "ONE" }]);
  assert.deepEqual(reader.outgoingEdges(["ONE" as never], SUPERTYPE_EDGES).map(({ target, kind, line, column }) => [target, kind, line, column]), [["Unit", "extends", 4, 1]]);
  assert.deepEqual(reader.symbolsInFiles([UNIT]).map(({ id, kind }) => [id, kind]), [["Unit", "enum"], ["ONE", EDGE_POLICY.bodiedMemberType], ["bodyArea", "method"], ["TWO", "enum_member"], ["area", "method"]]);
  assert.deepEqual(reader.symbolsByIds(["ONE" as never]).map(({ kind }) => kind), [EDGE_POLICY.bodiedMemberType]);
  assert.deepEqual(reader.declarationsNamed(["ONE"]).map(({ kind }) => kind), [EDGE_POLICY.bodiedMemberType]);
});

test("an enum member that holds nothing is never asked, and the reader is the index's own", async () => {
  const store = fakeCodeGraph(ENUM_NODES.filter(({ id }) => id !== "bodyArea"), ENUM_EDGES.filter(({ to }) => to !== "bodyArea"));
  const { origins, asked } = originsAnswering(EXTENDS_UNIT);
  const completed = await completedHierarchy(store, [UNIT], origins);

  assert.equal(completed.reader, store);
  assert.deepEqual(asked, []);
  assert.deepEqual(completed.unplaced, []);
});

test("an enum member holding a declaration that the pack does not place is unplaced for the answers reaching it, and a pack that declares the stage absent leaves it as it is", async () => {
  const store = fakeCodeGraph(ENUM_NODES, ENUM_EDGES);
  const unknown = await completedHierarchy(store, [UNIT], originsAnswering({ kind: "unknown" }).origins);
  const absent = await completedHierarchy(store, [UNIT], originsAnswering({ kind: "unknown", reason: CAPABILITY_ABSENT }).origins);
  const [bodyArea, area] = ["bodyArea", "area"].map((id) => store.symbolsByIds([id as never])[0]!);

  assert.equal(unknown.reader, store);
  assert.deepEqual(unplacedReached(unknown, [bodyArea!]).map(({ type, reference }) => [type.id, reference.file, reference.line, reference.name]), [["ONE", UNIT, 4, "ONE"]]);
  assert.deepEqual(unplacedReached(unknown, [area!]), []);
  assert.equal(absent.reader, store);
  assert.deepEqual(absent.unplaced, []);
});
