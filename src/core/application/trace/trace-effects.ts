import { countedAlike } from "../../domain/shared/call-place.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import { NOT_DECLARED_KINDS } from "../../domain/impact/importers-fact.ts";
import type { Cut } from "../../domain/shared/fact.ts";
import type { PlacedDataEffect } from "../../domain/trace/data-effect-site.ts";
import { gatherUnresolvedCallSites, type PlacedCallSite } from "../../domain/topology/call-site.ts";
import { cutOfPlaced, effectOf, unplacedEffect } from "../../domain/trace/trace-effects.ts";
import { declarationSpan, executionIn, owningBody, type SourceSpan } from "../../domain/shared/owning-body.ts";
import type { WalkedStep } from "../../domain/trace/trace-tree.ts";
import type { CodeGraphReader, GraphSymbol } from "../../ports/code-graph.port.ts";
import { indexedDeclaration, type DeclarationModel, type ModelDeclaration } from "../navigation/declaration-model.ts";
import type { ReconciledCalls } from "../navigation/reconciled-calls.ts";
import type { BodyCalls } from "../navigation/reconciled-calls.ts";

export interface TraceEffectsInput {
  store: CodeGraphReader;
  declarations?: DeclarationModel;
  ownedIn?: ReconciledCalls["ownedIn"];
  /** What each body calls, the index's records and the written calls aligned (B9). */
  callsOf: (body: GraphSymbol) => Promise<BodyCalls>;
  /** The snapshot's call sites with their places. */
  sites: () => Promise<readonly (PlacedCallSite | PlacedDataEffect)[]>;
  /** A line of a source as the snapshot holds it; undefined when the snapshot does not hold the file. */
  lineOf: (file: string, line: number) => string | undefined;
  /** The function values a source's syntax states, each whole; undefined when the snapshot does not hold the source. */
  functionValuesOf: (file: string) => Promise<readonly SourceSpan[] | undefined>;
  /** The function values of a source that a listed combinator takes and runs later, if at all. */
  deferredValuesOf?: (file: string) => Promise<readonly SourceSpan[]>;
}

type Body = SourceSpan & { symbol: GraphSymbol | ModelDeclaration };

/**
 * Joins the call sites to the walked steps (R12). A site belongs to the declaration of the index that owns its exact
 * place (`owningBody`); it is an effect of a step only when that declaration is the body the step expanded and B9 places
 * a call that body runs on the site's line (or the site is the client method the declaration states), and a cut
 * when the extraction does not decide its target. A site in the expanded body that B9 places no call at is a cut
 * at the site, never dropped; a site another declaration owns (a nested function the walk did not expand, a sibling on
 * the same line) is not this step's, and one inside a function value the index declares no body for is a cut, since
 * the walk proves no run of such a value, unless a registered combinator takes it: then the site is an effect of the
 * declaration around it, marked `deferred`. Where the place cannot be told (no column, or a line on which parsers may count
 * columns apart), a site that some expanded body may own is a cut, never an effect. Sets `effects` and `unsettled` on the
 * steps and returns the cuts.
 */
