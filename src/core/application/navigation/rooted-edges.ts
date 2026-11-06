import { edgeVerdict } from "../../domain/impact/edge-policy.ts";
import type { ImportOrigin } from "../../domain/relations/resolved-reference.ts";
import type { GraphEdge, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { ImportOrigins } from "../../ports/import-origins.port.ts";

/** A graph edge with both of its ends. */
export interface EdgeWithEnds {
  edge: GraphEdge;
  source: GraphSymbol;
  target: GraphSymbol;
}

/**
 * The edges whose spelled name a package or the language's libraries bind at the place the index wrote them, each with
 * that origin: the index matched the name to a repository declaration it is only spelled like, so neither impact nor
 * trace follows such an edge. An edge without a place, or one whose root the origins cannot read, is kept.
 */
export async function edgesRootedOutside<T extends EdgeWithEnds>(origins: ImportOrigins, edges: readonly T[], signal?: AbortSignal): Promise<{ edge: T; origin: ImportOrigin }[]> {
  const placed = edges.filter(({ edge }) => edge.line !== null && edge.column !== null);
  if (placed.length === 0) return [];
  const roots = await origins.rootOrigins(placed.map(({ edge, source, target }) => ({ file: source.file, line: edge.line!, column: edge.column! + 1, kind: edge.kind, name: target.name })), signal);
  return placed.flatMap((edge, index) => {
    const root = roots[index];
    return root !== undefined && root.status === "complete" && root.value.kind !== "local-parameter" && edgeVerdict(root).kind === "drop" ? [{ edge, origin: root.value }] : [];
  });
}
