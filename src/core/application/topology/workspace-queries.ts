import { contentFingerprint, exportCuts } from "../../domain/map/entrypoint-map.ts";
import { incompleteSectionCuts, provenanceOf, withCuts, type Cut, type DeclaredScope, type Fact, type Finding, type FactBase, type TrustMode, type UnknownFact } from "../../domain/shared/fact.ts";
import { compositeBase } from "../../domain/topology/composite-inputs.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { Result } from "../../domain/shared/result.ts";
import { pathSelection, type PathSelection } from "../../domain/shared/scope.ts";
import { gatherCandidates, gatherNames, sortEvidence, type NameCandidate, type OutwardName, type RepositoryOutwardName } from "../../domain/topology/outward-name.ts";
import { directoryNameOf } from "../../domain/topology/repository-identity.ts";
import type { JoinedSite } from "../../domain/topology/link-graph.ts";
import { entrypointsOf, joinWorkspace, linkMapOf } from "./workspace-join.ts";
import type { HeadReaderDeps, HeldLive } from "../snapshot/head-reading.ts";
import type { WorkspaceReadOperation } from "./workspace-operation.ts";
import { callSiteEvidence, unresolvedCallSite, type CallSite, type CallSiteReader } from "../../domain/topology/call-site.ts";
import { nameCandidates, repositoryNameOf, type RepositoryIdentity } from "../../domain/topology/repository-identity.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { PathMatcher } from "../../ports/path-matcher.port.ts";
import type { RemoteRefresh } from "../../ports/remote-refresh.port.ts";
import type { WorkspaceDefaults } from "../../ports/workspace-defaults.port.ts";
import type { WorkspaceEvidence } from "../../ports/workspace-evidence.port.ts";
import type { WorkspaceFault, WorkspaceRepository, WorkspaceSection } from "../../ports/workspace-repos.port.ts";
import type { WorkspaceQueries, WorkspaceRead, WorkspaceRequest, WorkspaceValue } from "../../ports/workspace-queries.port.ts";
import { ABORTED, declaredTrustOf, factBaseOf, withScratch, type SnapshotReaderDeps } from "../snapshot/read-snapshot.ts";
import type { ReadSource, WorkspacePlanningRequest } from "./workspace-plan.ts";
import { withWorkspaceSnapshots, type WorkspaceSnapshotContext } from "./workspace-snapshots.ts";
import type { SnapshotPreparation } from "../snapshot/read-snapshot.ts";
import { prepareCommit } from "../snapshot/prepared-snapshot.ts";

export interface WorkspaceQueriesDeps extends SnapshotReaderDeps {
  graph?: HeadReaderDeps["graph"];
  live?: HeadReaderDeps["live"];
  matcher: PathMatcher;
  evidence: WorkspaceEvidence;
  callSites: CallSiteReader;
  engines: Readonly<Record<string, string>>;
  /** The workspace the bound repository persists, which a request naming no repositories works over. */
  defaults?: WorkspaceDefaults;
  /** Refreshes a trusted repository's declared remote before the read; absent leaves every repository local. */
  refresh?: RemoteRefresh;
}

interface ReadRepository {
  repository: WorkspaceRepository;
  source: string;
  base: FactBase;
  /** What the sources and the build state; the names of the call sites join them once those are read. */
  stated: readonly OutwardName[];
  sources: readonly SourceFile[];
  identity: RepositoryIdentity;
  cuts: readonly Cut[];
}

interface Resolved extends ReadRepository {
  names: readonly OutwardName[];
  callSites: readonly CallSite[];
}

