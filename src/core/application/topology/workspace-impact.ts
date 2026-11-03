import type { ChangedEntrypoint } from "../../domain/impact/changed-entrypoints.ts";
import type { ImpactValue, Seed } from "../../domain/impact/impact-fact.ts";
import type { HttpMethod, HttpRoute } from "../../domain/entrypoints/http-route.ts";
import type { Cut, Fact, FactBase, PartialFact } from "../../domain/shared/fact.ts";
import { incompleteSectionCuts } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { CallSite, EventTarget, HttpTarget } from "../../domain/topology/call-site.ts";
import {
  admitDownstream,
  admitUpstream,
  changeEgress,
  downstreamGraph,
  egressReach,
  feedUpstream,
  handlerKey,
  linkGraphOf,
  mergeEgress,
  mergeLinks,
  reachedBy,
  type DownstreamGraph,
  type JoinedSite,
  type LinkGraph,
} from "../../domain/topology/link-graph.ts";
import type { Reach } from "../../domain/topology/link.ts";
import { inferGateways, matchCallSite, matchEventCallSite, prefixOf, type Gateway, type GatewayDeclaration, type JoinResult, type RepositoryEntrypoints } from "../../domain/topology/link-match.ts";
import { directoryNameOf } from "../../domain/topology/repository-identity.ts";
import type { CallersTarget, ImpactFault, ImpactQueries } from "../../ports/impact-queries.port.ts";
import type { WorkspaceDefaults } from "../../ports/workspace-defaults.port.ts";
import type { WorkspaceFault, WorkspaceRepository } from "../../ports/workspace-repos.port.ts";
import type { FactRead, WorkspaceQueries } from "../../ports/workspace-queries.port.ts";
import type { RepoImpact, WorkspaceCallersRequest, WorkspaceImpactBase, WorkspaceImpactQueries, WorkspaceImpactValue, WorkspaceOfChangeRequest } from "../../ports/workspace-impact-queries.port.ts";
import { workspaceInForce } from "./workspace-defaults.ts";

export interface WorkspaceImpactDeps {
  workspace: WorkspaceQueries;
  impact: ImpactQueries;
  /** The workspace the bound repository persists, which a request naming no repositories joins. */
  defaults?: WorkspaceDefaults;
}

type Faults = WorkspaceFault | ImpactFault;
type Section = { callSites: CallSite[]; unmatched: CallSite[]; external: CallSite[]; ambiguous: CallSite[] };

/** What the fixpoint upstream holds when no link is left to admit. */
interface UpstreamWalk {
  graph: LinkGraph;
  /** Per repository, the walk from the call sites the answer admitted there, as its section reports it. */
  impacts: Map<string, ImpactValue>;
  /** Per repository, the call sites the answer admitted there. */
  sites: Map<string, CallSite[]>;
}

const HTTP_METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "ANY"]);

