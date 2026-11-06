import { NOT_DECLARED_KINDS } from "../../domain/impact/importers-fact.ts";
import { declarationTree, type DeclarationBranch } from "../../domain/shared/declaration-tree.ts";
import type { CodeGraphReader, GraphSymbol } from "../../ports/code-graph.port.ts";

const CONTAINMENT = "contains";

/** The containment tree of one file's declarations, from the graph's `contains` edges between them. */
export function containmentTree(store: CodeGraphReader, nodes: readonly GraphSymbol[]): DeclarationBranch<GraphSymbol>[] {
  const declared = nodes.filter((node) => !NOT_DECLARED_KINDS.includes(node.kind));
  return declarationTree(declared, store.outgoingEdges(declared.map((node) => node.id), [CONTAINMENT]));
}
