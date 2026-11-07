import { NOT_DECLARED_KINDS } from "../../domain/impact/importers-fact.ts";
import type { Cut } from "../../domain/shared/fact.ts";
import type { PlacedCallSite } from "../../domain/topology/call-site.ts";
import { effectOf, unplacedEffect } from "../../domain/trace/trace-effects.ts";
import { declarationSpan, executesInBody, owningBody, type SourceSpan } from "../../domain/trace/owning-body.ts";
import type { WalkedStep } from "../../domain/trace/trace-tree.ts";
import type { CodeGraphReader, GraphNodeId, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { UnresolvedIn } from "../navigation/declaration-uses.ts";

/** Edges that state where a declaration sits or what it extends, never a call its body makes. */
const STRUCTURAL_KINDS: readonly string[] = ["contains", "extends", "implements"];

const NOT_ASCII = /[^\x00-\x7F]/;

export interface TraceEffectsInput {
  store: CodeGraphReader;
  unresolvedIn: UnresolvedIn;
  /** The snapshot's call sites with their places. */
  sites: () => Promise<readonly PlacedCallSite[]>;
  /** A line of a source as the snapshot holds it; undefined when the snapshot does not hold the file. */
  lineOf: (file: string, line: number) => string | undefined;
  /** The function values a source's syntax states, each whole; undefined when the snapshot does not hold the source. */
  functionValuesOf: (file: string) => Promise<readonly SourceSpan[] | undefined>;
}

type Body = SourceSpan & { symbol: GraphSymbol };

/**
 * Joins the call sites to the walked steps (R12). A site belongs to the declaration of the index that owns its exact
 * place (`owningBody`); it is an effect of a step only when that declaration is the body the step expanded and the index
 * records a call of that body on the site's line (or the site is the client method the declaration states), and a cut
 * when the extraction does not decide its target. A site in the expanded body that the index records no call at is a cut
 * at the site, never dropped; a site another declaration owns (a nested function the walk did not expand, a sibling on
 * the same line) is not this step's, and one inside a function value the index declares no body for is a cut, since
 * the walk proves no run of such a value. Where the place cannot be told (no column, or a line on which parsers may count
 * columns apart), a site that some expanded body may own is a cut, never an effect. Sets `effects` and `unsettled` on the
 * steps and returns the cuts.
 */
export async function placeEffects(roots: readonly WalkedStep[], { store, unresolvedIn, sites, lineOf, functionValuesOf }: TraceEffectsInput): Promise<Cut[]> {
  const expanded = expandedSteps(roots);
  if (expanded.size === 0) return [];
  const files = new Set([...expanded.values()].map((step) => step.declaration.file));
  const cuts: Cut[] = [];
  const byFile = Map.groupBy((await sites()).filter(({ site }) => files.has(site.file)), ({ site }) => site.file);
  for (const [file, inFile] of byFile) {
    const bodies: Body[] = store.symbolsInFiles([file]).filter((symbol) => !NOT_DECLARED_KINDS.includes(symbol.kind)).map((symbol) => ({ symbol, ...declarationSpan(symbol) }));
    const values = await functionValuesOf(file);
    const lines = new Map<GraphNodeId, ReadonlySet<number>>();
    const callLinesOf = (symbol: GraphSymbol) => lines.get(symbol.id) ?? lines.set(symbol.id, callLines(store, unresolvedIn, symbol)).get(symbol.id)!;
    for (const placed of inFile) {
      const { site } = placed;
      const told = placed.column !== undefined && countedAlike(placed.column, lineOf(file, site.line) ?? "");
      if (!told) {
        const around = owningBody(bodies.filter(({ symbol }) => expanded.has(symbol.id)).map((body) => ({ ...body, start: { line: body.start.line, column: 0 }, end: { line: body.end.line + 1, column: 0 } })), { line: site.line, column: 0 });
        if (around !== undefined) markCut(expanded.get(around.symbol.id)!, unplacedEffect(site), cuts);
        continue;
      }
      const at = { line: site.line, column: placed.column! };
      const owner = owningBody(bodies, at);
      const step = owner === undefined ? undefined : expanded.get(owner.symbol.id);
      if (owner === undefined || step === undefined) continue;
      if (placed.declaration !== true && (!callLinesOf(owner.symbol).has(site.line) || (values === undefined || !executesInBody(owner, values, at)))) {
        markCut(step, unplacedEffect(site), cuts);
        continue;
      }
      const read = effectOf(site);
      if ("effect" in read) (step.effects ??= []).push({ ...read.effect, column: placed.column! + 1 });
      else markCut(step, read.cut, cuts);
    }
  }
  return cuts;
}

/**
 * Whether the site lies before its line's first character outside ASCII. Up to there the parser that placed the site and
 * the one that placed the declarations count alike, and past it both only count further, so comparing the site with any
 * declaration boundary on the line gives the same answer in either count.
 */
function countedAlike(column: number, text: string): boolean {
  const first = NOT_ASCII.exec(text)?.index;
  return first === undefined || column <= first;
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
