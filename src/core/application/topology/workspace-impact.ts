import type { ChangedEntrypoint } from "../../domain/impact/changed-entrypoints.ts";
import type { ImpactValue, Seed } from "../../domain/impact/impact-fact.ts";
import type { HttpMethod, HttpRoute } from "../../domain/entrypoints/http-route.ts";
import type { Cut, Fact, FactBase, SnapshotRef } from "../../domain/shared/fact.ts";
import { incompleteSectionCuts, provenanceOf, withCuts } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { compositeBase } from "../../domain/topology/composite-inputs.ts";
import type { CallSite } from "../../domain/topology/call-site.ts";
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
import type { ImpactedLink, Reach } from "../../domain/topology/link.ts";
import type { ChangedContract } from "../../domain/impact/changed-contracts.ts";
import { prefixOf, type GatewayDeclaration, type JoinResult } from "../../domain/topology/link-match.ts";
import { entrypointsOf, joinWorkspace } from "./workspace-join.ts";
import { directoryNameOf } from "../../domain/topology/repository-identity.ts";
import type { CallersTarget, ImpactCallersRequest, ImpactFault, ImpactOfChangeRequest, ImpactQueries } from "../../ports/impact-queries.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { WorkspaceFault, WorkspaceRepository } from "../../ports/workspace-repos.port.ts";
import type { FactRead, WorkspaceQueries } from "../../ports/workspace-queries.port.ts";
import type { RepoImpact, WorkspaceCallersRequest, WorkspaceImpactBase, WorkspaceImpactQueries, WorkspaceImpactValue, WorkspaceOfChangeRequest } from "../../ports/workspace-impact-queries.port.ts";
import type { WorkspacePlanningRequest } from "./workspace-plan.ts";
import type { WorkspaceReadOperation } from "./workspace-operation.ts";
import type { WorkspaceSnapshotContext } from "./workspace-snapshots.ts";
import type { WorkspaceRepositoryDeclaration } from "../../domain/topology/workspace-manifest.ts";

export interface WorkspaceImpactDeps {
  workspace: WorkspaceQueries;
  impact: ImpactQueries;
  digest: Digest;
}

type Faults = WorkspaceFault | ImpactFault;
type Section = { callSites: CallSite[]; unmatched: CallSite[]; external: CallSite[]; ambiguous: CallSite[] };
type ReadLocations = ReadonlyMap<string, { root: string; source: string }>;

/** What the fixpoint upstream holds when no link is left to admit. */
interface UpstreamWalk {
  graph: LinkGraph;
  /** Per repository, the walk from the call sites the answer admitted there, as its section reports it. */
  impacts: Map<string, ImpactValue>;
  facts: Map<string, Fact<ImpactValue>[]>;
  /** Per repository, the call sites the answer admitted there. */
  sites: Map<string, CallSite[]>;
}

const HTTP_METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "ANY"]);

type CommittedRequest<T> = Omit<T, "repo" | "repos"> & { repo: WorkspaceRepositoryDeclaration & { live?: never }; repos?: readonly (WorkspaceRepositoryDeclaration & { live?: never })[] };

export function createWorkspaceImpactQueries(deps: WorkspaceImpactDeps): {
  callers(request: CommittedRequest<WorkspaceCallersRequest>): ReturnType<WorkspaceImpactQueries["callers"]>;
  ofChange(request: CommittedRequest<WorkspaceOfChangeRequest>): ReturnType<WorkspaceImpactQueries["ofChange"]>;
} {
  const queries = workspaceImpactQueries(deps);
  const valid = (request: CommittedRequest<WorkspaceImpactBase>) => ![request.repo, ...(request.repos ?? [])].some((repo) => "live" in repo);
  const rejected = { ok: false as const, fault: { kind: "git-failed" as const, detail: "invalid workspace selection" } };
  return {
    callers: (request) => valid(request) ? queries.callers(request) : Promise.resolve(rejected),
    ofChange: (request) => valid(request) ? queries.ofChange(request) : Promise.resolve(rejected),
  };
}

type CapturedWalk = (repo: string, snapshot: SnapshotRef | undefined, targets: readonly CallersTarget[], request: WorkspaceImpactBase) => Promise<Result<Fact<ImpactValue>, ImpactFault>>;
type CapturedWalks = { callers: CapturedWalk; change(repo: string, snapshot: SnapshotRef | undefined, request: WorkspaceOfChangeRequest): Promise<Result<Fact<ImpactValue>, ImpactFault>> };

