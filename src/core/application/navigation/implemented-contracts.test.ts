import { test } from "node:test";
import assert from "node:assert/strict";
import type { CodeGraphReader } from "../../ports/code-graph.port.ts";
import type { ImplementedDeclarations, ImportOrigins } from "../../ports/import-origins.port.ts";
import { fakeCodeGraph, fakeNode, type FakeEdge, type FakeNode } from "./fake-code-graph.testing.ts";
import { createGraphNavigation, SUPERTYPE_EDGES } from "./graph-navigation.ts";
import { implementedContractsOf } from "./implemented-contracts.ts";

const ASKED: ImplementedDeclarations = { kind: "unknown" };
const origins = { implementedDeclarations: async (sites: readonly unknown[]) => sites.map(() => ASKED) } as unknown as ImportOrigins;

function methodsOf(owner: string, file: string, count: number): { nodes: FakeNode[]; edges: FakeEdge[] } {
  const methods = Array.from({ length: count }, (_, index) => `${owner}.m${index}`);
  return {
    nodes: methods.map((id, index) => fakeNode(id, "method", file, index + 2, index + 2, `m${index}`)),
    edges: methods.map((id) => ({ from: owner, to: id, kind: "contains" })),
  };
}

test("only the methods of a class with a repository supertype are asked, and its supertype chain is read once for the class, not once per method", async () => {
  const size = 40;
  const withSuper = methodsOf("A", "src/A.java", size);
  const without = methodsOf("C", "src/C.java", 3);
  const nodes = [fakeNode("A", "class", "src/A.java", 1, size + 2), fakeNode("B", "interface", "src/B.java", 1), fakeNode("C", "class", "src/C.java", 1, 5), ...withSuper.nodes, ...without.nodes];
  const edges: FakeEdge[] = [{ from: "A", to: "B", kind: "implements" }, ...withSuper.edges, ...without.edges];
  const graph = fakeCodeGraph(nodes, edges);
  let supertypeReads = 0;
  const store: CodeGraphReader = { ...graph, outgoingEdges: (sources, kinds) => (kinds === SUPERTYPE_EDGES && supertypeReads++, graph.outgoingEdges(sources, kinds)) };
  const answers = await implementedContractsOf(store, ["src/A.java", "src/C.java"], createGraphNavigation(store, () => false), origins);
  assert.deepEqual([...answers.keys()].sort(), withSuper.nodes.map(({ id }) => id).sort());
  assert.ok(supertypeReads <= 3, `read the supertypes ${supertypeReads} times for 2 classes of 43 methods`);
});
