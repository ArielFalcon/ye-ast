import type { DependenceBasis, DependenceDerivation, ImpactBudget } from "../../domain/impact/impact-fact.ts";
import { isFileDependent } from "../../domain/impact/edge-policy.ts";
import { declarationAnchor } from "../../domain/impact/impact-cuts.ts";
import { boundCut, type Cut, type WalkBoundKind } from "../../domain/shared/fact.ts";
import { comparePosition } from "../../domain/shared/code-node.ts";
import type { MemberSubstitute } from "../../domain/relations/member-use.ts";
import type { GraphNodeId, GraphSymbol } from "../../ports/code-graph.port.ts";
import { indexedDeclaration, type ModelDeclaration } from "../navigation/declaration-model.ts";
import type { InboundEdge, InboundEdges } from "./inbound-edges.ts";

/** The dependence that reached a symbol: the symbol it came through, and where this one depends on it. */
export interface Via {
  symbol: GraphSymbol | ModelDeclaration;
  /** The places in the reached symbol's own file, or in `resource`, where it depends on `symbol`, in line order; empty when the store places none. */
  lines: readonly number[];
  /** The file `lines` are in when it is not the reached symbol's own: the template of a component. */
  resource?: string;
  /** What the dependence is. */
  basis: DependenceBasis;
  /** Who established it. */
  derivation: DependenceDerivation;
  /** The classes a provider may inject instead of the receiver a proven call names. */
  substitutes?: readonly MemberSubstitute[];
}

export interface ReachedSymbol {
  symbol: GraphSymbol | ModelDeclaration;
  depth: number;
  /** The strongest weakest edge over every path from a seed, 1 for a seed. */
  confidence: number;
  /** The callers that call or instantiate the symbol, which is what the hub bound counts. */
  fanIn: number;
  /** The predecessor on the admitted path that establishes confidence; shortest depth is independent. */
  via?: Via;
  /** Indexes into the seeds the walk started from. */
  seeds: readonly number[];
}

export interface Walk {
  reached: readonly ReachedSymbol[];
  /** Declarations reached directly, rather than only as owners of reached members. */
  wholeDeclarations: ReadonlySet<GraphNodeId>;
  /** IDs whose expansion was admitted by all walk bounds. */
  expanded: ReadonlySet<GraphNodeId>;
  cuts: readonly Cut[];
  /** The symbols whose callers the walk followed. */
  cost: { expansionsUsed: number };
}

interface Rec {
  symbol: GraphSymbol | ModelDeclaration;
  depth: number;
  /** Whether a changed contract can still flow down to the implementations. */
  contractChanged: boolean;
  /** True while only a member it declares has reached it: the type then follows only whole-type rows (ADR-0017). */
  throughMember: boolean;
  /** The level its own edge reached it at, after a member had: from that level on it follows every row. */
  wholeFrom?: number;
  fanIn: number;
  callers: readonly InboundEdge[];
}

interface Link {
  from: Rec;
  to: Rec;
  confidence: number;
  via: Via;
}

function placeOn(symbol: GraphSymbol | ModelDeclaration, dependence: InboundEdge): Via {
  return { symbol, lines: dependence.lines, ...(dependence.resource === undefined ? {} : { resource: dependence.resource }), basis: dependence.basis, derivation: dependence.derivation, ...(dependence.substitutes === undefined ? {} : { substitutes: dependence.substitutes }) };
}

/**
 * Inbound from the seeds, level by level in position order, each symbol expanded once, so the walk ends on any graph.
 * A reached method also reaches its type at its own level, and that type is expanded once more, for the rows a member
 * does not open, at the level its own edge reaches it at. A file a top-level use names is reached and not expanded
 * (ADR-0082). The seeds are distinct symbols.
 */
