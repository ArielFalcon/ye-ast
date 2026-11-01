import type { ChangedEntrypoint } from "../../domain/impact/changed-entrypoints.ts";
import type { ImpactValue } from "../../domain/impact/impact-fact.ts";
import type { HttpMethod, HttpRoute } from "../../domain/entrypoints/http-route.ts";
import type { Cut, Fact, FactBase, PartialFact } from "../../domain/shared/fact.ts";
import { incompleteSectionCuts } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { CallSite, HttpTarget } from "../../domain/topology/call-site.ts";
import type { ImpactedLink, Link } from "../../domain/topology/link.ts";
import { inferGateways, matchCallSite, type RepositoryEntrypoints } from "../../domain/topology/link-match.ts";
import { directoryNameOf } from "../../domain/topology/repository-identity.ts";
import type { CallersTarget, ImpactFault, ImpactQueries } from "../../ports/impact-queries.port.ts";
import type { WorkspaceFault, WorkspaceRepository } from "../../ports/workspace-repos.port.ts";
import type { WorkspaceQueries } from "../../ports/workspace-queries.port.ts";
import type { RepoImpact, WorkspaceCallersRequest, WorkspaceImpactBase, WorkspaceImpactQueries, WorkspaceImpactValue, WorkspaceOfChangeRequest } from "../../ports/workspace-impact-queries.port.ts";

export interface WorkspaceImpactDeps {
  workspace: WorkspaceQueries;
  impact: ImpactQueries;
}

type Faults = WorkspaceFault | ImpactFault;
type Section = { callSites: CallSite[]; unmatched: CallSite[]; external: CallSite[]; ambiguous: CallSite[] };

const HTTP_METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "ANY"]);