export function createWorkspaceImpactQueries(deps: WorkspaceImpactDeps): WorkspaceImpactQueries {
  /**
   * `readsChange` tells the two directions apart: a change has one of its own, a callers answer asks what depends on the
   * symbols named and nothing about what they send onward.
   */
  async function compose(request: WorkspaceImpactBase, triggerRevision: string, walk: () => Promise<Result<Fact<ImpactValue>, ImpactFault>>, readsChange: boolean): Promise<Result<FactRead<WorkspaceImpactValue>, Faults>> {
    const inForce = await workspaceInForce(request, deps.defaults);
    if (!inForce.ok) return inForce;
    const read = await deps.workspace.outwardNames({
      repo: { ...request.repo, revision: triggerRevision },
      repos: inForce.value.repos,
      gateways: inForce.value.gateways,
      ...(request.offline === undefined ? {} : { offline: request.offline }),
      ...(request.scope === undefined ? {} : { scope: request.scope }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (!read.ok) return read;
    const fact = read.value.fact;
    const walked = await walk();
    if (!walked.ok) return walked;
    if (fact.status === "unknown") return { ok: false, fault: { kind: "git-failed", detail: "the workspace read answered nothing" } };

    const workspace = fact.value;
    const trigger = request.repo.id ?? directoryNameOf(request.repo.path);
    const impact = walked.value.status === "unknown" ? undefined : walked.value.value;
    const repositories = workspace.repositories;
    const removed = impact?.changedEntrypoints === undefined ? [] : routesOfRemoved(impact.changedEntrypoints);
    const entrypoints = repositories.map((repository) => {
      const own = entrypointsOf(repository);
      return repository.repo === trigger ? { ...own, entrypoints: [...own.entrypoints, ...removed] } : own;
    });
    const gateways = inferGateways(repositories.flatMap((repository) => repository.callSites), entrypoints, inForce.value.gateways);
    const settled = settleAll(repositories, entrypoints, gateways);

    const upstream = await upstreamFixpoint(request, settled.joined, repositories, linkGraphOf(trigger, impact === undefined ? [] : reachedHandlers(impact)));
    if (!upstream.ok) return upstream;
    const downstream = await downstreamFixpoint(request, settled.joined, repositories, trigger, readsChange && impact !== undefined ? impact.seeds : []);
    if (!downstream.ok) return downstream;

    const sections: Record<string, Fact<RepoImpact>> = {};
    for (const repository of repositories) {
      const part = settled.parts.get(repository.repo);
      const base = workspace.sections[repository.repo];
      if (part === undefined || base === undefined) continue;
      part.callSites.push(...(upstream.value.sites.get(repository.repo) ?? []));
      const walkOf = repository.repo === trigger ? impact : upstream.value.impacts.get(repository.repo);
      const value: RepoImpact = {
        ...(walkOf === undefined ? {} : { impact: walkOf }),
        callSites: part.callSites.sort(compareSite),
        unmatched: part.unmatched.sort(compareSite),
        external: part.external.sort(compareSite),
      };
      sections[repository.repo] = sectionOf(base, value, part.ambiguous);
    }

    const triggerBase = workspace.sections[trigger] ?? fact;
    for (const [repo, section] of Object.entries(workspace.sections)) {
      if (section.status === "unknown" && sections[repo] === undefined) sections[repo] = section;
    }
    const value: WorkspaceImpactValue = {
      workspace: {
        repos: workspace.workspace.repos,
        gateways,
        unmatchedGateways: unmatchedGateways(inForce.value.gateways, repositories),
        unserved: [...new Set(workspace.unserved.map(({ name }) => name))].filter((name) => !gateways.some((gateway) => gateway.prefix === name)).sort(compareText),
        source: inForce.value.source,
      },
      repositorySnapshots: workspace.repositorySnapshots,
      trigger: { repo: trigger, ...(impact?.mergeBase === undefined ? {} : { mergeBase: impact.mergeBase }) },
      sections,
      links: mergeLinks(upstream.value.graph, downstream.value),
    };
    return { ok: true, value: { fact: composite(baseOf(triggerBase), value), ...(read.value.refresh === undefined ? {} : { refresh: read.value.refresh }) } };
  }

  /** Every call site of the workspace joined once against the entrypoints of the other repositories, with the drift its section reports. */
  function settleAll(repositories: readonly WorkspaceRepository[], entrypoints: readonly RepositoryEntrypoints[], gateways: readonly Gateway[]): { joined: JoinedSite[]; parts: Map<string, Section> } {
    const joined: JoinedSite[] = [];
    const parts = new Map<string, Section>();
    for (const repository of repositories) {
      const part: Section = { callSites: [], unmatched: [], external: [], ambiguous: [] };
      parts.set(repository.repo, part);
      const others = entrypoints.filter((candidate) => candidate.repo !== repository.repo);
      for (const site of repository.callSites) {
        const event = eventTargetOf(site);
        if (event !== undefined) {
          const answer = matchEventCallSite(site, event, others);
          drift(part, site, answer);
          joined.push({ site, joined: answer });
          continue;
        }
        const target = httpTargetOf(site);
        if (target === undefined) continue;
        const answer = matchCallSite(site, target, others, gateways);
        drift(part, site, answer);
        joined.push({ site, joined: answer });
      }
    }
    return { joined, parts };
  }

  /**
   * The fixpoint upstream: a link whose target a walk reached feeds a walk in the repository that makes it, and the
   * handlers that walk reaches are the seeds of the next join, until no link is left to admit. Each repository is walked
   * once per fresh seed set, so a repository no new link feeds is never read again.
   */
  async function upstreamFixpoint(request: WorkspaceImpactBase, joined: readonly JoinedSite[], repositories: readonly WorkspaceRepository[], start: LinkGraph): Promise<Result<UpstreamWalk, ImpactFault>> {
    let graph = start;
    const impacts = new Map<string, ImpactValue>();
    const sites = new Map<string, CallSite[]>();
    for (;;) {
      graph = admitUpstream(graph, joined);
      const walking = repositories.filter((repository) => graph.pending.has(repository.repo));
      if (walking.length === 0) return { ok: true, value: { graph, impacts, sites } };
      for (const repository of walking) {
        const targets = [...(sites.get(repository.repo) ?? []), ...(graph.pending.get(repository.repo) ?? []).map(({ site }) => site)];
        const walkOf = await consumerWalk(request, repository, targets);
        if (walkOf !== undefined && "fault" in walkOf) return { ok: false, fault: walkOf.fault };
        if (walkOf !== undefined) impacts.set(repository.repo, walkOf);
        sites.set(repository.repo, targets);
        graph = feedUpstream(graph, repository.repo, walkOf === undefined ? new Map() : reachedBy(walkOf.seeds, walkOf.entrypoints, targets));
      }
    }
  }

  /**
   * The fixpoint downstream: the call sites a change sends onward. The repository each link lands in is walked once from
   * all its call sites, which keeps the call sites whose walk reaches the handler the link fed; those are the links out
   * of it, until no link is left to admit.
   */
  async function downstreamFixpoint(request: WorkspaceImpactBase, joined: readonly JoinedSite[], repositories: readonly WorkspaceRepository[], trigger: string, seeds: readonly Seed[]): Promise<Result<DownstreamGraph, ImpactFault>> {
    let graph = downstreamGraph();
    const egress = new Map<string, Map<string, Reach>>();
    mergeEgress(egress, trigger, changeEgress(trigger, seeds, repositories.flatMap((repository) => repository.callSites)));
    const reached = new Map<string, Map<string, readonly CallSite[]>>();
    const egressed = new Map<string, number>();
    for (;;) {
      const next = admitDownstream(graph, joined, egress);
      if (next.links.size === graph.links.size) return { ok: true, value: graph };
      graph = next;
      for (const repository of repositories) {
        const fed = graph.fed.get(repository.repo);
        if (fed === undefined || egressed.get(repository.repo) === fed.size) continue;
        let walkOf = reached.get(repository.repo);
        if (walkOf === undefined) {
          const answered = await consumerWalk(request, repository, repository.callSites);
          if (answered !== undefined && "fault" in answered) return { ok: false, fault: answered.fault };
          walkOf = answered === undefined ? new Map() : reachedBy(answered.seeds, answered.entrypoints, repository.callSites);
          reached.set(repository.repo, walkOf);
        }
        mergeEgress(egress, repository.repo, egressReach(walkOf, fed));
        egressed.set(repository.repo, fed.size);
      }
    }
  }

  /** What depends on the call sites given, read in the repository that holds them. */
  async function consumerWalk(request: WorkspaceImpactBase, repository: WorkspaceRepository, sites: readonly CallSite[]): Promise<ImpactValue | { fault: ImpactFault } | undefined> {
    if (sites.length === 0) return undefined;
    const targets: CallersTarget[] = sites.map((site) => ({ file: site.file, start: site.line, end: site.endLine ?? site.line }));
    const answered = await deps.impact.callers({
      repo: repository.path,
      repoId: repository.repo,
      revision: repository.snapshot.kind === "sha" ? repository.snapshot.sha : "HEAD",
      targets,
      ...(request.scope === undefined ? {} : { scope: request.scope }),
      ...(request.budget === undefined ? {} : { budget: request.budget }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (!answered.ok) return { fault: answered.fault };
    return answered.value.status === "unknown" ? undefined : answered.value.value;
  }

  return {
    callers: (request: WorkspaceCallersRequest) =>
      compose(
        request,
        request.repo.revision ?? "HEAD",
        () =>
          deps.impact.callers({
            repo: request.repo.path,
            repoId: request.repo.id ?? directoryNameOf(request.repo.path),
            revision: request.repo.revision ?? "HEAD",
            targets: request.targets,
            ...(request.scope === undefined ? {} : { scope: request.scope }),
            ...(request.budget === undefined ? {} : { budget: request.budget }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          }),
        false,
      ),
    ofChange: (request: WorkspaceOfChangeRequest) =>
      compose(
        request,
        request.repo.revision ?? request.head,
        () =>
          deps.impact.ofChange({
            repo: request.repo.path,
            repoId: request.repo.id ?? directoryNameOf(request.repo.path),
            base: request.base,
            head: request.repo.revision ?? request.head,
            ...(request.scope === undefined ? {} : { scope: request.scope }),
            ...(request.budget === undefined ? {} : { budget: request.budget }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          }),
        true,
      ),
  };
}

function entrypointsOf(repository: WorkspaceRepository): RepositoryEntrypoints {
  return { repo: repository.repo, entrypoints: repository.entrypoints.flatMap((finding) => (finding.status === "complete" ? [finding.value] : [])) };
}

function reachedHandlers(impact: ImpactValue): Set<string> {
  return new Set([...impact.entrypoints.map(({ handler }) => handlerKey(handler)), ...(impact.changedEntrypoints ?? []).map(({ handler }) => handlerKey(handler))]);
}

/** A call site the join did not link: the service's drift, a name no repository given serves, or two repositories that matched it equally. */
function drift(part: Section, site: CallSite, joined: JoinResult): void {
  if (joined.ambiguous !== undefined) part.ambiguous.push(site);
  else if (joined.unmatched !== undefined) part.unmatched.push(site);
  else if (joined.link === undefined) part.external.push(site);
}

/** A route the change removed no longer exists at head, so it is rebuilt from the name the change reports: `METHOD path`. */
function routesOfRemoved(changes: readonly ChangedEntrypoint[]): HttpRoute[] {
  return changes.flatMap((change): HttpRoute[] => {
    if (change.kind !== "http-route" || change.change !== "removed") return [];
    const [method, path] = change.name.split(" ");
    if (method === undefined || path === undefined || !HTTP_METHODS.has(method)) return [];
    return [{ kind: "http-route", name: change.name, method: method as HttpMethod, path, handler: change.handler, basePath: { status: "unknown", reason: "unresolved", evidence: [] } }];
  });
}

function httpTargetOf(site: CallSite): HttpTarget | undefined {
  return site.transport === "http" && site.target.status === "complete" && "path" in site.target.value ? site.target.value : undefined;
}

function eventTargetOf(site: CallSite): EventTarget | undefined {
  return site.transport === "event" && site.target.status === "complete" && "protocol" in site.target.value ? site.target.value : undefined;
}

function compareSite(a: CallSite, b: CallSite): number {
  return compareText(a.file, b.file) || a.line - b.line || compareText(a.symbol, b.symbol);
}

function unmatchedGateways(declared: readonly GatewayDeclaration[], repositories: readonly { repo: string; callSites: readonly CallSite[] }[]): GatewayDeclaration[] {
  const read = new Set(repositories.map(({ repo }) => repo));
  const named = new Set(repositories.flatMap(({ callSites }) => callSites.flatMap((site) => (site.target.status === "complete" && "path" in site.target.value ? [prefixOf(site.target.value)] : []))));
  return declared.filter((gateway) => !read.has(gateway.repo) || !named.has(gateway.prefix)).sort((a, b) => compareText(a.prefix, b.prefix) || compareText(a.repo, b.repo));
}

function baseOf(fact: FactBase): FactBase {
  const { schema, snapshot, producer, inputs } = fact;
  return { schema, snapshot, producer, inputs, evidence: [] };
}

/**
 * One repository's section: its own fact base, so its snapshot and trust travel with it; the call sites its snapshot
 * could not decide stay cuts, and so do the call sites two repositories matched equally.
 */
function sectionOf(section: Fact<{ unresolved: readonly unknown[] }>, value: RepoImpact, ambiguous: readonly CallSite[]): Fact<RepoImpact> {
  const cuts: Cut[] = [
    ...(section.status === "partial" ? section.cuts : []),
    ...ambiguous.map((site): Cut => ({ kind: "unresolved-link", at: [site.file, `${site.file}:${site.line}`] })),
  ];
  const base = { ...baseOf(section), evidence: section.evidence };
  const [first, ...rest] = cuts;
  return first === undefined ? { ...base, status: "complete", value } : ({ ...base, status: "partial", value, cuts: [first, ...rest] } satisfies PartialFact<RepoImpact>);
}

/** Complete only when every section is. */
function composite(base: FactBase, value: WorkspaceImpactValue): Fact<WorkspaceImpactValue> {
  const [first, ...rest] = incompleteSectionCuts(value.sections);
  return first === undefined ? { ...base, status: "complete", value } : { ...base, status: "partial", value, cuts: [first, ...rest] };
}
