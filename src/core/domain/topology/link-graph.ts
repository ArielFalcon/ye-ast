import type { Handler } from "../entrypoints/http-route.ts";
import type { ReachedEntrypoint, Seed } from "../impact/impact-fact.ts";
import { compareText } from "../shared/code-node.ts";
import type { CallSite } from "./call-site.ts";
import { compareLink, type ImpactedLink, type Reach } from "./link.ts";
import type { JoinResult } from "./link-match.ts";

/** A call site and what the join made of it: the link it makes, or the drift or the cut it settles as. */
export interface JoinedSite {
  site: CallSite;
  joined: JoinResult;
}

/** The key two facts about one handler share. */
export function handlerKey(handler: Handler): string {
  return `${handler.path}\0${handler.symbol}\0${handler.line}`;
}

/** The key two facts about one call site share. */
export function callSiteKey(site: CallSite): string {
  return `${site.repo}\0${site.file}\0${site.line}\0${site.symbol}`;
}

/** The reach nearest the change: the shorter one, and of two of one length the first by id, so the answer never depends on order. */
function nearest(a: Reach, b: Reach): Reach {
  return compareReach(a, b) <= 0 ? a : b;
}

function compareReach(a: Reach, b: Reach): number {
  return a.length - b.length || compareText(a.join("\0"), b.join("\0"));
}

/** A call site a walk has not run for, and the reach of the link that feeds it. */
export interface PendingWalk {
  site: CallSite;
  reach: Reach;
}

/** The state of the fixpoint upstream: the links admitted, the handlers each repository reached, and the walks still to run. */
export interface LinkGraph {
  readonly links: ReadonlyMap<string, ImpactedLink>;
  /** Per repository, the handlers a walk reached, each with the nearest reach that got there. */
  readonly fed: ReadonlyMap<string, ReadonlyMap<string, Reach>>;
  /** Per repository, the call sites whose walk has not run, with the reach that feeds each. */
  readonly pending: ReadonlyMap<string, readonly PendingWalk[]>;
}

/** The graph a change starts: the handlers its own walk reached, the change itself as their reach. */
export function linkGraphOf(trigger: string, handlers: Iterable<string>): LinkGraph {
  const fed = new Map<string, Reach>([...handlers].map((key): [string, Reach] => [key, []]));
  return { links: new Map(), fed: new Map([[trigger, fed]]), pending: new Map() };
}

/**
 * The links the fixpoint admits next: those whose target a walk reached and that the answer does not hold yet, each with
 * the reach of the handler it lands in and its own id after it. A link whose target no walk reached is neither a link
 * nor drift, and the call site that makes it feeds no walk.
 */
export function admitUpstream(graph: LinkGraph, joined: readonly JoinedSite[]): LinkGraph {
  const links = new Map(graph.links);
  const pending = new Map(graph.pending);
  for (const { site, joined: settled } of joined) {
    const link = settled.link;
    if (link === undefined || links.has(link.id)) continue;
    const reached = graph.fed.get(link.to.repo)?.get(handlerKey(link.to.handler));
    if (reached === undefined) continue;
    const reach = [...reached, link.id];
    links.set(link.id, { link, direction: "upstream", reach });
    pending.set(link.from.repo, [...(pending.get(link.from.repo) ?? []), { site, reach }]);
  }
  return { links, fed: graph.fed, pending };
}

/**
 * What a walk from a batch of call sites reached, by handler: the call sites whose walk leads to it. A seed is the
 * declaration the walk was asked about, and a call site states the declaration it is written in, so the two join on
 * their file and simple name.
 */
export function reachedBy(seeds: readonly Seed[], entrypoints: readonly ReachedEntrypoint[], sites: readonly CallSite[]): Map<string, CallSite[]> {
  const byPlace = Map.groupBy(sites, (site) => `${site.file}\0${site.symbol}`);
  const reached = new Map<string, CallSite[]>();
  for (const entrypoint of entrypoints) {
    const leading = entrypoint.seeds.flatMap((index) => {
      const seed = seeds[index];
      return seed === undefined ? [] : (byPlace.get(`${seed.file}\0${seed.symbol}`) ?? []);
    });
    if (leading.length === 0) continue;
    const key = handlerKey(entrypoint.handler);
    reached.set(key, [...(reached.get(key) ?? []), ...leading]);
  }
  return reached;
}

