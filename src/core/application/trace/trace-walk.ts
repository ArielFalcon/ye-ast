import { CALL_EDGE_KINDS, isIgnoredEdge } from "../../domain/impact/edge-policy.ts";
import { declarationAnchor, placeAt, referenceKey } from "../../domain/impact/impact-cuts.ts";
import { NOT_DECLARED_KINDS, sortedUnique } from "../../domain/impact/importers-fact.ts";
import type { Cut } from "../../domain/shared/fact.ts";
import { calleeOf, compareOccurrence, ownMemberOf, sameOccurrence, type EdgeOccurrence, type OrderedPlace } from "../../domain/trace/call-place.ts";
import type { TraceVia } from "../../domain/trace/trace-fact.ts";
import type { ExternalCall, TraceDeclaration, WalkedStep } from "../../domain/trace/trace-tree.ts";
import type { CodeGraphReader, GraphNodeId, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import type { ImportOriginSite, ImportOrigins } from "../../ports/import-origins.port.ts";
import type { TraceBudget } from "../../ports/trace-queries.port.ts";
import { createGraphNavigation } from "../navigation/graph-navigation.ts";

/** What a body passes as a value runs later, if at all; only code can. */
const DEFERRED_KINDS: readonly string[] = ["function", "method"];

/** Kinds that name a type and never a value, so a call through a member of that name cannot reach them. */
const TYPE_ONLY_KINDS: readonly string[] = ["interface", "type_alias"];

export interface TraceWalkInput {
  store: CodeGraphReader;
  origins: ImportOrigins;
  /** Whether a path is inside the declared scope: a declaration outside it cannot make a call repository code. */
  inScope: (path: string) => boolean;
  budget: TraceBudget;
  signal?: AbortSignal;
}

export interface TraceWalk {
  /** One per root, in the order given. */
  roots: readonly WalkedStep[];
  cuts: readonly Cut[];
  expanded: number;
}

interface Child {
  symbol: GraphSymbol;
  place: OrderedPlace;
  via: TraceVia;
  deferred?: true;
}

interface Body {
  children: Child[];
  external: ExternalCall[];
  cuts: Cut[];
}

/**
 * Outbound from the roots in one depth-first pre-order traversal, which alone decides depth, the expansions charge, cuts
 * and `seen`: a declaration is expanded at its first occurrence within the bounds, and an occurrence a bound stops is a
 * cut that leaves it free to expand at a later, shallower one. Every read is cached for this walk only.
 */
export async function walkTrace(roots: readonly GraphSymbol[], input: TraceWalkInput): Promise<TraceWalk | "aborted"> {
  const { store, origins, inScope, budget, signal } = input;
  const navigation = createGraphNavigation(store, () => false);

  const referencesByFile = new Map<string, ReadonlyMap<GraphNodeId, readonly GraphUnresolvedReference[]>>();
  const callsFrom = (node: GraphSymbol): readonly GraphUnresolvedReference[] => {
    let byNode = referencesByFile.get(node.file);
    if (byNode === undefined) {
      byNode = Map.groupBy(store.unresolvedReferences([node.file]).filter((reference) => CALL_EDGE_KINDS.includes(reference.kind)), (reference) => reference.from);
      referencesByFile.set(node.file, byNode);
    }
    const found = byNode.get(node.id) ?? [];
    return [...new Map(found.map((reference) => [referenceKey(reference) ?? reference, reference])).values()];
  };

  const namedCache = new Map<string, readonly GraphSymbol[]>();
  const declarationsNamed = (name: string): readonly GraphSymbol[] => {
    let named = namedCache.get(name);
    if (named === undefined) {
      named = store.declarationsNamed([name]).filter((symbol) => inScope(symbol.file) && !NOT_DECLARED_KINDS.includes(symbol.kind));
      namedCache.set(name, named);
    }
    return named;
  };

  /** What `x.<name>` can run: any declaration of that name a value can be, so only type-only kinds leave it out. */
  const membersNamed = (name: string): readonly GraphSymbol[] => declarationsNamed(name).filter((symbol) => !TYPE_ONLY_KINDS.includes(symbol.kind));

  const anchorOf = (symbol: GraphSymbol): string => declarationAnchor(symbol.file, symbol.name);
  /**
   * The place reads `<path>:<line> <spelling>`: the path is repository-relative and the line digits, so the first
   * `:<digits>` followed by a space ends the path, whatever spaces the path or the spelling hold; only a path that
   * itself holds `:<digits> ` reads differently.
   */
  const unresolvedAt = (reference: GraphUnresolvedReference, declarations: readonly GraphSymbol[]): Cut => ({
    kind: "unresolved-link",
    at: [placeAt(reference.file, reference.line, reference.name), ...sortedUnique([...reference.candidates, ...declarations.map(anchorOf)])],
  });
  const childAt = (symbol: GraphSymbol, line: number | null, column: number | null, spelling: string, via: TraceVia, deferred?: true): Child => ({
    symbol,
    place: { line, column, spelling, target: symbol.id },
    via,
    ...(deferred === undefined ? {} : { deferred }),
  });

  async function bodyOf(node: GraphSymbol): Promise<Body> {
    const calls = store.outgoingEdges([node.id], CALL_EDGE_KINDS).filter((edge) => !isIgnoredEdge(edge));
    const values = store.outgoingEdges([node.id], ["references"]);
    navigation.load([...calls, ...values].map((edge) => edge.target));
    const children: Child[] = [];
    const resolved: EdgeOccurrence[] = [];
    for (const edge of calls) {
      const target = navigation.symbolOf(edge.target);
      if (target === undefined) continue;
      resolved.push({ source: edge.source, line: edge.line, column: edge.column, targetName: target.name });
      children.push(childAt(target, edge.line, edge.column, target.name, "call"));
    }
    for (const edge of values) {
      const target = navigation.symbolOf(edge.target);
      if (target !== undefined && DEFERRED_KINDS.includes(target.kind)) children.push(childAt(target, edge.line, edge.column, target.name, "reference", true));
    }

    const external: ExternalCall[] = [];
    const cuts: Cut[] = [];
    const bare: { reference: GraphUnresolvedReference; name: string }[] = [];
    for (const reference of callsFrom(node).filter((candidate) => !resolved.some((edge) => sameOccurrence(edge, candidate)))) {
      const own = ownMemberOf(reference.name);
      const members = own === undefined ? [] : [...new Map(navigation.ownersOf(node).flatMap((owner) => navigation.methodsOf(owner)).filter((method) => method.name === own).map((method) => [method.id, method])).values()];
      if (members.length === 1) children.push(childAt(members[0]!, reference.line, reference.column, reference.name, "own-member"));
      else if (members.length > 1) cuts.push(unresolvedAt(reference, members));
      else {
        const callee = calleeOf(reference.name);
        if (callee.form === "computed") cuts.push(unresolvedAt(reference, []));
        else if (callee.form === "bare") bare.push({ reference, name: callee.name });
        else {
          const named = membersNamed(callee.name);
          if (named.length === 0) external.push({ kind: "unnamed", name: reference.name });
          else cuts.push(unresolvedAt(reference, named));
        }
      }
    }
    if (bare.length > 0) {
      const sites = bare.map(({ reference, name }): ImportOriginSite => ({ file: reference.file, line: reference.line, column: reference.column + 1, name, fullName: reference.name, kind: reference.kind }));
      const findings = await origins.origins(sites, signal);
      for (const [index, { reference, name }] of bare.entries()) {
        const finding = findings[index];
        const origin = finding?.status === "complete" && finding.occurrence === true ? finding.value : undefined;
        if (origin?.kind === "external") external.push({ kind: "import", module: origin.module, name: reference.name });
        else if (origin?.kind === "ambient") external.push({ kind: "global", name: reference.name });
        else cuts.push(unresolvedAt(reference, declarationsNamed(name)));
      }
    }
    return { children: children.sort((a, b) => compareOccurrence(a.place, b.place)), external, cuts };
  }

  const expandedAt = new Map<GraphNodeId, WalkedStep>();
  const stopped = { depth: new Set<string>(), expansions: new Set<string>() };
  const cuts: Cut[] = [];
  let expansions = 0;

  async function visit(step: WalkedStep, symbol: GraphSymbol, depth: number): Promise<void> {
    if (signal?.aborted) return;
    const first = expandedAt.get(symbol.id);
    if (first !== undefined) {
      step.seen = first;
      return;
    }
    if (budget.depth !== undefined && depth >= budget.depth) {
      stopped.depth.add(anchorOf(symbol));
      return;
    }
    if (budget.expansions !== undefined && expansions >= budget.expansions) {
      stopped.expansions.add(anchorOf(symbol));
      return;
    }
    expansions += 1;
    expandedAt.set(symbol.id, step);
    step.expanded = true;
    const body = await bodyOf(symbol);
    step.external = body.external;
    step.unsettled = body.cuts.length > 0;
    cuts.push(...body.cuts);
    for (const child of body.children) {
      const { line, column } = child.place;
      const walked = stepOf(child.symbol, {
        ...(line === null ? {} : { at: { line, ...(column === null ? {} : { column: column + 1 }) } }),
        via: child.via,
        ...(child.deferred === undefined ? {} : { deferred: child.deferred }),
      });
      step.children.push(walked);
      await visit(walked, child.symbol, depth + 1);
    }
  }

  const walked: WalkedStep[] = [];
  for (const root of roots) {
    const step = stepOf(root, {});
    walked.push(step);
    await visit(step, root, 0);
  }
  if (signal?.aborted) return "aborted";
  const boundCuts = (kind: Cut["kind"], anchors: ReadonlySet<string>, limit: number | undefined): Cut[] => [...anchors].sort().map((anchor): Cut => ({ kind, at: [anchor], limit: limit as number }));
  return {
    roots: walked,
    cuts: [...cuts, ...boundCuts("depth", stopped.depth, budget.depth), ...boundCuts("caller-budget", stopped.expansions, budget.expansions)],
    expanded: expansions,
  };
}

function declarationOf(symbol: GraphSymbol): TraceDeclaration {
  return { key: symbol.id, file: symbol.file, symbol: symbol.name, kind: symbol.kind, start: symbol.startLine, end: symbol.endLine };
}

function stepOf(symbol: GraphSymbol, occurrence: Pick<WalkedStep, "at" | "via" | "deferred">): WalkedStep {
  return { declaration: declarationOf(symbol), ...occurrence, expanded: false, unsettled: false, children: [], external: [] };
}