export async function placeEffects(roots: readonly WalkedStep[], { store, declarations, ownedIn, callsOf, sites, lineOf, functionValuesOf, deferredValuesOf }: TraceEffectsInput): Promise<Cut[]> {
  const expanded = expandedSteps(roots);
  if (expanded.size === 0) return [];
  const files = new Set([...expanded.values()].map((step) => step.declaration.file));
  const cuts: Cut[] = [];
  const pending: { step: WalkedStep; owner: string; at: string; column: number; origins: PlacedCallSite["origins"]; bodies: ReadonlySet<string>; read: ReturnType<typeof effectOf>; deferred: boolean }[] = [];
  const knownBodies = new Map<string, Promise<Body[]>>();
  const bodiesOf = (file: string): Promise<Body[]> => {
    let bodies = knownBodies.get(file);
    if (bodies === undefined) {
      bodies = (async () => {
        const nodes = declarations === undefined ? store.symbolsInFiles([file]).filter(({ kind }) => !NOT_DECLARED_KINDS.includes(kind)) :
          (await declarations.list(file)).filter((node) => node.kind !== "object").map((node) => node.symbol ?? node);
        return nodes.map((symbol) => ({ symbol, ...declarationSpan(symbol) }));
      })();
      knownBodies.set(file, bodies);
    }
    return bodies;
  };
  const placedSites = await sites();
  const byFile = Map.groupBy(placedSites.filter(({ site }) => files.has(site.file)), ({ site }) => site.file);
  for (const [file, inFile] of byFile) {
    const bodies = await bodiesOf(file);
    const values = await functionValuesOf(file);
    const deferredHere = await deferredValuesOf?.(file) ?? [];
    const lines = new Map<string, Promise<ReadonlySet<number>>>();
    const callLinesOf = (node: GraphSymbol | ModelDeclaration): Promise<ReadonlySet<number>> => {
      let read = lines.get(node.id);
      if (read === undefined) {
        const indexed = indexedDeclaration(node);
        read = indexed === undefined ? (async () => new Set(((await ownedIn?.(node.file))?.get(node.id) ?? []).filter((call) => !call.deferred && !call.ambiguous).map(({ line }) => line)))() : callLines(callsOf, indexed);
        lines.set(node.id, read);
      }
      return read;
    };
    for (const placed of inFile) {
      const { site } = placed;
      const told = placed.column !== undefined && countedAlike(placed.column, lineOf(file, site.line) ?? "");
      if (!told) {
        const around = owningBody(bodies.filter(({ symbol }) => expanded.has(symbol.id)).map((body) => ({ ...body, start: { line: body.start.line, column: 0 }, end: { line: body.end.line + 1, column: 0 } })), { line: site.line, column: 0 });
        if (around !== undefined) markCut(expanded.get(around.symbol.id)!, cutOfPlaced(placed, site), cuts);
        continue;
      }
      const at = { line: site.line, column: placed.column! };
      const owner = owningBody(bodies, at);
      const step = owner === undefined ? undefined : expanded.get(owner.symbol.id);
      if (owner === undefined || step === undefined) continue;
      const declared = "declaration" in placed && placed.declaration === true;
      const execution = values === undefined ? "unproven" : executionIn(owner, values, deferredHere, at);
      if (!declared && (execution === "unproven" || !(await callLinesOf(owner.symbol)).has(site.line))) {
        markCut(step, cutOfPlaced(placed, site), cuts);
        continue;
      }
      let deferred = !declared && execution === "deferred";
      const origins = "origins" in placed ? placed.origins : undefined;
      const reached = origins === undefined ? undefined : expandedSteps(step.children.filter((child) => child.at?.line === site.line && child.at.column === placed.column! + 1));
      const producingBodies = new Set<string>();
      let proven = origins === undefined || origins.length > 0;
      for (const origin of origins ?? []) {
        const sourceBodies = await bodiesOf(origin.file);
        const body = owningBody(sourceBodies, origin);
        const ranges = await functionValuesOf(origin.file);
        const originExecution = body === undefined || ranges === undefined ? "unproven" : executionIn(body, ranges, await deferredValuesOf?.(origin.file) ?? [], origin);
        if (body === undefined || !reached!.has(body.symbol.id) || !countedAlike(origin.column, lineOf(origin.file, origin.line) ?? "") || originExecution === "unproven") {
          proven = false;
          break;
        }
        deferred ||= originExecution === "deferred";
        producingBodies.add(body.symbol.id);
      }
      if (!proven) {
        markCut(step, cutOfPlaced(placed, site), cuts);
        continue;
      }
      pending.push({ step, owner: owner.symbol.id, at: originKey({ file, ...at }), column: placed.column! + 1, origins, bodies: producingBodies, read: effectOf(site), deferred });
    }
  }
  const coveredBodies = new Set<string>();
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
      coveredOrigins.add(item.at);
      const effects = (item.step.effects ??= []);
      const effect = { ...item.read.effect, column: item.column, ...(item.deferred ? { deferred: true as const } : {}) };
      if (!effects.some((existing) => canonicalJson(existing) === canonicalJson(effect))) effects.push(effect);
    } else {
      markCut(item.step, item.read.cut, cuts);
      const request = item.read.request;
      if (request !== undefined) {
        const placed = { ...request, column: item.column, ...(item.deferred ? { deferred: true as const } : {}) };
        item.step.unresolvedEffects = gatherUnresolvedCallSites([...(item.step.unresolvedEffects ?? []), placed]);
      }
    }
  }
  for (const placed of placedSites) {
    for (const origin of ("origins" in placed ? placed.origins : undefined) ?? []) {
      if (origin.kind !== "leaf" || coveredOrigins.has(originKey(origin))) continue;
      const owner = owningBody(await bodiesOf(origin.file), origin);
      const step = owner === undefined ? undefined : expanded.get(owner.symbol.id);
      if (step === undefined || owner === undefined) continue;
      const values = await functionValuesOf(origin.file);
      if (!countedAlike(origin.column, lineOf(origin.file, origin.line) ?? "") || values === undefined || executionIn(owner, values, [], origin) !== "runs") continue;
      markCut(step, unplacedEffect({ ...placed.site, file: origin.file, line: origin.line }), cuts);
      coveredOrigins.add(originKey(origin));
    }
  }
  return cuts;
}

function originKey(at: { file: string; line: number; column: number }): string {
  return JSON.stringify([at.file, at.line, at.column]);
}

function markCut(step: WalkedStep, cut: Cut, cuts: Cut[]): void {
  step.unsettled = true;
  cuts.push(cut);
}

/** The occurrence that read each declaration's body, by its id. */
function expandedSteps(roots: readonly WalkedStep[]): Map<string, WalkedStep> {
  const found = new Map<string, WalkedStep>();
  const pending = [...roots];
  const visited = new Set<WalkedStep>();
  for (let step = pending.pop(); step !== undefined; step = pending.pop()) {
    if (visited.has(step)) continue;
    visited.add(step);
    if (step.expanded && !found.has(step.declaration.key)) found.set(step.declaration.key, step);
    pending.push(...step.children);
    if (step.seen !== undefined) pending.push(step.seen);
  }
  return found;
}

/** The lines of the calls the declaration's own body runs: the index's call records B9 keeps there and the calls it writes that no record matches. */
async function callLines(callsOf: (body: GraphSymbol) => Promise<BodyCalls>, symbol: GraphSymbol): Promise<ReadonlySet<number>> {
  const { edges, references, writtenOnly } = await callsOf(symbol);
  return new Set([...edges.flatMap(({ edge }) => (edge.line === null ? [] : [edge.line])), ...references.map(({ line }) => line), ...writtenOnly.map(({ line }) => line)]);
}