/** The handlers a walk added, each with the nearest reach of the call sites that lead to it; the repository's walk has run. */
export function feedUpstream(graph: LinkGraph, repo: string, reached: ReadonlyMap<string, readonly CallSite[]>): LinkGraph {
  const reachOf = new Map((graph.pending.get(repo) ?? []).map(({ site, reach }) => [callSiteKey(site), reach]));
  const fed = new Map(graph.fed);
  const held = new Map(fed.get(repo) ?? []);
  for (const [key, sites] of reached) {
    const reach = sites.reduce<Reach | undefined>((best, site) => {
      const own = reachOf.get(callSiteKey(site));
      return own === undefined ? best : best === undefined ? own : nearest(best, own);
    }, undefined);
    if (reach === undefined) continue;
    const known = held.get(key);
    held.set(key, known === undefined ? reach : nearest(known, reach));
  }
  fed.set(repo, held);
  const pending = new Map(graph.pending);
  pending.delete(repo);
  return { links: graph.links, fed, pending };
}

/** The state of the fixpoint downstream: the links admitted, and the handlers each repository was fed. */
export interface DownstreamGraph {
  readonly links: ReadonlyMap<string, ImpactedLink>;
  /** Per repository, the handlers a downstream link landed in, each with the nearest reach that got there. */
  readonly fed: ReadonlyMap<string, ReadonlyMap<string, Reach>>;
}

export function downstreamGraph(): DownstreamGraph {
  return { links: new Map(), fed: new Map() };
}

/**
 * The links a change sends onward: those whose call site a fed handler reaches and that the answer does not hold yet,
 * each with that handler's reach and its own id after it. The handler the link lands in is fed for the next join.
 */
export function admitDownstream(graph: DownstreamGraph, joined: readonly JoinedSite[], egress: ReadonlyMap<string, ReadonlyMap<string, Reach>>): DownstreamGraph {
  const links = new Map(graph.links);
  const fed = new Map(graph.fed);
  for (const { site, joined: settled } of joined) {
    const link = settled.link;
    if (link === undefined || links.has(link.id)) continue;
    const sent = egress.get(site.repo)?.get(callSiteKey(site));
    if (sent === undefined) continue;
    const reach = [...sent, link.id];
    links.set(link.id, { link, direction: "downstream", reach });
    const key = handlerKey(link.to.handler);
    const held = fed.get(link.to.repo) ?? new Map<string, Reach>();
    const known = held.get(key);
    fed.set(link.to.repo, new Map(held).set(key, known === undefined ? reach : nearest(known, reach)));
  }
  return { links, fed };
}

/** The call sites inside the symbols a change touched, the change itself as the reach that sends each onward. */
export function changeEgress(trigger: string, seeds: readonly Seed[], sites: readonly CallSite[]): Map<string, Reach> {
  return new Map(
    sites
      .filter((site) => site.repo === trigger && seeds.some((seed) => seed.file === site.file && seed.symbol === site.symbol))
      .map((site) => [callSiteKey(site), [] as Reach]),
  );
}

/** The call sites a repository's fed handlers send onward, each with the nearest reach of a fed handler its walk reaches. */
export function egressReach(reached: ReadonlyMap<string, readonly CallSite[]>, fed: ReadonlyMap<string, Reach>): Map<string, Reach> {
  const egress = new Map<string, Reach>();
  for (const [key, sites] of reached) {
    const reach = fed.get(key);
    if (reach === undefined) continue;
    for (const site of sites) {
      const known = egress.get(callSiteKey(site));
      egress.set(callSiteKey(site), known === undefined ? reach : nearest(known, reach));
    }
  }
  return egress;
}

/** The call sites a repository sends onward, kept with the nearest reach when a walk and the change both send one. */
export function mergeEgress(egress: Map<string, Map<string, Reach>>, repo: string, added: ReadonlyMap<string, Reach>): void {
  const held = new Map(egress.get(repo) ?? []);
  for (const [key, reach] of added) {
    const known = held.get(key);
    held.set(key, known === undefined ? reach : nearest(known, reach));
  }
  egress.set(repo, held);
}

/** The answer's links: one per id, the nearest reach, and upstream when both directions reach it as near. */
export function mergeLinks(...graphs: readonly { links: ReadonlyMap<string, ImpactedLink> }[]): ImpactedLink[] {
  const merged = new Map<string, ImpactedLink>();
  for (const { links } of graphs) {
    for (const [id, link] of links) {
      const held = merged.get(id);
      merged.set(id, held === undefined ? link : nearer(held, link));
    }
  }
  return [...merged.values()].sort(compareLink);
}

function nearer(a: ImpactedLink, b: ImpactedLink): ImpactedLink {
  const byReach = compareReach(a.reach, b.reach);
  if (byReach !== 0) return byReach < 0 ? a : b;
  return a.direction === "upstream" ? a : b;
}
