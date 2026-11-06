import { compareText } from "../shared/code-node.ts";
import type { Cut, Evidence } from "../shared/fact.ts";
import { gatherNames, serviceLabel, sortEvidence, type NameCandidate, type OutwardName } from "./outward-name.ts";

/** A remote a repository states: the name it answers to in its own configuration, and the repository name its URL ends with. */
export interface RepositoryRemote {
  /** The remote's name in the clone's configuration: `origin`, `upstream`. */
  remote: string;
  /** The repository name the remote's URL ends with: the last segment of `host/owner/name`, without `.git`. */
  repository: string;
}

/** What a repository can be recognized by: the name it is known under, the artifacts its build declares, its remotes. */
export interface RepositoryIdentity {
  repo: string;
  /** The name the workspace and the repository's snapshot use: its directory name unless the caller names another. */
  id: string;
  /** The coordinates the repository's own build declares: a Maven `groupId:artifactId`, an npm package name. */
  artifacts: readonly string[];
  /** Every remote the clone states, so a name it carries is cited by the remote that carries it and no other. */
  remotes: readonly RepositoryRemote[];
  evidence: readonly Evidence[];
}

const BASES = ["exact-name", "artifact", "remote"] as const;

/** One value a repository states for a basis, with the places that state it. */
interface Recognition {
  value: string;
  evidence: readonly Evidence[];
}

/**
 * The local repositories that serve a name, strongest basis first. A name equal to a repository's id is `exact-name`; one
 * equal to a coordinate or to the tail of a remote is `artifact` or `remote`. Nothing weaker is reported: a candidate the
 * agent confirms is still a fact about a name. A Maven dependency requires its declared coordinates to match first.
 * A destination is never compared with an identity: the join decides who listens.
 */
export function nameCandidates(name: OutwardName, identities: readonly RepositoryIdentity[], sourceRepo: string): NameCandidate[] {
  const label = serviceLabel(name);
  const maven = isMavenDependency(name);
  if (maven && !literalMavenCoordinate(label)) return [];
  if (label === "" || name.kind === "destination") return [];
  return identities
    .flatMap((identity): NameCandidate[] => {
      if (maven && !identity.artifacts.includes(label)) return [];
      for (const basis of BASES) {
        const compared = maven && basis !== "artifact" ? lastSegmentOf(label) : label;
        const matched = recognizedBy(identity, basis, maven).filter((recognition) => recognition.value === compared);
        if (matched.length > 0) {
          return [{ name: name.name, repo: identity.id, basis, evidence: sortEvidence([...name.evidence.map((place) => ({ ...place, repo: sourceRepo })), ...matched.flatMap((recognition) => recognition.evidence.map((place) => ({ ...place, repo: identity.repo })))]) }];
        }
      }
      return [];
    })
    .sort((a, b) => compareText(a.repo, b.repo) || compareText(a.basis, b.basis));
}

export type DependencySelection =
  | { status: "selected"; repo: string }
  | { status: "unserved" }
  | { status: "unresolved"; diagnostic: NonNullable<Cut["dependency"]> };

export function selectDependency(name: OutwardName, identities: readonly RepositoryIdentity[], sourceRepo: string): DependencySelection {
  const available = identities.filter((identity) => identity.repo !== sourceRepo);
  const maven = isMavenDependency(name);
  const coordinate = maven ? serviceLabel(name) : name.name;
  const candidates = nameCandidates(name, available, sourceRepo);
  const proven = available.filter((identity) => identity.artifacts.includes(coordinate)
    && (maven ? literalMavenCoordinate(coordinate) : candidates.some((candidate) => candidate.repo === identity.id)));
  const first = proven[0];
  if (proven.length === 1 && first !== undefined) return { status: "selected", repo: first.id };
  const label = lastSegmentOf(coordinate);
  const plausible = maven ? available.filter((identity) => {
    if (literalMavenCoordinate(coordinate) && identity.artifacts.some((coordinate) => literalMavenCoordinate(coordinate) && lastSegmentOf(coordinate) === label)) return false;
    return identity.id === coordinate || identity.id === label || identity.remotes.some((remote) => remote.repository === label) || identity.artifacts.some((coordinate) => lastSegmentOf(coordinate) === label);
  }).map((identity) => identity.id) : candidates.map((candidate) => candidate.repo);
  const repos = (proven.length > 1 ? proven.map((identity) => identity.id) : plausible).sort(compareText);
  return repos.length === 0 ? { status: "unserved" } : {
    status: "unresolved",
    diagnostic: { name: name.name, reason: proven.length > 1 ? "ambiguous" : "unproven-coordinates", candidates: repos },
  };
}

