import { canonicalJson } from "../../domain/shared/canonical-json.ts";
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
  const pending: { step: WalkedStep; owner: GraphNodeId; at: string; origins: PlacedCallSite["origins"]; bodies: ReadonlySet<GraphNodeId>; read: ReturnType<typeof effectOf> }[] = [];
  const knownBodies = new Map<string, Body[]>();
  const bodiesOf = (file: string): Body[] => {
    let bodies = knownBodies.get(file);
    if (bodies === undefined) {
      bodies = store.symbolsInFiles([file]).filter((symbol) => !NOT_DECLARED_KINDS.includes(symbol.kind)).map((symbol) => ({ symbol, ...declarationSpan(symbol) }));
      knownBodies.set(file, bodies);
    }
    return bodies;
  };
  const byFile = Map.groupBy((await sites()).filter(({ site }) => files.has(site.file)), ({ site }) => site.file);
  for (const [file, inFile] of byFile) {
    const bodies = bodiesOf(file);
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
      const reached = placed.origins === undefined ? undefined : expandedSteps(step.children.filter((child) => child.at?.line === site.line && child.at.column === placed.column! + 1));
      const producingBodies = new Set<GraphNodeId>();
      let proven = placed.origins === undefined || placed.origins.length > 0;
      for (const origin of placed.origins ?? []) {
        const sourceBodies = bodiesOf(origin.file);
        const body = owningBody(sourceBodies, origin);
        const ranges = await functionValuesOf(origin.file);
        if (body === undefined || !reached!.has(body.symbol.id) || !countedAlike(origin.column, lineOf(origin.file, origin.line) ?? "") || ranges === undefined || !executesInBody(body, ranges, origin)) {
          proven = false;
          break;
        }
        producingBodies.add(body.symbol.id);
      }
      if (!proven) {
        markCut(step, unplacedEffect(site), cuts);
        continue;
      }
      pending.push({ step, owner: owner.symbol.id, at: originKey({ file, ...at }), origins: placed.origins, bodies: producingBodies, read: effectOf(site) });
    }
  }
  const coveredBodies = new Set<GraphNodeId>();
  const coveredOrigins = new Set<string>();
  const retained = new Set<(typeof pending)[number]>();
  for (const item of pending.toSorted((a, b) => (b.origins?.length ?? 0) - (a.origins?.length ?? 0))) {
    const covered = item.origins === undefined ? coveredOrigins.has(item.at) : item.origins.every((origin) => coveredOrigins.has(originKey(origin)));
    if (coveredBodies.has(item.owner) && covered) continue;
    retained.add(item);
    if ("effect" in item.read) {
      for (const origin of item.origins ?? []) coveredOrigins.add(originKey(origin));
      for (const body of item.bodies) coveredBodies.add(body);
    }
  }
  for (const item of pending) {
    if (!retained.has(item)) continue;
    if ("effect" in item.read) {
      const effects = (item.step.effects ??= []);
      const effect = item.read.effect;
      if (!effects.some((existing) => canonicalJson(existing) === canonicalJson(effect))) effects.push(effect);
    } else markCut(item.step, item.read.cut, cuts);
  }
  return cuts;
}

function originKey(at: { file: string; line: number; column: number }): string {
  return JSON.stringify([at.file, at.line, at.column]);
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
  const visited = new Set<WalkedStep>();
  for (let step = pending.pop(); step !== undefined; step = pending.pop()) {
    if (visited.has(step)) continue;
    visited.add(step);
    if (step.expanded && !found.has(step.declaration.key as GraphNodeId)) found.set(step.declaration.key as GraphNodeId, step);
    pending.push(...step.children);
    if (step.seen !== undefined) pending.push(step.seen);
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
