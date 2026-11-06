import { edgeVerdict, type EdgeVerdict } from "../../domain/impact/edge-policy.ts";
import type { GraphSymbol } from "../../ports/code-graph.port.ts";
import type { ImportOrigins } from "../../ports/import-origins.port.ts";
import { edgeKey, type FollowedEdge } from "./inbound-edges.ts";

/**
 * What the edges the graph resolved really reach, read from the root of the name each spells at its position through
 * the source file's own bindings (`ImportOrigins.rootOrigins`). The one owner of that decision for every family that
 * reads graph edges as dependences.
 */
export interface EdgeTargets {
  /** One verdict per edge, in the order received; an edge the graph placed nowhere is kept. */
  verdictsOf(edges: readonly FollowedEdge[], signal?: AbortSignal): Promise<readonly EdgeVerdict<GraphSymbol>[]>;
}

const KEEP: EdgeVerdict<GraphSymbol> = { kind: "keep" };

export function createEdgeTargets(origins: ImportOrigins): EdgeTargets {
  const verdicts = new Map<string, EdgeVerdict<GraphSymbol>>();
  return {
    async verdictsOf(edges, signal) {
      const fresh = [...new Map(edges.filter(({ edge }) => edge.line !== null && edge.column !== null && !verdicts.has(edgeKey(edge))).map((followed) => [edgeKey(followed.edge), followed])).values()];
      if (fresh.length > 0) {
        const roots = await origins.rootOrigins(fresh.map(({ edge, source, target }) => ({ file: source.file, line: edge.line!, column: edge.column! + 1, kind: edge.kind, name: target.name })), signal);
        fresh.forEach(({ edge }, index) => {
          const root = roots[index];
          if (root !== undefined) verdicts.set(edgeKey(edge), edgeVerdict(root));
        });
      }
      return edges.map(({ edge }) => verdicts.get(edgeKey(edge)) ?? KEEP);
    },
  };
}
