import { callPlaceOf, compareCallPlaces, type CallSite, type EventTarget } from "../../domain/topology/call-site.ts";
import type { JoinedSite } from "../../domain/topology/link-graph.ts";
import type { Link, UnlinkedCallSite } from "../../domain/topology/link.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { inferGateways, matchEventCallSite, matchHttpCallSite, type Gateway, type GatewayDeclaration, type JoinResult, type RepositoryEntrypoints } from "../../domain/topology/link-match.ts";
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
 * ladder of RFC-0011 under the gateways in force, against every repository's routes: one its own repository serves is
 * internal, never a link across repositories nor drift. A call site whose target its snapshot does not decide joins
 * nothing, unless the snapshot states its path and only its base is undecided (ADR-0054); one that settles nothing stays
 * out of the join.
 */
export function joinWorkspace(repositories: readonly WorkspaceRepository[], entrypoints: readonly RepositoryEntrypoints[], declared: readonly GatewayDeclaration[]): WorkspaceJoin {
  const gateways = inferGateways(repositories.flatMap((repository) => repository.callSites), entrypoints, declared);
  const joined: JoinedSite[] = [];
  for (const repository of repositories) {
    for (const site of repository.callSites) {
      const event = eventTargetOf(site);
      if (event !== undefined) {
        joined.push({ site, joined: matchEventCallSite(site, event, entrypoints) });
        continue;
      }
      const answer = site.transport === "http" ? matchHttpCallSite(site, entrypoints, gateways) : undefined;
      if (answer !== undefined) joined.push({ site, joined: acrossRepositories(site, answer) });
    }
  }
  return { gateways, joined };
}

function acrossRepositories(site: CallSite, joined: JoinResult): JoinResult {
  return joined.links !== undefined && joined.links.every((link) => link.to.repo === site.repo) ? { internal: true } : joined;
}

function eventTargetOf(site: CallSite): EventTarget | undefined {
  return site.transport === "event" && site.target.status === "complete" && "protocol" in site.target.value ? site.target.value : undefined;
}

export function declaredGateways(gateways: readonly Gateway[]): GatewayDeclaration[] {
  return gateways.flatMap(({ prefix, repo, basis }) => (basis === "gateway-prefix" ? [{ prefix, repo }] : []));
}

/** What a join admitted, once per `Link.id` and sorted by id, and the call sites it reached and could not settle, sorted by place. */
export function linkMapOf(joined: readonly JoinedSite[]): { links: Link[]; unlinked: UnlinkedCallSite[] } {
  const links = new Map<string, Link>();
  const unlinked: UnlinkedCallSite[] = [];
  for (const { site, joined: answer } of joined) {
    const from = callPlaceOf(site);
    for (const link of answer.links ?? []) links.set(link.id, link);
    if (answer.ambiguous !== undefined) unlinked.push({ from, transport: site.transport, outcome: "ambiguous", name: answer.ambiguous.key, repos: answer.ambiguous.repos, ...(answer.ambiguous.routes === undefined ? {} : { routes: answer.ambiguous.routes }) });
    else if (answer.undecided !== undefined) unlinked.push({ from, transport: site.transport, outcome: "could-match", name: answer.undecided });
    else if (answer.unmatched !== undefined) unlinked.push({ from, transport: site.transport, outcome: "unmatched", name: answer.unmatched });
  }
  return {
    links: [...links.values()].sort((a, b) => compareText(a.id, b.id)),
    unlinked: unlinked.sort((a, b) => compareCallPlaces(a.from, b.from) || compareText(a.name, b.name)),
  };
}
