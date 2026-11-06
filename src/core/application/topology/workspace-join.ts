import type { CallSite, EventTarget, HttpTarget } from "../../domain/topology/call-site.ts";
import type { JoinedSite } from "../../domain/topology/link-graph.ts";
import type { Link, UnlinkedCallSite } from "../../domain/topology/link.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { inferGateways, matchCallSite, matchEventCallSite, type Gateway, type GatewayDeclaration, type RepositoryEntrypoints } from "../../domain/topology/link-match.ts";
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
 * The one join of a workspace: a published message against the listeners of the other repositories, an HTTP call by the
 * ladder of RFC-0011 under the gateways in force. A call site whose target its snapshot does not decide joins nothing.
 */
export function joinWorkspace(repositories: readonly WorkspaceRepository[], entrypoints: readonly RepositoryEntrypoints[], declared: readonly GatewayDeclaration[]): WorkspaceJoin {
  const gateways = inferGateways(repositories.flatMap((repository) => repository.callSites), entrypoints, declared);
  const joined: JoinedSite[] = [];
  for (const repository of repositories) {
    const others = entrypoints.filter((candidate) => candidate.repo !== repository.repo);
    for (const site of repository.callSites) {
      const event = eventTargetOf(site);
      if (event !== undefined) {
        joined.push({ site, joined: matchEventCallSite(site, event, others) });
        continue;
      }
      const target = httpTargetOf(site);
      if (target !== undefined) joined.push({ site, joined: matchCallSite(site, target, others, gateways) });
    }
  }
  return { gateways, joined };
}

function httpTargetOf(site: CallSite): HttpTarget | undefined {
  return site.transport === "http" && site.target.status === "complete" && "path" in site.target.value ? site.target.value : undefined;
}

function eventTargetOf(site: CallSite): EventTarget | undefined {
  return site.transport === "event" && site.target.status === "complete" && "protocol" in site.target.value ? site.target.value : undefined;
}

export function declaredGateways(gateways: readonly Gateway[]): GatewayDeclaration[] {
  return gateways.flatMap(({ prefix, repo, basis }) => (basis === "gateway-prefix" ? [{ prefix, repo }] : []));
}

/** What a join admitted, once per `Link.id` and sorted by id, and the call sites it reached without a link, sorted by place. */
export function linkMapOf(joined: readonly JoinedSite[]): { links: Link[]; unlinked: UnlinkedCallSite[] } {
  const links = new Map<string, Link>();
  const unlinked: UnlinkedCallSite[] = [];
  for (const { site, joined: answer } of joined) {
    const from = { repo: site.repo, file: site.file, line: site.line, symbol: site.symbol };
    if (answer.link !== undefined) links.set(answer.link.id, answer.link);
    else if (answer.ambiguous !== undefined) unlinked.push({ from, transport: site.transport, outcome: "ambiguous", name: answer.ambiguous.key, repos: answer.ambiguous.repos });
    else if (answer.unmatched !== undefined) unlinked.push({ from, transport: site.transport, outcome: "unmatched", name: answer.unmatched });
  }
  return {
    links: [...links.values()].sort((a, b) => compareText(a.id, b.id)),
    unlinked: unlinked.sort((a, b) => compareText(a.from.repo, b.from.repo) || compareText(a.from.file, b.from.file) || a.from.line - b.from.line || compareText(a.from.symbol, b.from.symbol) || compareText(a.name, b.name)),
  };
}
