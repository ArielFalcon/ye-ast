import type { ConsumerCaller, ConsumerCallers, ConsumerMemberOccurrences } from "../../ports/consumer-sources.port.ts";
import type { CodeGraphReader } from "../../ports/code-graph.port.ts";
import type { InboundOccurrence, InboundOccurrences } from "../impact/inbound-edges.ts";

/**
 * The places the function declared at `line` of `file` is depended on, as the impact families see them: the graph's
 * edges with the calls made through injected fields and locals, one occurrence each. A dependence that is not a call the
 * graph resolved (a reference, a dispatch, a receiver a provider may replace, a guessed edge) stays in the answer, unproven.
 */
export function callersOfFunction(store: CodeGraphReader | undefined, inbound: InboundOccurrences | undefined, declaration: { file: string; symbol: string; line: number }): ConsumerCallers {
  if (store === undefined || inbound === undefined) return { kind: "unavailable" };
  const symbol = store
    .symbolsInFiles([declaration.file])
    .filter((candidate) => candidate.name === declaration.symbol && candidate.startLine <= declaration.line && declaration.line <= candidate.endLine)
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
  if (symbol === undefined) return { kind: "unresolved" };
  return { kind: "found", callers: inbound.occurrencesOf(symbol).map(callerOf) };
}

export function occurrencesOfMember(): ConsumerMemberOccurrences {
  return { kind: "unavailable" };
}

function callerOf(occurrence: InboundOccurrence): ConsumerCaller {
  const kind = occurrence.basis === "call" ? "call" : occurrence.basis === "reference" ? "reference" : "other";
  const provenance = occurrence.provenance === "heuristic" ? "heuristic" : "resolved";
  return {
    file: occurrence.from.file,
    line: occurrence.from.startLine,
    ...(occurrence.line === undefined ? {} : { at: occurrence.line }),
    ...(occurrence.resource === undefined ? {} : { resource: occurrence.resource }),
    kind,
    provenance,
    confidence: occurrence.confidence,
    proven: kind === "call" && provenance === "resolved" && occurrence.bridge === undefined && occurrence.substitutes === undefined,
  };
}
