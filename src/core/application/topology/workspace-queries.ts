import { contentFingerprint, declaredScope } from "../../domain/map/entrypoint-map.ts";
import { incompleteSectionCuts, type Cut, type Fact, type FactBase } from "../../domain/shared/fact.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { Result } from "../../domain/shared/result.ts";
import { pathSelection, type PathSelection } from "../../domain/shared/scope.ts";
import { gatherNames, sortEvidence, compareCandidate, type NameCandidate, type OutwardName } from "../../domain/topology/outward-name.ts";
import { callSiteEvidence, unresolvedPlace, type CallSite, type CallSiteReader } from "../../domain/topology/call-site.ts";
import { directoryNameOf, nameCandidates, repositoryNameOf, type RepositoryIdentity } from "../../domain/topology/repository-identity.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { PathMatcher } from "../../ports/path-matcher.port.ts";
import type { WorkspaceEvidence } from "../../ports/workspace-evidence.port.ts";
import type { WorkspaceFault, WorkspaceRepository, WorkspaceRepositoryRequest, WorkspaceSection } from "../../ports/workspace-repos.port.ts";
import type { WorkspaceQueries, WorkspaceRequest, WorkspaceValue } from "../../ports/workspace-queries.port.ts";
import { extractCommit, factBaseOf, trustOf, withScratch, type SnapshotReaderDeps } from "../snapshot/read-snapshot.ts";

export interface WorkspaceQueriesDeps extends SnapshotReaderDeps {
  matcher: PathMatcher;
  evidence: WorkspaceEvidence;
  callSites: CallSiteReader;
  engines: Readonly<Record<string, string>>;
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

export function createWorkspaceQueries(deps: WorkspaceQueriesDeps): WorkspaceQueries {
  const { vcs, matcher } = deps;

  async function readRepository(request: WorkspaceRepositoryRequest, scope: PathSelection, signal: AbortSignal | undefined): Promise<Result<ReadRepository, WorkspaceFault>> {
    const repoId = request.id ?? directoryNameOf(request.path);
    const resolved = await vcs.resolveCommit(request.path, request.revision ?? "HEAD", signal);
    if (!resolved.ok) return resolved;
    const remotes = await vcs.remotes(request.path, signal);
    if (!remotes.ok) return remotes;
    const declared = declaredScope();
    const sha = resolved.value;
    return withScratch(deps.scratch, async (directory) => {
      const extracted = await extractCommit(deps, request.path, sha, await directory(), scope, signal);
      if (!extracted.ok) return extracted;
      const { export: snapshotExport, findings, sources } = extracted.value;
      const base = factBaseOf(deps, {
        repoId,
        sha,
        trust: await trustOf(deps, request.path),
        scope: declared,
        content: contentFingerprint(snapshotExport),
        declaredConfig: {},
        engines: deps.engines,
      });
      return {
        ok: true,
        value: {
          repository: { repo: repoId, path: request.path, snapshot: base.snapshot, entrypoints: findings, callSites: [] },
          base,
          stated: deps.evidence.names(sources),
          sources,
          identity: {
            repo: repoId,
            id: repoId,
            artifacts: deps.evidence.artifacts(sources),
            remotes: remotes.value.map((remote) => repositoryNameOf(remote.url)),
            evidence: remotes.value.map((remote) => ({ path: ".git/config", line: 1, via: remote.name })),
          },
        },
      };
    });
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
      const asked = [request.repo, ...(request.repos ?? [])];
      const ids = asked.map((repository) => repository.id ?? directoryNameOf(repository.path));
      const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
      if (duplicate !== undefined) return { ok: false, fault: { kind: "duplicate-repository", detail: duplicate } };

      const scope = pathSelection(declaredScope(), matcher.matches);
      const read: ReadRepository[] = [];
      for (const repository of asked) {
        const result = await readRepository(repository, scope, request.signal);
        if (!result.ok) return result;
        read.push(result.value);
      }

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

      const trigger = read[0];
      if (trigger === undefined) return { ok: false, fault: { kind: "git-failed", detail: "a workspace request names no repository" } };
      const value: WorkspaceValue = {
        workspace: { repos: resolved.map((entry) => entry.repository.repo).sort(compareText), gateways: [...(request.gateways ?? [])].sort((a, b) => compareText(a.prefix, b.prefix)) },
        repositorySnapshots: resolved.map((entry) => ({ repo: entry.repository.repo, snapshot: entry.repository.snapshot })).sort((a, b) => compareText(a.repo, b.repo)),
        sections: Object.fromEntries(Object.entries(sections).sort(([a], [b]) => compareText(a, b))),
        candidates: candidates.sort(compareCandidate),
        unserved: unserved.sort((a, b) => compareText(a.name, b.name) || compareText(a.kind, b.kind)),
        repositories: resolved.map((entry) => ({ ...entry.repository, callSites: entry.callSites })).sort((a, b) => compareText(a.repo, b.repo)),
      };
      return { ok: true, value: composite({ ...trigger.base, evidence: [] }, value) };
    },
  };
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