export function createWorkspaceReadOperation(deps: WorkspaceQueriesDeps): WorkspaceReadOperation {
  const { vcs, matcher } = deps;

  async function readRepository(at: ReadSource, selection: PathSelection, scope: DeclaredScope, signal: AbortSignal | undefined, preparation: SnapshotPreparation): Promise<Result<ReadRepository, WorkspaceFault>> {
    const { repoId, source, declared } = at;
    const remotes = await vcs.remotes(declared, signal);
    if (!remotes.ok) return remotes;
    const sha = at.revision;
    return withScratch(deps.scratch, async (directory) => {
      const declaredTrust = await declaredTrustOf(deps, declared);
      const trust = declaredTrust ?? "untrusted";
      const prepared = await prepareCommit({ ...deps, preparation }, source, sha, directory, selection, { scope, trust }, signal);
      if (!prepared.ok) return prepared;
      const extracted = await prepared.value.extract(signal);
      if (!extracted.ok) return extracted;
      const { export: snapshotExport, findings, sources } = extracted.value;
      const selected = pathSelection(scope, matcher.matches);
      const selectedSources = sources.filter(({ path }) => selected(path));
      const base = factBaseOf(deps, {
        repoId,
        sha,
        trust,
        scope,
        content: JSON.stringify({ export: contentFingerprint(snapshotExport), declaredTrust: declaredTrust ?? null, remotes: remotes.value.map(({ name, url }) => ({ name, repository: repositoryNameOf(url) })).toSorted((a, b) => compareText(a.name, b.name) || compareText(a.repository ?? "", b.repository ?? "")) }),
        declaredConfig: deps.budget === undefined ? {} : { exportBudget: deps.budget },
        engines: deps.engines,
      });
      return {
        ok: true,
        value: {
          repository: { repo: repoId, snapshot: base.snapshot, entrypoints: selectedFindings(findings, selected), callSites: [], ...(declaredTrust === undefined ? {} : { declaredTrust }) },
          source,
          base,
          stated: deps.evidence.names(selectedSources),
          sources,
          cuts: exportCuts(snapshotExport),
          identity: {
            repo: repoId,
            id: repoId,
            artifacts: deps.evidence.artifacts(selectedSources),
            remotes: remotes.value.map((remote) => ({ remote: remote.name, repository: repositoryNameOf(remote.url) })),
            evidence: remotes.value.map((remote) => ({ path: ".git/config", line: 1, via: remote.name })),
          },
        },
      };
    });
  }

  async function readLive(at: HeldLive, declared: string, signal: AbortSignal | undefined): Promise<Result<ReadRepository, WorkspaceFault>> {
    const remotes = await vcs.remotes(declared, signal);
    if (signal?.aborted) return ABORTED;
    if (!remotes.ok) return remotes;
    const extracted = await at.extract(signal);
    if (!extracted.ok) return extracted;
    const { export: snapshotExport, findings, sources } = extracted.value;
    const scope = at.scope;
    const selected = pathSelection(scope, matcher.matches);
    const selectedSources = sources.filter(({ path }) => selected(path));
    const snapshot = { repo: at.repoId, kind: "live" as const, head: at.head, stateId: at.tree.stateId };
    const base = { ...factBaseOf(deps, { repoId: at.repoId, sha: at.head, trust: at.trust, scope, content: JSON.stringify({ export: contentFingerprint(snapshotExport), declaredTrust: at.trust, remotes: remotes.value.map(({ name, url }) => ({ name, repository: repositoryNameOf(url) })).toSorted((a, b) => compareText(a.name, b.name) || compareText(a.repository ?? "", b.repository ?? "")) }), declaredConfig: deps.budget === undefined ? {} : { exportBudget: deps.budget }, engines: deps.engines }), snapshot };
    return { ok: true, value: {
      repository: { repo: at.repoId, snapshot, entrypoints: selectedFindings(findings, selected), callSites: [], declaredTrust: at.trust },
      source: declared, base, stated: deps.evidence.names(selectedSources), sources, cuts: exportCuts(snapshotExport),
      identity: { repo: at.repoId, id: at.repoId, artifacts: deps.evidence.artifacts(selectedSources), remotes: remotes.value.map((remote) => ({ remote: remote.name, repository: repositoryNameOf(remote.url) })), evidence: remotes.value.map((remote) => ({ path: ".git/config", line: 1, via: remote.name })) },
    } };
  }

  /**
   * The call sites and the entrypoints of each repository. A repository that depends on another one given, by the
   * artifact or name the dependency states, reads the calls it makes through that repository's classes, and the
   * listeners it inherits from them, with its sources.
   */
  async function withDependencies(read: readonly ReadRepository[], identities: readonly RepositoryIdentity[], selected: PathSelection): Promise<Resolved[]> {
    const resolved: Resolved[] = [];
    for (const entry of read) {
      const libraries = read.filter(
        (other) => other !== entry && entry.stated.some((name) => name.kind === "dependency" && nameCandidates(name, identities, entry.repository.repo).some((candidate) => candidate.repo === other.identity.id)),
      );
      const librarySources = libraries.flatMap((library) => library.sources);
      const callSites = (await deps.callSites.of(entry.sources, entry.repository.repo, librarySources)).filter((site) => selected(site.file));
      const entrypoints = librarySources.length === 0 ? entry.repository.entrypoints : selectedFindings(await deps.extractor.extract(entry.sources, librarySources), selected);
      resolved.push({ ...entry, repository: { ...entry.repository, entrypoints }, callSites, names: [...entry.stated, ...callSiteNames(entry.repository.repo, callSites)] });
    }
    return resolved;
  }

  return {
    async withRead<T, F>(request: WorkspacePlanningRequest, use: (read: WorkspaceRead, context: WorkspaceSnapshotContext) => Promise<Result<T, F>>) {
      return withWorkspaceSnapshots<T, WorkspaceFault | F>(deps, request, async (context) => {
        const { plan, plans, livePlans, liveCaptures, scope, selection, preparation, signal } = context;
        const { asked, ids, membership, declaration, refresh } = plan;
        const read: ReadRepository[] = [];
        const unavailable: { repoId: string; sha: string }[] = [];
        for (const plan of plans) {
          const repoId = plan.kind === "read" ? plan.at.repoId : plan.repoId;
          if (plan.kind === "unavailable") {
            unavailable.push({ repoId, sha: plan.sha });
            continue;
          }
          const result = await readRepository(plan.at, selection, scope, signal, preparation);
          if (result.ok) {
            read.push(result.value);
            continue;
          }
          if (plan.at.pinnedSha !== undefined && result.fault.kind === "unknown-revision") {
            unavailable.push({ repoId, sha: plan.at.pinnedSha });
            continue;
          }
          return result;
        }

        for (const plan of livePlans) {
          const result = await readLive(liveCaptures.get(plan.repoId)!, plan.declared, signal);
          if (!result.ok) return result;
          read.push(result.value);
        }
        const trigger = read.find((entry) => entry.repository.repo === (request.repo.id ?? directoryNameOf(request.repo.path)));
        if (trigger === undefined) return { ok: false, fault: { kind: "git-failed", detail: "a workspace request names no repository" } };

        const identities = read.map((entry) => entry.identity);
        const resolved = await withDependencies(read, identities, pathSelection(scope, matcher.matches));
        const repositories = resolved.map((entry) => ({ ...entry.repository, callSites: entry.callSites })).sort((a, b) => compareText(a.repo, b.repo));
        const join = joinWorkspace(repositories, repositories.map(entrypointsOf), membership.gateways);
        const listened = destinationCandidates(join.joined);
        const sections: Record<string, Fact<WorkspaceSection>> = Object.create(null);
        const candidates: NameCandidate[] = [];
        const unserved: RepositoryOutwardName[] = [];
        for (const entry of resolved) {
          const names = gatherNames(entry.names);
          const unresolved = entry.callSites.flatMap((site) => (site.target.status === "unknown" ? [unresolvedCallSite(site)] : []));
          const ambiguous = join.joined.filter(({ site, joined }) => site.repo === entry.repository.repo && joined.ambiguous !== undefined).map(({ site }) => site);
          const section: FactBase & { evidence: readonly { path: string; line: number }[] } = { ...(entry.base as FactBase), evidence: sortEvidence(names.flatMap((name) => name.evidence)) };
          const cuts = [
            ...entry.cuts,
            ...unresolved.map((place) => ({ kind: "unresolved-link" as const, at: [place.path, `${place.path}:${place.line}`, ...(place.via === undefined ? [] : [`library ${place.via}`])] })),
            ...ambiguous.map((site) => ({ kind: "unresolved-link" as const, at: [site.file, `${site.file}:${site.line}`] })),
          ];
          sections[entry.repository.repo] = withCuts(section, { names, unresolved }, cuts);
          for (const name of names) {
            const served = [...nameCandidates(name, identities, entry.repository.repo), ...(name.kind === "destination" ? listened.get(`${entry.repository.repo}\0${name.name}`) ?? [] : [])];
            if (served.length === 0) unserved.push({ ...name, evidence: name.evidence.map((place) => ({ ...place, repo: entry.repository.repo })) });
            candidates.push(...served);
          }
        }
        for (const entry of unavailable) sections[entry.repoId] = unavailableSection(deps, entry.repoId, entry.sha, scope);

        const value: WorkspaceValue = {
          workspace: {
            repos: [...resolved.map((entry) => entry.repository.repo), ...unavailable.map((entry) => entry.repoId)].sort(compareText),
            gateways: join.gateways,
            source: membership.source,
          },
          repositorySnapshots: resolved.map((entry) => ({ repo: entry.repository.repo, snapshot: entry.repository.snapshot })).sort((a, b) => compareText(a.repo, b.repo)),
          sections: Object.fromEntries(Object.entries(sections).sort(([a], [b]) => compareText(a, b))),
          candidates: gatherCandidates(candidates),
          unserved: gatherNames(unserved),
          ...linkMapOf(join.joined),
          repositories,
        };
        const declared = { repos: value.workspace.repos, gateways: [...membership.gateways].sort((a, b) => compareText(a.prefix, b.prefix)), source: value.workspace.source };
        const base = compositeBase({ ...trigger.base, evidence: [] }, Object.entries(value.sections).map(([repo, section]) => ({ kind: `discovery:${repo}`, fact: provenanceOf(section) })), declared, (text) => deps.digest.of(text));
        const fact = composite(base, value);
        const repositoryRoots = asked.map((repository, index) => ({ repo: ids[index]!, path: repository.path })).toSorted((a, b) => compareText(a.repo, b.repo));
        const repositorySources = resolved.map(({ repository, source }) => ({ repo: repository.repo, path: source })).toSorted((a, b) => compareText(a.repo, b.repo));
        const snapshots = [
          ...resolved.map(({ repository }) => repository.snapshot),
          ...unavailable.map(({ repoId, sha }) => ({ repo: repoId, kind: "sha" as const, sha })),
        ].toSorted((a, b) => compareText(a.repo, b.repo));
        const workspaceReplay = declaration === undefined ? undefined : { version: 1 as const, declaration, snapshots };
        return use({ fact, ...(workspaceReplay === undefined ? {} : { workspaceReplay }), repositoryRoots, repositorySources, ...(refresh === undefined ? {} : { refresh: refresh }) }, context);
      });
    },
  };
}