export function createWorkspaceImpactQueries(deps: WorkspaceImpactDeps): WorkspaceImpactQueries {
  async function compose(request: WorkspaceImpactBase, triggerRevision: string, walk: () => Promise<Result<Fact<ImpactValue>, ImpactFault>>): Promise<Result<Fact<WorkspaceImpactValue>, Faults>> {
    const read = await deps.workspace.outwardNames({
      repo: { ...request.repo, revision: triggerRevision },
      ...(request.repos === undefined ? {} : { repos: request.repos }),
      ...(request.gateways === undefined ? {} : { gateways: request.gateways }),
      ...(request.scope === undefined ? {} : { scope: request.scope }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (!read.ok) return read;
    const walked = await walk();
    if (!walked.ok) return walked;
    if (read.value.status === "unknown") return { ok: false, fault: { kind: "git-failed", detail: "the workspace read answered nothing" } };

    const workspace = read.value.value;
    const trigger = request.repo.id ?? directoryNameOf(request.repo.path);
    const impact = walked.value.status === "unknown" ? undefined : walked.value.value;
    const repositories = workspace.repositories;
    const removed = impact?.changedEntrypoints === undefined ? [] : routesOfRemoved(impact.changedEntrypoints);
    const entrypoints = repositories.map((repository) => {
      const own = entrypointsOf(repository);
      return repository.repo === trigger ? { ...own, entrypoints: [...own.entrypoints, ...removed] } : own;
    });
    const gateways = inferGateways(repositories.flatMap((repository) => repository.callSites), entrypoints, request.gateways ?? []);
    const reached = impact === undefined ? new Set<string>() : reachedHandlers(impact);
    const isReached = (link: Link): boolean => link.to.repo === trigger && reached.has(handlerKey(link.to.handler));

    const links = new Map<string, ImpactedLink>();
    const parts = new Map<string, Section>();
    for (const repository of repositories) {
      const part: Section = { callSites: [], unmatched: [], external: [], ambiguous: [] };
      parts.set(repository.repo, part);
      const others = entrypoints.filter((candidate) => candidate.repo !== repository.repo);
      for (const site of repository.callSites) {
        const target = httpTargetOf(site);
        if (target === undefined) continue;
        const joined = matchCallSite(site, target, others, gateways);
        if (joined.ambiguous !== undefined) part.ambiguous.push(site);
        else if (joined.unmatched !== undefined) part.unmatched.push(site);
        else if (joined.link === undefined) part.external.push(site);
        else if (isReached(joined.link)) {
          links.set(joined.link.id, { link: joined.link, direction: "upstream", reach: [joined.link.id] });
          part.callSites.push(site);
        }
      }
    }

    const sections: Record<string, Fact<RepoImpact>> = {};
    for (const repository of repositories) {
      const part = parts.get(repository.repo);
      const base = workspace.sections[repository.repo];
      if (part === undefined || base === undefined) continue;
      const walkOf = repository.repo === trigger ? impact : await consumerWalk(request, repository, part.callSites);
      if (walkOf !== undefined && "fault" in walkOf) return { ok: false, fault: walkOf.fault };
      const value: RepoImpact = {
        ...(walkOf === undefined ? {} : { impact: walkOf }),
        callSites: part.callSites.sort(compareSite),
        unmatched: part.unmatched.sort(compareSite),
        external: part.external.sort(compareSite),
      };
      sections[repository.repo] = sectionOf(base, value, part.ambiguous);
    }

    const triggerBase = workspace.sections[trigger] ?? read.value;
    const value: WorkspaceImpactValue = {
      workspace: { repos: workspace.workspace.repos, gateways, unserved: workspace.unserved.map(({ name }) => name) },
      repositorySnapshots: workspace.repositorySnapshots,
      trigger: { repo: trigger, ...(impact?.mergeBase === undefined ? {} : { mergeBase: impact.mergeBase }) },
      sections,
      links: [...links.values()].sort(compareLink),
    };
    return { ok: true, value: composite(baseOf(triggerBase), value) };
  }

  /** What depends on the call sites that landed in what the trigger reached, read in the repository that holds them. */
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
      compose(request, request.repo.revision ?? "HEAD", () =>
        deps.impact.callers({
          repo: request.repo.path,
          repoId: request.repo.id ?? directoryNameOf(request.repo.path),
          revision: request.repo.revision ?? "HEAD",
          targets: request.targets,
          ...(request.scope === undefined ? {} : { scope: request.scope }),
          ...(request.budget === undefined ? {} : { budget: request.budget }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        }),
      ),
    ofChange: (request: WorkspaceOfChangeRequest) =>
      compose(request, request.repo.revision ?? request.head, () =>
        deps.impact.ofChange({
          repo: request.repo.path,
          repoId: request.repo.id ?? directoryNameOf(request.repo.path),
          base: request.base,
          head: request.repo.revision ?? request.head,
          ...(request.scope === undefined ? {} : { scope: request.scope }),
          ...(request.budget === undefined ? {} : { budget: request.budget }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        }),
      ),
  };
}

function entrypointsOf(repository: WorkspaceRepository): RepositoryEntrypoints {
  return { repo: repository.repo, entrypoints: repository.entrypoints.flatMap((finding) => (finding.status === "complete" ? [finding.value] : [])) };
}

function handlerKey(handler: { path: string; symbol: string; line: number }): string {
  return `${handler.path}\0${handler.symbol}\0${handler.line}`;
}

function reachedHandlers(impact: ImpactValue): Set<string> {
  return new Set([...impact.entrypoints.map(({ handler }) => handlerKey(handler)), ...(impact.changedEntrypoints ?? []).map(({ handler }) => handlerKey(handler))]);
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

function compareSite(a: CallSite, b: CallSite): number {
  return compareText(a.file, b.file) || a.line - b.line || compareText(a.symbol, b.symbol);
}

function compareLink(a: ImpactedLink, b: ImpactedLink): number {
  return compareText(a.link.from.repo, b.link.from.repo) || compareText(a.link.from.file, b.link.from.file) || a.link.from.line - b.link.from.line || compareText(a.link.id, b.link.id);
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
