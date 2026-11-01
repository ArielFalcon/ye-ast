import type { Entrypoint } from "../entrypoints/entrypoint.ts";
import { compareText, joinsFact, type CodeNode } from "../shared/code-node.ts";
import type { Finding } from "../shared/fact.ts";
import { handlerOf } from "./changed-entrypoints.ts";
import type { ReachedEntrypoint } from "./impact-fact.ts";

export interface ReachedNode extends CodeNode {
  depth: number;
  confidence: number;
  seeds: readonly number[];
}

/**
 * The entrypoints the change reaches: those whose handler is a reached node, joined by the one join of facts to the
 * graph, and, for an entrypoint the extractor could not read whole, the innermost reached declaration at each location
 * it names. An entrypoint is reported once: at the shallowest depth, the strongest confidence and every seed of the
 * nodes that serve it.
 */
export function reachedEntrypoints(findings: readonly Finding<Entrypoint>[], reached: readonly ReachedNode[]): ReachedEntrypoint[] {
  const found = new Map<string, ReachedEntrypoint>();
  const add = (entry: ReachedEntrypoint): void => {
    const key = JSON.stringify([entry.kind, entry.name, entry.handler.path, entry.handler.symbol, entry.handler.line]);
    const held = found.get(key);
    found.set(key, held === undefined ? entry : merge(held, entry));
  };
  for (const finding of findings) {
    if (finding.status === "complete") {
      const handler = handlerOf(finding.value);
      if (handler === undefined) continue;
      for (const node of reached.filter((candidate) => joinsFact(candidate, { path: handler.path, line: handler.line, symbol: handler.symbol }))) {
        add({ kind: finding.value.kind, name: finding.value.name, handler, depth: node.depth, confidence: node.confidence, seeds: node.seeds });
      }
    } else {
      for (const place of finding.evidence) {
        const holding = reached.filter((candidate) => joinsFact(candidate, { path: place.path, line: place.line }));
        const innermost = holding.toSorted((a, b) => span(a) - span(b))[0];
        if (innermost !== undefined) add({ kind: "unknown", handler: { path: innermost.file, symbol: innermost.name, line: innermost.startLine }, depth: innermost.depth, confidence: innermost.confidence, seeds: innermost.seeds });
      }
    }
  }
  return [...found.values()].sort(compareEntries);
}

function span(node: CodeNode): number {
  return node.endLine - node.startLine;
}

function merge(a: ReachedEntrypoint, b: ReachedEntrypoint): ReachedEntrypoint {
  return { ...a, depth: Math.min(a.depth, b.depth), confidence: Math.max(a.confidence, b.confidence), seeds: [...new Set([...a.seeds, ...b.seeds])].sort((x, y) => x - y) };
}

function compareEntries(a: ReachedEntrypoint, b: ReachedEntrypoint): number {
  return compareText(a.kind, b.kind) || compareText(a.name ?? "", b.name ?? "") || compareText(a.handler.path, b.handler.path) || compareText(a.handler.symbol, b.handler.symbol) || a.handler.line - b.handler.line;
}