function workspaceImpactQueries(deps: WorkspaceImpactDeps, captured?: CapturedWalks): WorkspaceImpactQueries {
  /**
   * `readsChange` tells the two directions apart: a change has one of its own, a callers answer asks what depends on the
   * symbols named and nothing about what they send onward.
   */
  async function compose(request: WorkspaceImpactBase, triggerRevision: string, walk: (revision: string) => Promise<Result<Fact<ImpactValue>, ImpactFault>>, readsChange: boolean): Promise<Result<FactRead<WorkspaceImpactValue>, Faults>> {
    const read = await deps.workspace.outwardNames({
      repo: { path: request.repo.path, ...(request.repo.id === undefined ? {} : { id: request.repo.id }), ...(request.repo.remote === undefined ? {} : { remote: request.repo.remote }), revision: triggerRevision },
      ...(request.repos === undefined ? {} : { repos: request.repos }),
      ...(request.gateways === undefined ? {} : { gateways: request.gateways }),
      ...(request.replay === undefined ? {} : { replay: request.replay }),
      ...(request.offline === undefined ? {} : { offline: request.offline }),
      ...(request.scope === undefined ? {} : { scope: request.scope }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (!read.ok) return read;
    const fact = read.value.fact;
    if (fact.status === "unknown") return { ok: false, fault: { kind: "git-failed", detail: "the workspace read answered nothing" } };

    const workspace = fact.value;
    const trigger = request.repo.id ?? directoryNameOf(request.repo.path);
    const pinned = workspace.sections[trigger]?.snapshot;
    const walked = captured === undefined
      ? await walk(pinned?.kind === "sha" ? pinned.sha : triggerRevision)
      : readsChange
        ? await captured.change(trigger, pinned, request as WorkspaceOfChangeRequest)
        : await captured.callers(trigger, pinned, (request as WorkspaceCallersRequest).targets, request);
    if (!walked.ok) return walked;
    const impact = walked.value.status === "unknown" ? undefined : walked.value.value;
    const repositories = workspace.repositories;
    const roots = new Map((read.value.repositoryRoots ?? []).map(({ repo, path }) => [repo, path]));
    const sources: ReadLocations = new Map((read.value.repositorySources ?? []).map(({ repo, path }) => [repo, { root: roots.get(repo) ?? path, source: path }]));
    const removed = impact?.changedEntrypoints === undefined ? [] : routesOfRemoved(impact.changedEntrypoints);
    const entrypoints = repositories.map((repository) => {
      const own = entrypointsOf(repository);
      return repository.repo === trigger ? { ...own, entrypoints: [...own.entrypoints, ...removed] } : own;
    });
    const { gateways, joined } = joinWorkspace(repositories, entrypoints, workspace.workspace.gateways);
    const parts = driftOf(repositories, joined);

    const upstream = await upstreamFixpoint(request, joined, repositories, sources, linkGraphOf(trigger, impact === undefined ? [] : reachedHandlers(impact)));
    if (!upstream.ok) return upstream;
    const downstream = await downstreamFixpoint(request, joined, repositories, sources, trigger, readsChange && impact !== undefined ? impact.seeds : []);
    if (!downstream.ok) return downstream;

    const sections: Record<string, Fact<RepoImpact>> = Object.create(null);
    for (const repository of repositories) {
      const part = parts.get(repository.repo);
      const base = workspace.sections[repository.repo];
      if (part === undefined || base === undefined) continue;
      part.callSites.push(...(upstream.value.sites.get(repository.repo) ?? []));
      const walkOf = repository.repo === trigger ? impact : upstream.value.impacts.get(repository.repo);
      const value: RepoImpact = {
        reads: [
          { kind: "discovery", fact: provenanceOf(base) },
          ...(repository.repo === trigger ? [{ kind: "trigger" as const, fact: provenanceOf(walked.value) }] : []),
          ...(upstream.value.facts.get(repository.repo) ?? []).map((walk) => ({ kind: "upstream" as const, fact: provenanceOf(walk) })),
          ...(downstream.value.facts.get(repository.repo) ?? []).map((walk) => ({ kind: "downstream" as const, fact: provenanceOf(walk) })),
        ],
        ...(walkOf === undefined ? {} : { impact: walkOf }),
        callSites: part.callSites.sort(compareSite),
        unmatched: part.unmatched.sort(compareSite),
        external: part.external.sort(compareSite),
        unresolved: base.status === "unknown" ? [] : base.value.unresolved,
      };
      sections[repository.repo] = sectionOf(base, value, part.ambiguous, repository.repo === trigger ? unservedOperationCuts(impact?.changedContracts ?? []) : [], deps.digest);
    }

    const triggerBase = sections[trigger] ?? fact;
    for (const [repo, section] of Object.entries(workspace.sections)) {
      if (section.status === "unknown" && sections[repo] === undefined) sections[repo] = section;
    }
    const value: WorkspaceImpactValue = {
      workspace: {
        repos: workspace.workspace.repos,
        gateways,
        unmatchedGateways: unmatchedGateways(workspace.workspace.gateways, repositories),
        unserved: [...new Set(workspace.unserved.map(({ name }) => name))].filter((name) => !gateways.some((gateway) => gateway.prefix === name)).sort(compareText),
        source: workspace.workspace.source,
      },
      repositorySnapshots: workspace.repositorySnapshots,
      trigger: { repo: trigger, ...(impact?.mergeBase === undefined ? {} : { mergeBase: impact.mergeBase }) },
      sections: Object.fromEntries(Object.entries(sections)),
      links: withOperations(mergeLinks(upstream.value.graph, downstream.value.graph), trigger, impact?.changedContracts ?? []),
    };
    const config = walked.value.inputs.declaredConfig;
    const declared = { repos: workspace.workspace.repos, gateways: workspace.workspace.gateways.toSorted((a, b) => compareText(a.prefix, b.prefix) || compareText(a.repo, b.repo)), source: workspace.workspace.source, budget: request.budget, ...("targets" in request ? { targets: request.targets } : {}), ...("changed" in request ? { changed: request.changed } : {}) };
    const reads = Object.entries(sections).flatMap(([repo, section]) => section.status === "unknown" ? [{ kind: `discovery:${repo}`, fact: provenanceOf(section) }] : section.value.reads.map(({ kind, fact }) => ({ kind: `${kind}:${repo}`, fact })));
    const base = compositeBase(baseOf(triggerBase), reads, declared, (text) => deps.digest.of(text), config);
    return { ok: true, value: { fact: composite(base, value), ...(read.value.workspaceReplay === undefined ? {} : { workspaceReplay: read.value.workspaceReplay }), ...(read.value.refresh === undefined ? {} : { refresh: read.value.refresh }), ...(read.value.repositoryRoots === undefined ? {} : { repositoryRoots: read.value.repositoryRoots }) } };
  }

  /** The drift each section reports, from the one join of the workspace. */
  function driftOf(repositories: readonly WorkspaceRepository[], joined: readonly JoinedSite[]): Map<string, Section> {
    const parts = new Map<string, Section>(repositories.map((repository) => [repository.repo, { callSites: [], unmatched: [], external: [], ambiguous: [] }]));
    for (const { site, joined: answer } of joined) {
      const part = parts.get(site.repo);
      if (part !== undefined) drift(part, site, answer);
    }
    return parts;
  }

  /**
   * The fixpoint upstream: a link whose target a walk reached feeds a walk in the repository that makes it, and the
   * handlers that walk reaches are the seeds of the next join, until no link is left to admit. Each repository is walked
   * once per fresh seed set, so a repository no new link feeds is never read again.
   */
  async function upstreamFixpoint(request: WorkspaceImpactBase, joined: readonly JoinedSite[], repositories: readonly WorkspaceRepository[], sources: ReadLocations, start: LinkGraph): Promise<Result<UpstreamWalk, ImpactFault>> {
    let graph = start;
    const impacts = new Map<string, ImpactValue>();
    const facts = new Map<string, Fact<ImpactValue>[]>();
    const sites = new Map<string, CallSite[]>();
    for (;;) {
      graph = admitUpstream(graph, joined);
      const walking = repositories.filter((repository) => graph.pending.has(repository.repo));
      if (walking.length === 0) return { ok: true, value: { graph, impacts, facts, sites } };
      for (const repository of walking) {
        const targets = [...(sites.get(repository.repo) ?? []), ...(graph.pending.get(repository.repo) ?? []).map(({ site }) => site)];
        const walkOf = await consumerWalk(request, repository, sources, targets);
        if (walkOf !== undefined && "fault" in walkOf) return { ok: false, fault: walkOf.fault };
        if (walkOf !== undefined) facts.set(repository.repo, [...(facts.get(repository.repo) ?? []), walkOf]);
        const impact = walkOf?.status === "unknown" ? undefined : walkOf?.value;
        if (impact !== undefined) impacts.set(repository.repo, impact);
        sites.set(repository.repo, targets);
        graph = feedUpstream(graph, repository.repo, impact === undefined ? new Map() : reachedBy(impact.seeds, impact.entrypoints, targets));
      }
    }
  }

  /**
   * The fixpoint downstream: the call sites a change sends onward. The repository each link lands in is walked once from
   * all its call sites, which keeps the call sites whose walk reaches the handler the link fed; those are the links out
   * of it, until no link is left to admit.
   */
  async function downstreamFixpoint(request: WorkspaceImpactBase, joined: readonly JoinedSite[], repositories: readonly WorkspaceRepository[], sources: ReadLocations, trigger: string, seeds: readonly Seed[]): Promise<Result<{ graph: DownstreamGraph; facts: Map<string, Fact<ImpactValue>[]> }, ImpactFault>> {
    let graph = downstreamGraph();
    const facts = new Map<string, Fact<ImpactValue>[]>();
    const egress = new Map<string, Map<string, Reach>>();
    mergeEgress(egress, trigger, changeEgress(trigger, seeds, repositories.flatMap((repository) => repository.callSites)));
    const reached = new Map<string, Map<string, readonly CallSite[]>>();
    const egressed = new Map<string, number>();
    for (;;) {
      const next = admitDownstream(graph, joined, egress);
      if (next.links.size === graph.links.size) return { ok: true, value: { graph, facts } };
      graph = next;
      for (const repository of repositories) {
        const fed = graph.fed.get(repository.repo);
        if (fed === undefined || egressed.get(repository.repo) === fed.size) continue;
        let walkOf = reached.get(repository.repo);
        if (walkOf === undefined) {
          const answered = await consumerWalk(request, repository, sources, repository.callSites);
          if (answered !== undefined && "fault" in answered) return { ok: false, fault: answered.fault };
          if (answered !== undefined) facts.set(repository.repo, [...(facts.get(repository.repo) ?? []), answered]);
          walkOf = answered === undefined || answered.status === "unknown" ? new Map() : reachedBy(answered.value.seeds, answered.value.entrypoints, repository.callSites);
          reached.set(repository.repo, walkOf);
        }
        mergeEgress(egress, repository.repo, egressReach(walkOf, fed));
        egressed.set(repository.repo, fed.size);
      }
    }
  }

  /** What depends on the call sites given, read in the repository that holds them. */
  async function consumerWalk(request: WorkspaceImpactBase, repository: WorkspaceRepository, sources: ReadLocations, sites: readonly CallSite[]): Promise<Fact<ImpactValue> | { fault: ImpactFault } | undefined> {
    if (sites.length === 0) return undefined;
    const targets: CallersTarget[] = sites.map((site) => ({ file: site.file, start: site.line, end: site.endLine ?? site.line }));
    if (captured !== undefined) {
      const answer = await captured.callers(repository.repo, repository.snapshot, targets, request);
      return answer.ok ? answer.value : { fault: answer.fault };
    }
    const source = sources.get(repository.repo);
    if (source === undefined) return { fault: { kind: "git-failed", detail: `no read location for ${repository.repo}` } };
    if (repository.snapshot.kind !== "sha") return { fault: { kind: "git-failed", detail: `unsupported snapshot for ${repository.repo}` } };
    const answered = await deps.impact.callers({
      repo: source.root,
      ...(source.source === source.root ? {} : { source: source.source }),
      repoId: repository.repo,
      revision: repository.snapshot.sha,
      targets,
      ...(request.scope === undefined ? {} : { scope: request.scope }),
      ...(request.budget === undefined ? {} : { budget: request.budget }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (!answered.ok) return { fault: answered.fault };
    return answered.value;
  }

  return {
    callers: (request: WorkspaceCallersRequest) =>
      compose(
        request,
        request.repo.revision ?? "HEAD",
        (revision) =>
          deps.impact.callers({
            repo: request.repo.path,
            repoId: request.repo.id ?? directoryNameOf(request.repo.path),
            revision,
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
        request.repo.revision ?? "HEAD",
        (revision) =>
          deps.impact.ofChange({
            repo: request.repo.path,
            repoId: request.repo.id ?? directoryNameOf(request.repo.path),
            base: request.base,
            head: revision,
            ...(request.changed === undefined ? {} : { changed: request.changed }),
            ...(request.scope === undefined ? {} : { scope: request.scope }),
            ...(request.budget === undefined ? {} : { budget: request.budget }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          }),
        true,
      ),
  };
}

export type CapturedWorkspaceCallersRequest = WorkspacePlanningRequest & { targets: readonly CallersTarget[]; budget?: NonNullable<WorkspaceImpactBase["budget"]> };
export type CapturedWorkspaceOfChangeRequest = WorkspacePlanningRequest & { base: string; changed?: readonly string[]; budget?: NonNullable<WorkspaceImpactBase["budget"]> };

type CapturedLocation = { kind: "sha"; repo: string; source: string; sha: string } | { kind: "live"; repo: string };

export function createCapturedWorkspaceImpactQueries(deps: { operation: WorkspaceReadOperation; impactAt(context: WorkspaceSnapshotContext): ImpactQueries; digest: Digest }) {
  async function execute(request: CapturedWorkspaceCallersRequest | CapturedWorkspaceOfChangeRequest, planning: WorkspacePlanningRequest): Promise<Result<FactRead<WorkspaceImpactValue>, Faults>> {
    const result = await deps.operation.withRead<FactRead<WorkspaceImpactValue>, Faults>(planning, async (read, context) => {
      const impact = deps.impactAt(context);
      const location = (repo: string, observed: SnapshotRef | undefined): Result<CapturedLocation, ImpactFault> => {
        const selected = context.selectedSnapshots.find((snapshot) => snapshot.repo === repo);
        const mismatch = selected === undefined || observed === undefined || selected.kind !== observed.kind ||
          (selected.kind === "sha" && (observed.kind !== "sha" || selected.sha !== observed.sha)) ||
          (selected.kind === "live" && (observed.kind !== "live" || selected.head !== observed.head || selected.stateId !== observed.stateId));
        if (mismatch || selected === undefined) return { ok: false, fault: { kind: "git-failed", detail: `no selected snapshot for ${repo}` } };
        if (selected.kind === "live") {
          const held = context.liveCaptures.get(repo);
          const plan = context.livePlans.find((item) => item.repoId === repo);
          if (held === undefined || plan === undefined || held.repo !== plan.canonical || held.repoId !== repo || held.head !== selected.head || held.tree.stateId !== selected.stateId) return { ok: false, fault: { kind: "git-failed", detail: `no live capture for ${repo}` } };
          return { ok: true, value: { kind: "live", repo: held.repo } };
        }
        if (selected.kind === "sha") {
          const plan = context.plans.find((item) => item.kind === "read" && item.at.repoId === repo);
          if (plan === undefined || plan.kind !== "read" || plan.at.revision !== selected.sha) return { ok: false, fault: { kind: "git-failed", detail: `no committed source for ${repo}` } };
          return { ok: true, value: { kind: "sha", repo: plan.at.declared, source: plan.at.source, sha: selected.sha } };
        }
        return { ok: false, fault: { kind: "git-failed", detail: `unsupported snapshot for ${repo}` } };
      };
      const common = (repoId: string) => ({ repoId, ...(request.scope === undefined ? {} : { scope: request.scope }), ...(request.budget === undefined ? {} : { budget: request.budget }), ...(context.signal === undefined ? {} : { signal: context.signal }) });
      const captured: CapturedWalks = {
        callers: async (repo, observed, targets) => {
          const at = location(repo, observed);
          if (!at.ok) return at;
          const query: ImpactCallersRequest = at.value.kind === "live"
            ? { ...common(repo), repo: at.value.repo, live: true, targets }
            : { ...common(repo), repo: at.value.repo, ...(at.value.source === at.value.repo ? {} : { source: at.value.source }), revision: at.value.sha, targets };
          return impact.callers(query);
        },
        change: async (repo, observed, change) => {
          const at = location(repo, observed);
          if (!at.ok) return at;
          if (at.value.kind === "sha" && at.value.source !== at.value.repo) return { ok: false, fault: { kind: "git-failed", detail: `unsupported change source for ${repo}` } };
          const query: ImpactOfChangeRequest = { ...common(repo), repo: at.value.repo, base: change.base, ...(change.changed === undefined ? {} : { changed: change.changed }), ...(at.value.kind === "live" ? { live: true as const } : { head: at.value.sha }) };
          return impact.ofChange(query);
        },
      };
      const fixedWorkspace: WorkspaceQueries = { outwardNames: async () => ({ ok: true, value: read }) };
      const queries = workspaceImpactQueries({ workspace: fixedWorkspace, impact, digest: deps.digest }, captured);
      return "targets" in request
        ? queries.callers(request)
        : queries.ofChange(request);
    });
    if (!result.ok) return result;
    const { workspaceReplay: _replay, workspaceLive: _live, ...value } = result.value.value;
    return { ok: true, value: { ...value, ...(result.value.workspaceReplay === undefined ? {} : { workspaceReplay: result.value.workspaceReplay }), ...(result.value.workspaceLive === undefined ? {} : { workspaceLive: result.value.workspaceLive }) } };
  }
  return {
    callers(request: CapturedWorkspaceCallersRequest) {
      const { targets: _targets, budget: _budget, ...planning } = request;
      return execute(request, planning);
    },
    ofChange(request: CapturedWorkspaceOfChangeRequest) {
      const { base: _base, changed: _changed, budget: _budget, ...planning } = request;
      return execute(request, planning);
    },
  };
}

function reachedHandlers(impact: ImpactValue): Set<string> {
  return new Set([
    ...impact.entrypoints.map(({ handler }) => handlerKey(handler)),
    ...(impact.changedEntrypoints ?? []).map(({ handler }) => handlerKey(handler)),
    ...(impact.changedContracts ?? []).flatMap(({ handlers }) => (handlers ?? []).map(handlerKey)),
  ]);
}

/** An altered or removed operation no route serves cannot name the consumers that call it, so the trigger's section stops there. */
function unservedOperationCuts(contracts: readonly ChangedContract[]): Cut[] {
  return contracts.flatMap(({ change, handlers, document, line }): Cut[] => (change === "added" || handlers !== undefined ? [] : [{ kind: "unresolved-link", at: [document, `${document}:${line}`] }]));
}

/** A link that lands in a handler of the trigger serving an operation the change altered or removed calls that operation. */
function withOperations(links: readonly ImpactedLink[], trigger: string, contracts: readonly ChangedContract[]): ImpactedLink[] {
  return links.map((impacted) => {
    const key = handlerKey(impacted.link.to.handler);
    const operations = impacted.link.to.repo !== trigger ? [] : contracts.flatMap(({ handlers, ...operation }) => ((handlers ?? []).some((handler) => handlerKey(handler) === key) ? [operation] : []));
    return operations.length === 0 ? impacted : { ...impacted, operations };
  });
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
function sectionOf(section: Fact<{ unresolved: readonly unknown[] }>, value: RepoImpact, ambiguous: readonly CallSite[], unserved: readonly Cut[], digest: Digest): Fact<RepoImpact> {
  if (section.status === "unknown") return section;
  const cuts: Cut[] = [
    ...value.reads.flatMap(({ kind, fact }, index): readonly Cut[] => fact.status === "partial" ? fact.cuts : fact.status === "unknown" ? [{ kind: "section", at: [kind, String(index)] }] : []),
    ...ambiguous.map((site): Cut => ({ kind: "unresolved-link", at: [site.file, `${site.file}:${site.line}`] })),
    ...unserved,
  ];
  const triggerWalk = value.reads.find(({ kind }) => kind === "trigger")?.fact;
  const base = compositeBase({ ...baseOf(section), evidence: section.evidence }, value.reads, {}, (text) => digest.of(text), triggerWalk?.inputs.declaredConfig ?? section.inputs.declaredConfig);
  return withCuts(base, value, cuts);
}

/** Complete only when every section is. */
function composite(base: FactBase, value: WorkspaceImpactValue): Fact<WorkspaceImpactValue> {
  const [first, ...rest] = incompleteSectionCuts(value.sections);
  return first === undefined ? { ...base, status: "complete", value } : { ...base, status: "partial", value, cuts: [first, ...rest] };
}
