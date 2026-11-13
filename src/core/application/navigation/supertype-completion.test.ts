import { test } from "node:test";
import assert from "node:assert/strict";
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