export function createWorkspaceQueries(deps: WorkspaceQueriesDeps, operation = createWorkspaceReadOperation(deps)): WorkspaceQueries {
  return { async outwardNames(request: WorkspaceRequest) {
    if (request.signal?.aborted) return ABORTED;
    const result = await operation.withRead(request, async (read) => ({ ok: true, value: read }));
    if (!result.ok) return result;
    return { ok: true, value: { ...result.value.value, ...(result.value.workspaceReplay === undefined ? {} : { workspaceReplay: result.value.workspaceReplay }), ...(result.value.workspaceLive === undefined ? {} : { workspaceLive: result.value.workspaceLive }) } };
  } };
}

/**
 * A repository the refresh pinned a revision for and no copy holds: its section says so, and it names the sha the
 * snapshot stands for. No content was read, so the content digest stands for none.
 */
function unavailableSection(deps: WorkspaceQueriesDeps, repoId: string, sha: string, scope: DeclaredScope): UnknownFact {
  const trust: TrustMode = "trusted";
  return { ...factBaseOf(deps, { repoId, sha, trust, scope, content: "", declaredConfig: deps.budget === undefined ? {} : { exportBudget: deps.budget }, engines: deps.engines }), status: "unknown", reason: "revision-unavailable" };
}

/**
 * The names a repository's call sites state about the world outside it: the base URL a call declares, the first path
 * segment it targets, which is the prefix a gateway routes, and the destination a message is published to. A parameter
 * or the bare root states nothing.
 */
