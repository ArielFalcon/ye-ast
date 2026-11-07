import type { GraphNodeId, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { SyntaxCall } from "../../ports/declared-member-names.port.ts";

/** Syntax ownership keeps calls on a shared line in their own body; anonymous callbacks belong to their encloser. */
export function callsByOwner(calls: readonly SyntaxCall[], declarations: readonly GraphSymbol[]): ReadonlyMap<GraphNodeId, readonly SyntaxCall[]> {
  const found = new Map<GraphNodeId, SyntaxCall[]>();
  for (const call of calls) {
    const owners = [...call.owners].reverse().map((place) => declarations.filter((symbol) => symbol.name === place.name && place.start <= symbol.startLine && symbol.startLine <= place.nameLine)).find((symbols) => symbols.length > 0);
    const fallback = owners === undefined ? declarations.filter((symbol) => ["function", "method", "class", "component", "property", "field", "constant", "variable"].includes(symbol.kind) && symbol.startLine <= call.line && call.line <= symbol.endLine).sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine)) : [];
    const accountable = owners ?? fallback.filter((symbol) => symbol.endLine - symbol.startLine === fallback[0]!.endLine - fallback[0]!.startLine);
    for (const owner of accountable) found.set(owner.id, [...found.get(owner.id) ?? [], call]);
  }
  return found;
}