export interface DependencyClosure {
  repositories: readonly string[];
  transitive: boolean;
  unresolved: readonly { repo: string; name: OutwardName; diagnostic: NonNullable<Cut["dependency"]> }[];
}

export function dependencyClosures(repositories: readonly { identity: RepositoryIdentity; names: readonly OutwardName[] }[]): ReadonlyMap<string, DependencyClosure> {
  const identities = repositories.map(({ identity }) => identity);
  const graph = new Map(repositories.map(({ identity, names }) => [identity.id, gatherNames(names).filter((name) => name.kind === "dependency").map((name) => ({ name, selection: selectDependency(name, identities, identity.repo) }))]));
  const closures = new Map<string, DependencyClosure>();
  for (const root of [...graph.keys()].sort(compareText)) {
    const direct = new Set(graph.get(root)!.flatMap(({ selection }) => selection.status === "selected" ? [selection.repo] : []));
    const visited = new Set([root]);
    const pending = [root];
    const unresolved: DependencyClosure["unresolved"][number][] = [];
    for (const repo of pending) {
      for (const { name, selection } of graph.get(repo)!) {
        if (selection.status === "unresolved") unresolved.push({ repo, name, diagnostic: selection.diagnostic });
        if (selection.status !== "selected" || visited.has(selection.repo)) continue;
        visited.add(selection.repo);
        pending.push(selection.repo);
      }
    }
    const reached = [...visited].filter((repo) => repo !== root).sort(compareText);
    closures.set(root, { repositories: reached, transitive: reached.some((repo) => !direct.has(repo)), unresolved: unresolved.sort((a, b) => compareText(a.repo, b.repo) || compareText(a.name.name, b.name.name)) });
  }
  return closures;
}

function isMavenDependency(name: OutwardName): boolean {
  return name.kind === "dependency" && (name.name.includes(":") || name.evidence.some(({ path }) => path.split("/").at(-1) === "pom.xml"));
}

function literalMavenCoordinate(name: string): boolean {
  const parts = name.split(":");
  return parts.length === 2 && parts.every((part) => part !== "" && !part.includes("${"));
}

function recognizedBy(identity: RepositoryIdentity, basis: (typeof BASES)[number], maven = false): readonly Recognition[] {
  switch (basis) {
    case "exact-name":
      return [{ value: identity.id, evidence: identity.evidence }];
    case "artifact":
      return identity.artifacts.map((coordinate) => ({ value: maven ? coordinate : lastSegmentOf(coordinate), evidence: identity.evidence }));
    case "remote":
      return identity.remotes.map(({ remote, repository }) => ({ value: repository, evidence: identity.evidence.filter((place) => place.via === remote) }));
  }
}

function lastSegmentOf(coordinate: string): string {
  return coordinate.split(/[:/]/).filter(Boolean).pop() ?? coordinate;
}

/** The last segment of a path, with either separator and any trailing one: the directory a repository root ends in. */
export function directoryNameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}

/** The repository name a remote URL ends with, without its `.git` suffix: `host/owner/name` names `name`. */
export function repositoryNameOf(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0] ?? url;
  return lastSegmentOf(withoutQuery).replace(/\.git$/i, "");
}