function callSiteNames(repo: string, callSites: readonly CallSite[]): OutwardName[] {
  return callSites.flatMap((site): OutwardName[] => {
    if (site.target.status !== "complete") return [];
    if ("destination" in site.target.value) return [{ name: site.target.value.destination, kind: "destination", evidence: [callSiteEvidence(site)] }];
    const { base, path } = site.target.value;
    const evidence = [callSiteEvidence(site)];
    const prefix = path.split("/").find((segment) => segment !== "");
    return [...(base === undefined ? [] : [{ name: base, kind: "http-host" as const, evidence }]), ...(prefix === undefined || prefix === "{}" ? [] : [{ name: prefix, kind: "path-prefix" as const, evidence }])];
  });
}

/**
 * Per publishing repository and destination, the repositories that listen to it as the join decided: the one a link
 * lands in, with the call site and the handler as evidence, or each one an ambiguous destination names, with the call site.
 */
function destinationCandidates(joined: readonly JoinedSite[]): Map<string, NameCandidate[]> {
  const listened = new Map<string, NameCandidate[]>();
  for (const { site, joined: answer } of joined) {
    if (site.target.status !== "complete" || !("destination" in site.target.value)) continue;
    const name = site.target.value.destination;
    const published = { ...callSiteEvidence(site), repo: site.repo };
    const served = answer.links !== undefined
      ? answer.links.map(({ to }) => ({ name, repo: to.repo, basis: "event-destination" as const, evidence: sortEvidence([published, { path: to.handler.path, line: to.handler.line, repo: to.repo }]) }))
      : (answer.ambiguous?.repos ?? []).map((repo) => ({ name, repo, basis: "event-destination" as const, evidence: [published] }));
    const key = `${site.repo}\0${name}`;
    listened.set(key, gatherCandidates([...(listened.get(key) ?? []), ...served]));
  }
  return listened;
}

/** The composite of the sections, with the whole value beside them: complete only when every section is. */
function composite(base: FactBase, value: WorkspaceValue): Fact<WorkspaceValue> {
  const [first, ...rest] = incompleteSectionCuts(value.sections) as [Cut, ...Cut[]] | [];
  return first === undefined ? { ...base, status: "complete", value } : { ...base, status: "partial", value, cuts: [first, ...rest] };
}

function selectedFindings<T>(findings: readonly Finding<T>[], selected: PathSelection): Finding<T>[] {
  return findings.filter((finding) => finding.evidence.length === 0 || finding.evidence.some(({ path }) => selected(path)));
}
