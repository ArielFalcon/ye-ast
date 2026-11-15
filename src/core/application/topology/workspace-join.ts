import { callPlaceOf, compareCallPlaces, distinctPlaces, httpTargetOf, type CallSite, type EventTarget, type PropagatedPlace } from "../../domain/topology/call-site.ts";
import type { JoinedSite } from "../../domain/topology/link-graph.ts";
import { isInternalLink, type Link, type UnlinkedCallSite } from "../../domain/topology/link.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import { inferGateways, inferHosts, matchEventCallSite, matchHttpCallSite, type Gateway, type GatewayDeclaration, type RepositoryEntrypoints } from "../../domain/topology/link-match.ts";
import type { WorkspaceRepository } from "../../ports/workspace-repos.port.ts";

/** Every call site of a workspace joined once against the entrypoints of the other repositories read. */
export interface WorkspaceJoin {
  /** The gateways in force: those declared, and those inferred from the overlap of calls and routes. */
  gateways: Gateway[];
  /** Each call site whose target its snapshot decides, with what the join answered, in repository then reading order. */
  joined: JoinedSite[];
}

/** A repository's entrypoints as the join reads them: the complete findings only. */
export function entrypointsOf(repository: WorkspaceRepository): RepositoryEntrypoints {
  return { repo: repository.repo, entrypoints: repository.entrypoints.flatMap((finding) => (finding.status === "complete" ? [finding.value] : [])) };
}

/**
 * The one join of a workspace: a published message against the listeners its protocol delivers to, an HTTP call by the
 * ladder of RFC-0011 under the gateways in force, against every repository's routes. A link whose ends share a repository
 * is kept and classified internal by `linkMapOf`, never drift (ADR-0076 decision 4). A call site whose target its snapshot does not decide joins
 * nothing, unless the snapshot states its path and only its base is undecided (ADR-0054); one that settles nothing stays
 * out of the join.
 */
export function joinWorkspace(repositories: readonly WorkspaceRepository[], entrypoints: readonly RepositoryEntrypoints[], declared: readonly GatewayDeclaration[]): WorkspaceJoin {
  const calls = repositories.flatMap((repository) => repository.callSites);
  const gateways = inferGateways(calls, entrypoints, declared);
  const hosts = inferHosts(calls, entrypoints, gateways);
  const joined: JoinedSite[] = [];
  for (const repository of repositories) {
    for (const site of repository.callSites) {
      const event = eventTargetOf(site);
      if (event !== undefined) {
        joined.push({ site, joined: matchEventCallSite(site, event, entrypoints) });
        continue;
      }
      const answer = site.transport === "http" ? matchHttpCallSite(site, entrypoints, gateways, hosts) : undefined;
      if (answer !== undefined) joined.push({ site, joined: answer });
    }
  }
  return { gateways, joined };
}

function eventTargetOf(site: CallSite): EventTarget | undefined {
  return site.transport === "event" && site.target.status === "complete" && "protocol" in site.target.value ? site.target.value : undefined;
}

export function declaredGateways(gateways: readonly Gateway[]): GatewayDeclaration[] {
  return gateways.flatMap(({ prefix, repo, basis }) => (basis === "gateway-prefix" ? [{ prefix, repo }] : []));
}

/**
 * What a join admitted, once per `Link.id` and sorted by id, the links across repositories apart from those inside one,
 * and the call sites it reached and could not settle, once per call and outcome and sorted by place: a call reached through
 * several callers gathers the bodies of all, as its link would.
 */
export function linkMapOf(joined: readonly JoinedSite[]): { links: Link[]; internalLinks: Link[]; unlinked: UnlinkedCallSite[] } {
  const links = new Map<string, Link>();
  const unlinked = new Map<string, UnlinkedCallSite>();
  const leave = (item: UnlinkedCallSite): void => {
    const { propagatedThrough, ...identity } = item;
    const key = canonicalJson(identity);
    const known = unlinked.get(key)?.propagatedThrough;
    unlinked.set(key, propagatedThrough === undefined && known === undefined ? item : { ...item, propagatedThrough: distinctPlaces([...(known ?? []), ...(propagatedThrough ?? [])]) });
  };
  for (const { site, joined: answer } of joined) {
    const from = callPlaceOf(site);
    const through = site.propagatedThrough === undefined ? {} : { propagatedThrough: site.propagatedThrough };
    const method = site.transport === "http" ? (httpTargetOf(site)?.method ?? site.stated?.method) : undefined;
    const stated = method === undefined ? {} : { method };
    for (const link of answer.links ?? []) {
      const known = links.get(link.id)?.propagatedThrough;
      links.set(link.id, site.propagatedThrough === undefined && known === undefined ? link : { ...link, propagatedThrough: distinctPlaces([...(known ?? []), ...(site.propagatedThrough ?? [])]) });
    }
    if (answer.ambiguous !== undefined) leave({ from, transport: site.transport, ...stated, outcome: "ambiguous", name: answer.ambiguous.key, repos: answer.ambiguous.repos, ...(answer.ambiguous.routes === undefined ? {} : { routes: answer.ambiguous.routes }), ...through });
    else if (answer.undecided !== undefined) leave({ from, transport: site.transport, ...stated, outcome: "could-match", name: answer.undecided, ...through });
    else if (answer.unmatched !== undefined) leave({ from, transport: site.transport, ...stated, outcome: "unmatched", name: answer.unmatched, ...through });
  }
  const admitted = [...links.values()].sort((a, b) => compareText(a.id, b.id));
  return {
    links: admitted.filter((link) => !isInternalLink(link)),
    internalLinks: admitted.filter(isInternalLink),
    unlinked: [...unlinked.values()].sort((a, b) => compareCallPlaces(a.from, b.from) || compareText(a.name, b.name)),
  };
}
