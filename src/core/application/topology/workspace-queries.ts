import { contentFingerprint, declaredScope } from "../../domain/map/entrypoint-map.ts";
import { incompleteSectionCuts, type Cut, type Fact, type FactBase, type TrustMode, type UnknownFact } from "../../domain/shared/fact.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { Result } from "../../domain/shared/result.ts";
import { pathSelection, type PathSelection } from "../../domain/shared/scope.ts";
import { gatherCandidates, gatherNames, sortEvidence, type NameCandidate, type OutwardName } from "../../domain/topology/outward-name.ts";
import { callSiteEvidence, unresolvedPlace, type CallSite, type CallSiteReader } from "../../domain/topology/call-site.ts";
import { directoryNameOf, nameCandidates, repositoryNameOf, type RepositoryIdentity } from "../../domain/topology/repository-identity.ts";
import { resolveRemoteSnapshot, type RemoteFreshness, type RepositoryResolution } from "../../domain/topology/remote-snapshot.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { PathMatcher } from "../../ports/path-matcher.port.ts";
import type { RemoteRefresh } from "../../ports/remote-refresh.port.ts";
import { DEFAULT_REVISION, type VcsFault } from "../../ports/vcs.port.ts";
import type { WorkspaceDefaults } from "../../ports/workspace-defaults.port.ts";
import type { WorkspaceEvidence } from "../../ports/workspace-evidence.port.ts";
import type { WorkspaceFault, WorkspaceRepository, WorkspaceRepositoryRequest, WorkspaceSection } from "../../ports/workspace-repos.port.ts";
import type { WorkspaceQueries, WorkspaceRead, WorkspaceRefresh, WorkspaceRequest, WorkspaceValue } from "../../ports/workspace-queries.port.ts";
import { declaredTrustOf, extractCommit, factBaseOf, trustOf, withScratch, type SnapshotReaderDeps } from "../snapshot/read-snapshot.ts";
import { workspaceInForce } from "./workspace-defaults.ts";

export interface WorkspaceQueriesDeps extends SnapshotReaderDeps {
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
  base: FactBase;
  /** What the sources and the build state; the names of the call sites join them once those are read. */
  stated: readonly OutwardName[];
  sources: readonly SourceFile[];
  identity: RepositoryIdentity;
}

interface Resolved extends ReadRepository {
  names: readonly OutwardName[];
  callSites: readonly CallSite[];
}

/** Where one repository's commit is read, and where its remotes and trust are declared. */
interface ReadSource {
  /** The declared clone, or the mirror that holds the pinned sha. */
  source: string;
  /** The repository the request named; remotes and trust never come from a mirror. */
  declared: string;
  repoId: string;
  revision: string;
  /** The sha a refresh pinned, so a mirror that lacks it answers an unknown section instead of a fault. */
  pinnedSha?: string;
}

/** What a refresh pinned for one repository: a mirror to read, or the sha no copy holds. */
type Pin = { kind: "read"; mirror: string; sha: string } | { kind: "unavailable"; sha: string };

/** How one repository of the request is read: its clone, a mirror, or no copy of the revision at all. */
type Plan = { kind: "read"; at: ReadSource } | { kind: "unavailable"; repoId: string; sha: string };

interface Refreshed {
  pins: ReadonlyMap<string, Pin>;
  refresh?: WorkspaceRefresh;
}

interface Candidate {
  declaration: WorkspaceRepositoryRequest;
  repoId: string;
  url: string;
  /** The declared clone, present only when its `origin` is the declared remote: the mirror may be seeded from it. */
  seed?: string;
}

const ORIGIN = "origin";

