import type { ImpactBudget } from "../../domain/impact/impact-fact.ts";
import { declarationAnchor } from "../../domain/impact/impact-cuts.ts";
import type { Cut } from "../../domain/shared/fact.ts";
import { comparePosition } from "../../domain/shared/code-node.ts";
import type { GraphNodeId, GraphSymbol } from "../../ports/code-graph.port.ts";
import type { InboundEdge, InboundEdges } from "./inbound-edges.ts";

export interface ReachedSymbol {
  symbol: GraphSymbol;
  depth: number;
  /** The strongest weakest edge over every path from a seed, 1 for a seed. */
  confidence: number;
  /** The callers that call or instantiate the symbol, which is what the hub bound counts. */
  fanIn: number;
  /** The symbol that first reached it, in position order, at the level before (or the method it stands for). */
  via?: GraphSymbol;
  /** Indexes into the seeds the walk started from. */
  seeds: readonly number[];
}

export interface Walk {
  reached: readonly ReachedSymbol[];
  cuts: readonly Cut[];
  /** The symbols whose callers the walk followed. */
  cost: { expansionsUsed: number };
}

interface Rec {
  symbol: GraphSymbol;
  depth: number;
  via?: GraphSymbol;
  /** Whether a changed contract can still flow down to the implementations. */
  contractChanged: boolean;
  fanIn: number;
  callers: readonly InboundEdge[];
}

interface Link {
  from: Rec;
  to: Rec;
  confidence: number;
}

/**
 * Inbound from the seeds, level by level in position order, each symbol expanded once, so the walk ends on any graph.
 * A reached method also reaches its type at its own level. The seeds are distinct symbols.
 */
export function walkImpact(seeds: readonly GraphSymbol[], inbound: InboundEdges, budget: ImpactBudget = {}): Walk {
  const recs = new Map<GraphNodeId, Rec>();
  const links: Link[] = [];
  let level: Rec[] = [];

  function enter(symbol: GraphSymbol, depth: number, via: GraphSymbol | undefined, contractChanged: boolean, into: Rec[]): Rec {
    const rec: Rec = { symbol, depth, ...(via === undefined ? {} : { via }), contractChanged, fanIn: 0, callers: [] };
    recs.set(symbol.id, rec);
    into.push(rec);
    return rec;
  }

  function enterOwners(rec: Rec, into: Rec[]): void {
    for (const owner of inbound.ownersOf(rec.symbol)) {
      const ownerRec = recs.get(owner.id) ?? enter(owner, rec.depth, rec.symbol, false, into);
      links.push({ from: rec, to: ownerRec, confidence: 1 });
    }
  }

  const seedRecs = seeds.map((seed) => enter(seed, 0, undefined, true, level));
  for (const rec of seedRecs) enterOwners(rec, level);

  const stopped = { depth: [] as Rec[], hub: [] as Rec[], expansions: [] as Rec[] };
  let expansions = 0;
  for (let depth = 0; level.length > 0; depth++) {
    const next: Rec[] = [];
    for (const rec of level.toSorted((a, b) => comparePosition(a.symbol, b.symbol))) {
      rec.callers = inbound.callersOf(rec.symbol, rec.contractChanged);
      rec.fanIn = rec.callers.filter((caller) => caller.callLike).length;
      if (budget.depth !== undefined && depth >= budget.depth) stopped.depth.push(rec);
      else if (budget.hubFanIn !== undefined && rec.fanIn > budget.hubFanIn) stopped.hub.push(rec);
      else if (budget.expansions !== undefined && expansions >= budget.expansions) stopped.expansions.push(rec);
      else {
        expansions += 1;
        for (const caller of rec.callers) {
          let target = recs.get(caller.from.id);
          if (target === undefined) {
            target = enter(caller.from, depth + 1, rec.symbol, false, next);
            enterOwners(target, next);
          }
          links.push({ from: rec, to: target, confidence: caller.confidence });
        }
      }
    }
    level = next;
  }

  const seedsOf = reachingSeeds(seedRecs, links);
  const confidence = widestPaths(seedRecs, links);
  const reached = [...recs.values()]
    .map((rec): ReachedSymbol => ({
      symbol: rec.symbol,
      depth: rec.depth,
      confidence: confidence.get(rec) ?? 0,
      fanIn: rec.fanIn,
      ...(rec.via === undefined ? {} : { via: rec.via }),
      seeds: [...(seedsOf.get(rec) ?? [])].sort((a, b) => a - b),
    }))
    .sort((a, b) => a.depth - b.depth || comparePosition(a.symbol, b.symbol));

  const unreached = (rec: Rec): boolean => rec.callers.some((caller) => !recs.has(caller.from.id));
  const cutAt = (kind: Cut["kind"], list: readonly Rec[], limit: number | undefined): Cut[] => {
    const anchors = [...new Set(list.filter(unreached).map((rec) => declarationAnchor(rec.symbol.file, rec.symbol.name)))].sort();
    return anchors.map((anchor): Cut => ({ kind, at: [anchor], limit: limit as number }));
  };
  return {
    reached,
    cuts: [...cutAt("depth", stopped.depth, budget.depth), ...cutAt("hub", stopped.hub, budget.hubFanIn), ...cutAt("caller-budget", stopped.expansions, budget.expansions)],
    cost: { expansionsUsed: expansions },
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
function widestPaths(seedRecs: readonly Rec[], links: readonly Link[]): Map<Rec, number> {
  const outgoing = Map.groupBy(links, (link) => link.from);
  const best = new Map<Rec, number>(seedRecs.map((rec) => [rec, 1]));
  const pending = [...new Set(seedRecs)];
  for (let rec = pending.shift(); rec !== undefined; rec = pending.shift()) {
    for (const link of outgoing.get(rec) ?? []) {
      const through = Math.min(best.get(rec)!, link.confidence);
      if (through > (best.get(link.to) ?? -1)) {
        best.set(link.to, through);
        pending.push(link.to);
      }
    }
  }
  return best;
}