export function walkImpact(seeds: readonly GraphSymbol[], inbound: InboundEdges, budget: ImpactBudget = {}, syntax?: { seeds: readonly ModelDeclaration[]; callers: ReadonlyMap<string, readonly InboundEdge[]> }): Walk {
  const recs = new Map<string, Rec>();
  const links: Link[] = [];
  let level: Rec[] = [];

  function enter(symbol: GraphSymbol | ModelDeclaration, depth: number, contractChanged: boolean, into: Rec[], throughMember = false): Rec {
    const rec: Rec = { symbol, depth, contractChanged, throughMember, fanIn: 0, callers: [] };
    recs.set(symbol.id, rec);
    into.push(rec);
    return rec;
  }

  function enterOwners(rec: Rec, into: Rec[]): void {
    const indexed = indexedDeclaration(rec.symbol);
    for (const owner of indexed === undefined ? [] : inbound.ownersOf(indexed)) {
      const ownerRec = recs.get(owner.id) ?? enter(owner, rec.depth, false, into, true);
      links.push({ from: rec, to: ownerRec, confidence: 1, via: { symbol: rec.symbol, lines: [], basis: "contains", derivation: "resolved" } });
    }
  }

  const seedRecs = [...seeds, ...syntax?.seeds ?? []].map((seed) => enter(seed, 0, true, level));
  for (const rec of seedRecs) enterOwners(rec, level);

  const stopped = { depth: [] as Rec[], hub: [] as Rec[], expansions: [] as Rec[] };
  const spent = new Set<Rec>();
  const expanded = new Set<GraphNodeId>();
  for (let depth = 0; level.length > 0; depth++) {
    const next: Rec[] = [];
    /** The current level, plus every symbol a dispatch bridge puts there: a hop between an interface and its implementation costs no depth. */
    const queue = level.toSorted((a, b) => comparePosition(a.symbol, b.symbol));
    const handled = new Set<Rec>();
    for (let index = 0; index < queue.length; index++) {
      const rec = queue[index]!;
      if (handled.has(rec)) continue;
      handled.add(rec);
      if (isFileDependent(rec.symbol.kind)) continue;
      const indexed = indexedDeclaration(rec.symbol);
      const membersOnly = rec.wholeFrom === undefined ? rec.throughMember : depth < rec.wholeFrom;
      rec.callers = indexed === undefined ? syntax?.callers.get(rec.symbol.id) ?? [] : inbound.callersOf(indexed, rec.contractChanged, membersOnly);
      rec.fanIn = rec.callers.filter((caller) => caller.hasCall ?? caller.basis === "call").length;
      if (budget.depth !== undefined && depth >= budget.depth) stopped.depth.push(rec);
      else if (budget.hubFanIn !== undefined && rec.fanIn > budget.hubFanIn) stopped.hub.push(rec);
      else if (budget.expansions !== undefined && !spent.has(rec) && spent.size >= budget.expansions) stopped.expansions.push(rec);
      else {
        spent.add(rec);
        if (indexed !== undefined) expanded.add(indexed.id);
        for (const caller of rec.callers) {
          const free = caller.bridge !== undefined;
          const into = free ? queue : next;
          let target = recs.get(caller.from.id);
          if (target === undefined) {
            target = enter(caller.from, free ? depth : depth + 1, false, into);
            enterOwners(target, into);
          } else if (target.throughMember) {
            target.throughMember = false;
            target.wholeFrom = depth + 1;
            next.push(target);
          }
          links.push({ from: rec, to: target, confidence: caller.confidence, via: placeOn(rec.symbol, caller) });
        }
      }
    }
    level = next;
  }

  const seedsOf = reachingSeeds(seedRecs, links);
  const confidence = widestPaths(seedRecs, links);
  const reached = [...recs.values()]
    .map((rec): ReachedSymbol => {
      const witness = confidence.get(rec);
      return {
        symbol: rec.symbol,
        depth: rec.depth,
        confidence: witness?.confidence ?? 0,
        fanIn: rec.fanIn,
        ...(witness?.via === undefined ? {} : { via: witness.via }),
        seeds: [...(seedsOf.get(rec) ?? [])].sort((a, b) => a - b),
      };
    })
    .sort((a, b) => a.depth - b.depth || comparePosition(a.symbol, b.symbol));

  const unreached = (rec: Rec): boolean => rec.callers.some((caller) => !recs.has(caller.from.id));
  const cutAt = (kind: WalkBoundKind, list: readonly Rec[], limit: number | undefined): Cut[] => {
    const anchors = [...new Set(list.filter(unreached).map((rec) => declarationAnchor(rec.symbol.file, rec.symbol.name)))].sort();
    return anchors.map((anchor) => boundCut(kind, anchor, limit as number));
  };
  return {
    reached,
    wholeDeclarations: new Set([...recs.values()].filter((rec) => !rec.throughMember).flatMap((rec) => indexedDeclaration(rec.symbol)?.id ?? [])),
    expanded,
    cuts: [...cutAt("depth", stopped.depth, budget.depth), ...cutAt("hub", stopped.hub, budget.hubFanIn), ...cutAt("caller-budget", stopped.expansions, budget.expansions)],
    cost: { expansionsUsed: spent.size },
  };
}

function reachingSeeds(seedRecs: readonly Rec[], links: readonly Link[]): Map<Rec, Set<number>> {
  const outgoing = Map.groupBy(links, (link) => link.from);
  const held = new Map<Rec, Set<number>>(seedRecs.map((rec, index) => [rec, new Set([index])]));
  const pending = [...new Set(seedRecs)];
  for (let rec = pending.shift(); rec !== undefined; rec = pending.shift()) {
    const carried = held.get(rec)!;
    for (const link of outgoing.get(rec) ?? []) {
      const target = held.get(link.to) ?? new Set<number>();
      held.set(link.to, target);
      const before = target.size;
      for (const seed of carried) target.add(seed);
      if (target.size > before) pending.push(link.to);
    }
  }
  return held;
}

/** The strongest weakest edge from any seed to each symbol: a path is as sure as its least sure edge. */
function widestPaths(seedRecs: readonly Rec[], links: readonly Link[]): Map<Rec, { confidence: number; via?: Via }> {
  const outgoing = Map.groupBy(links, (link) => link.from);
  const best = new Map<Rec, { confidence: number; via?: Via }>(seedRecs.map((rec) => [rec, { confidence: 1 }]));
  const pending = [...new Set(seedRecs)].sort((a, b) => comparePosition(a.symbol, b.symbol));
  for (let rec = pending.shift(); rec !== undefined; rec = pending.shift()) {
    for (const link of outgoing.get(rec) ?? []) {
      const through = Math.min(best.get(rec)!.confidence, link.confidence);
      if (through > (best.get(link.to)?.confidence ?? -1)) {
        best.set(link.to, { confidence: through, via: link.via });
        pending.push(link.to);
      }
    }
  }
  return best;
}