export function createWorkspaceQueries(deps: WorkspaceQueriesDeps): WorkspaceQueries {
  const { vcs, matcher } = deps;

  async function readRepository(at: ReadSource, scope: PathSelection, signal: AbortSignal | undefined): Promise<Result<ReadRepository, WorkspaceFault>> {
    const { repoId, source, declared } = at;
    const resolved = await vcs.resolveCommit(source, at.revision, signal);
    if (!resolved.ok) return resolved;
    const remotes = await vcs.remotes(declared, signal);
    if (!remotes.ok) return remotes;
    const sha = resolved.value;
    return withScratch(deps.scratch, async (directory) => {
      const extracted = await extractCommit(deps, source, sha, await directory(), scope, signal);
      if (!extracted.ok) return extracted;
      const { export: snapshotExport, findings, sources } = extracted.value;
      const declaredTrust = await declaredTrustOf(deps, declared);
      const base = factBaseOf(deps, {
        repoId,
        sha,
        trust: await trustOf(deps, declared),
        scope: declaredScope(),
        content: contentFingerprint(snapshotExport),
        declaredConfig: {},
        engines: deps.engines,
      });
      return {
        ok: true,
        value: {
          repository: { repo: repoId, path: source, snapshot: base.snapshot, entrypoints: findings, callSites: [], ...(declaredTrust === undefined ? {} : { declaredTrust }) },
          base,
          stated: deps.evidence.names(sources),
          sources,
          identity: {
            repo: repoId,
            id: repoId,
            artifacts: deps.evidence.artifacts(sources),
            remotes: remotes.value.map((remote) => ({ remote: remote.name, repository: repositoryNameOf(remote.url) })),
            evidence: remotes.value.map((remote) => ({ path: ".git/config", line: 1, via: remote.name })),
          },
        },
      };
    });
  }

  /**
   * Refreshes the declared remote of every trusted repository beside the trigger, once for all of them, and resolves the
   * sha each one is read at. The trigger is read locally and never refreshed; a repository that declares no remote, or
   * whose record is not `trusted`, never reaches the network.
   */
  async function refreshRemotes(repositories: readonly WorkspaceRepositoryRequest[], trigger: WorkspaceRepositoryRequest, offline: boolean, signal: AbortSignal | undefined): Promise<Result<Refreshed, WorkspaceFault>> {
    const local: Refreshed = { pins: new Map() };
    const { refresh } = deps;
    if (refresh === undefined || offline) return { ok: true, value: local };

    const candidates: Candidate[] = [];
    for (const declaration of repositories) {
      if (declaration.remote === undefined) continue;
      if ((await trustOf(deps, declaration.path)) !== "trusted") continue;
      const remotes = await vcs.remotes(declaration.path, signal);
      if (!remotes.ok) return remotes;
      const origin = remotes.value.find((remote) => remote.name === ORIGIN && remote.url === declaration.remote);
      candidates.push({ declaration, repoId: declaration.id ?? directoryNameOf(declaration.path), url: declaration.remote, ...(origin === undefined ? {} : { seed: declaration.path }) });
    }
    if (candidates.length === 0) return { ok: true, value: local };

    const line = await triggerLine(trigger, signal);
    if (!line.ok) return line;
    const answers = await refresh.refresh(candidates.map(({ url, seed }) => ({ url, ...(seed === undefined ? {} : { seed }) })), signal);
    const byUrl = new Map(answers.map((answer) => [answer.url, answer]));
    const pins = new Map<string, Pin>();
    const resolution: RepositoryResolution[] = [];
    const freshness: { repo: string; url: string; freshness: RemoteFreshness }[] = [];
    for (const candidate of candidates) {
      const answer = byUrl.get(candidate.url);
      if (answer === undefined) return { ok: false, fault: { kind: "git-failed", detail: "the refresh answered nothing for a declared remote" } };
      const pinned = resolveRemoteSnapshot(candidate.repoId, candidate.declaration.revision, line.value, answer.listing ?? { branches: [] });
      resolution.push(pinned);
      freshness.push({ repo: candidate.repoId, url: candidate.url, freshness: answer.freshness });
      if (pinned.sha !== undefined && answer.mirror !== undefined) {
        pins.set(candidate.repoId, { kind: "read", mirror: answer.mirror, sha: pinned.sha });
        continue;
      }
      let snapshot = pinned.sha;
      if (snapshot === undefined) {
        const revision = await vcs.resolveCommit(candidate.declaration.path, candidate.declaration.revision ?? DEFAULT_REVISION, signal);
        if (!revision.ok) return revision;
        snapshot = revision.value;
      }
      pins.set(candidate.repoId, { kind: "unavailable", sha: snapshot });
    }
    return {
      ok: true,
      value: {
        pins,
        refresh: {
          resolution: resolution.sort((a, b) => compareText(a.repo, b.repo)),
          freshness: freshness.sort((a, b) => compareText(a.repo, b.repo) || compareText(a.url, b.url)),
        },
      },
    };
  }

  /** The line the trigger is on: the revision the request names, or the branch its `HEAD` points at when it names HEAD or none. */
  async function triggerLine(trigger: WorkspaceRepositoryRequest, signal: AbortSignal | undefined): Promise<Result<string | undefined, VcsFault>> {
    return trigger.revision === undefined || trigger.revision === DEFAULT_REVISION ? vcs.headBranch(trigger.path, signal) : { ok: true, value: trigger.revision };
  }

  function planOf(declaration: WorkspaceRepositoryRequest, repoId: string, pin: Pin | undefined): Plan {
    if (pin === undefined) return { kind: "read", at: { source: declaration.path, declared: declaration.path, repoId, revision: declaration.revision ?? DEFAULT_REVISION } };
    if (pin.kind === "unavailable") return { kind: "unavailable", repoId, sha: pin.sha };
    return { kind: "read", at: { source: pin.mirror, declared: declaration.path, repoId, revision: pin.sha, pinnedSha: pin.sha } };
  }

  /**
   * The call sites of each repository. A repository that depends on another one given, by the artifact or name the
   * dependency states, reads the calls it makes through that repository's classes with its sources.
   */
  async function withCallSites(read: readonly ReadRepository[], identities: readonly RepositoryIdentity[]): Promise<Resolved[]> {
    const resolved: Resolved[] = [];
    for (const entry of read) {
      const libraries = read.filter(
        (other) => other !== entry && entry.stated.some((name) => name.kind === "dependency" && nameCandidates(name, identities).some((candidate) => candidate.repo === other.identity.id)),
      );
      const callSites = await deps.callSites.of(entry.sources, entry.repository.repo, libraries.flatMap((library) => library.sources));
      resolved.push({ ...entry, callSites, names: [...entry.stated, ...callSiteNames(entry.repository.repo, callSites)] });
    }
    return resolved;
  }

  return {
    async outwardNames(request: WorkspaceRequest) {
      const inForce = await workspaceInForce(request, deps.defaults);
      if (!inForce.ok) return inForce;
      const asked = [request.repo, ...inForce.value.repos];
      const ids = asked.map((repository) => repository.id ?? directoryNameOf(repository.path));
      const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
      if (duplicate !== undefined) return { ok: false, fault: { kind: "duplicate-repository", detail: duplicate } };

      const refreshed = await refreshRemotes(asked.slice(1), request.repo, request.offline === true, request.signal);
      if (!refreshed.ok) return refreshed;

      const scope = pathSelection(declaredScope(), matcher.matches);
      const read: ReadRepository[] = [];
      const unavailable: { repoId: string; sha: string }[] = [];
      for (const [index, declaration] of asked.entries()) {
        const repoId = ids[index]!;
        const plan = planOf(declaration, repoId, index === 0 ? undefined : refreshed.value.pins.get(repoId));
        if (plan.kind === "unavailable") {
          unavailable.push({ repoId, sha: plan.sha });
          continue;
        }
        const result = await readRepository(plan.at, scope, request.signal);
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

      const trigger = read[0];
      if (trigger === undefined) return { ok: false, fault: { kind: "git-failed", detail: "a workspace request names no repository" } };

      const identities = read.map((entry) => entry.identity);
      const resolved = await withCallSites(read, identities);
      const sections: Record<string, Fact<WorkspaceSection>> = {};
      const candidates: NameCandidate[] = [];
      const unserved: OutwardName[] = [];
      for (const entry of resolved) {
        const names = gatherNames(entry.names);
        const unresolved = entry.callSites.flatMap((site) => (site.target.status === "unknown" ? [unresolvedPlace(site)] : []));
        const section: FactBase & { evidence: readonly { path: string; line: number }[] } = { ...(entry.base as FactBase), evidence: sortEvidence(names.flatMap((name) => name.evidence)) };
        const cuts = unresolved.map((place) => ({ kind: "unresolved-link" as const, at: [place.path, `${place.path}:${place.line}`, ...(place.via === undefined ? [] : [`library ${place.via}`])] }));
        const [firstCut, ...restCuts] = cuts;
        sections[entry.repository.repo] =
          firstCut === undefined
            ? { ...section, status: "complete", value: { names, unresolved } }
            : { ...section, status: "partial", value: { names, unresolved }, cuts: [firstCut, ...restCuts] };
        for (const name of names) {
          const served = nameCandidates(name, identities);
          if (served.length === 0) unserved.push(name);
          candidates.push(...served);
        }
      }
      for (const entry of unavailable) sections[entry.repoId] = unavailableSection(deps, entry.repoId, entry.sha);

      const value: WorkspaceValue = {
        workspace: {
          repos: [...resolved.map((entry) => entry.repository.repo), ...unavailable.map((entry) => entry.repoId)].sort(compareText),
          gateways: [...inForce.value.gateways].sort((a, b) => compareText(a.prefix, b.prefix)),
          source: inForce.value.source,
        },
        repositorySnapshots: resolved.map((entry) => ({ repo: entry.repository.repo, snapshot: entry.repository.snapshot })).sort((a, b) => compareText(a.repo, b.repo)),
        sections: Object.fromEntries(Object.entries(sections).sort(([a], [b]) => compareText(a, b))),
        candidates: gatherCandidates(candidates),
        unserved: gatherNames(unserved),
        repositories: resolved.map((entry) => ({ ...entry.repository, callSites: entry.callSites })).sort((a, b) => compareText(a.repo, b.repo)),
      };
      const fact = composite({ ...trigger.base, evidence: [] }, value);
      return { ok: true, value: { fact, ...(refreshed.value.refresh === undefined ? {} : { refresh: refreshed.value.refresh }) } };
    },
  };
}

/**
 * A repository the refresh pinned a revision for and no copy holds: its section says so, and it names the sha the
 * snapshot stands for. No content was read, so the content digest stands for none.
 */
function unavailableSection(deps: WorkspaceQueriesDeps, repoId: string, sha: string): UnknownFact {
  const trust: TrustMode = "trusted";
  return { ...factBaseOf(deps, { repoId, sha, trust, scope: declaredScope(), content: "", declaredConfig: {}, engines: deps.engines }), status: "unknown", reason: "revision-unavailable" };
}

/**
 * The names a repository's call sites state about the world outside it: the base URL a call declares, and the first path
 * segment it targets, which is the prefix a gateway routes. A parameter or the bare root states nothing.
 */
function callSiteNames(repo: string, callSites: readonly CallSite[]): OutwardName[] {
  return callSites.flatMap((site): OutwardName[] => {
    if (site.target.status !== "complete" || !("path" in site.target.value)) return [];
    const { base, path } = site.target.value;
    const evidence = [callSiteEvidence(site)];
    const prefix = path.split("/").find((segment) => segment !== "");
    return [...(base === undefined ? [] : [{ name: base, kind: "http-host" as const, evidence }]), ...(prefix === undefined || prefix === "{}" ? [] : [{ name: prefix, kind: "path-prefix" as const, evidence }])];
  });
}

/** The composite of the sections, with the whole value beside them: complete only when every section is. */
function composite(base: FactBase, value: WorkspaceValue): Fact<WorkspaceValue> {
  const [first, ...rest] = incompleteSectionCuts(value.sections) as [Cut, ...Cut[]] | [];
  return first === undefined ? { ...base, status: "complete", value } : { ...base, status: "partial", value, cuts: [first, ...rest] };
}
