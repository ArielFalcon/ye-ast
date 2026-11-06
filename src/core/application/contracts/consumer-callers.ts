import { EDGE_POLICY } from "../../domain/impact/edge-policy.ts";
import type { ConsumerCallers } from "../../ports/consumer-sources.port.ts";
import type { CodeGraphReader } from "../../ports/code-graph.port.ts";
import type { InboundEdges } from "../impact/inbound-edges.ts";

/**
 * The callers of the function declared at `line` of `file`, as the impact families see them: the graph's edges with the
 * calls made through injected fields and locals. A dependence that is not a call the graph resolved (a reference, a
 * dispatch, a receiver a provider may replace, an edge scored no higher than an unscored heuristic one) stays in the answer, unproven.
 */
export function callersOfFunction(store: CodeGraphReader | undefined, inbound: InboundEdges | undefined, declaration: { file: string; symbol: string; line: number }): ConsumerCallers {
  if (store === undefined || inbound === undefined) return { kind: "unavailable" };
  const symbol = store
    .symbolsInFiles([declaration.file])
    .filter((candidate) => candidate.name === declaration.symbol && candidate.startLine <= declaration.line && declaration.line <= candidate.endLine)
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
  if (symbol === undefined) return { kind: "unresolved" };
  return {
    kind: "found",
    callers: inbound.callersOf(symbol, false).map((edge) => ({
      file: edge.from.file,
      line: edge.from.startLine,
      lines: edge.lines,
      ...(edge.resource === undefined ? {} : { resource: edge.resource }),
      proven: edge.basis === "call" && edge.confidence > EDGE_POLICY.unscoredHeuristicConfidence && edge.bridge === undefined && edge.substitutes === undefined,
    })),
  };
}
