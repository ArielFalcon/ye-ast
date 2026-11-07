import { NOT_DECLARED_KINDS } from "../../domain/impact/importers-fact.ts";
import type { Cut } from "../../domain/shared/fact.ts";
import type { CallSite } from "../../domain/topology/call-site.ts";
import { effectOf, unplacedEffect } from "../../domain/trace/trace-effects.ts";
import type { WalkedStep } from "../../domain/trace/trace-tree.ts";
import type { CodeGraphReader, GraphNodeId, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { UnresolvedIn } from "../navigation/declaration-uses.ts";

/** Edges that state where a declaration sits or what it extends, never a call its body makes. */
const STRUCTURAL_KINDS: readonly string[] = ["contains", "extends", "implements"];

export interface TraceEffectsInput {
  store: CodeGraphReader;
  unresolvedIn: UnresolvedIn;
  /** The snapshot's call sites, read once by the caller. */
  sites: () => Promise<readonly CallSite[]>;
}

/**
 * Joins the call sites to the walked steps by place (R12): a site at a call the index records in an expanded body is an
 * effect of that step (the innermost such body), or a cut when the extraction does not resolve its target. A site the
 * innermost declaration around it, an expanded body, records no call at is a cut at the site, never dropped; a site in
 * a body the walk did not expand is no effect of this trace. Sets `effects` and `unsettled` on the steps and returns the cuts.
 */
export async function placeEffects(roots: readonly WalkedStep[], { store, unresolvedIn, sites }: TraceEffectsInput): Promise<Cut[]> {
  const expanded = expandedSteps(roots);
  if (expanded.size === 0) return [];
  const files = new Set([...expanded.values()].map((step) => step.declaration.file));
  const cuts: Cut[] = [];
  const byFile = Map.groupBy((await sites()).filter((site) => files.has(site.file)), (site) => site.file);
  for (const [file, inFile] of byFile) {
    const declarations = store.symbolsInFiles([file]).filter((symbol) => !NOT_DECLARED_KINDS.includes(symbol.kind));
    const bodies = declarations.filter((symbol) => expanded.has(symbol.id)).map((symbol) => ({ symbol, step: expanded.get(symbol.id)!, lines: callLines(store, unresolvedIn, symbol) }));
    for (const site of inFile) {
      const placed = innermost(bodies.filter(({ symbol, lines }) => contains(symbol, site.line) && lines.has(site.line)), ({ symbol }) => symbol);
      if (placed !== undefined) {
        const read = effectOf(site);
        if ("effect" in read) (placed.step.effects ??= []).push(read.effect);
        else markCut(placed.step, read.cut, cuts);
        continue;
      }
      const around = innermost(declarations.filter((symbol) => contains(symbol, site.line)), (symbol) => symbol);
      const owner = around === undefined ? undefined : expanded.get(around.id);
      if (owner !== undefined) markCut(owner, unplacedEffect(site), cuts);
    }
  }
  return cuts;
}

function markCut(step: WalkedStep, cut: Cut, cuts: Cut[]): void {
  step.unsettled = true;
  cuts.push(cut);
}

/** The occurrence that read each declaration's body, by its id. */
function expandedSteps(roots: readonly WalkedStep[]): Map<GraphNodeId, WalkedStep> {
  const found = new Map<GraphNodeId, WalkedStep>();
  const pending = [...roots];
  for (let step = pending.pop(); step !== undefined; step = pending.pop()) {
    if (step.expanded && !found.has(step.declaration.key as GraphNodeId)) found.set(step.declaration.key as GraphNodeId, step);
    pending.push(...step.children);
  }
  return found;
}

/** The lines at which the index records something the declaration's own body does: an edge leaving it or a reference it left unresolved. */
function callLines(store: CodeGraphReader, unresolvedIn: UnresolvedIn, symbol: GraphSymbol): ReadonlySet<number> {
  const lines = new Set<number>();
  for (const edge of store.outgoingEdges([symbol.id])) if (edge.line !== null && !STRUCTURAL_KINDS.includes(edge.kind)) lines.add(edge.line);
  for (const reference of unresolvedIn(symbol.file)) if (reference.from === symbol.id) lines.add(reference.line);
  return lines;
}

function contains(symbol: GraphSymbol, line: number): boolean {
  return symbol.startLine <= line && line <= symbol.endLine;
}

/** The narrowest span; of two equal spans, the one that starts later, so a nested declaration wins over its owner. */
function innermost<T>(items: readonly T[], symbolOf: (item: T) => GraphSymbol): T | undefined {
  return items.reduce<T | undefined>((best, item) => {
    if (best === undefined) return item;
    const [a, b] = [symbolOf(item), symbolOf(best)];
    const size = a.endLine - a.startLine - (b.endLine - b.startLine);
    return size < 0 || (size === 0 && a.startLine > b.startLine) ? item : best;
  }, undefined);
}
