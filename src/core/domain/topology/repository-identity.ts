import { compareText } from "../shared/code-node.ts";
import type { Evidence } from "../shared/fact.ts";
import { serviceLabel, sortEvidence, type NameCandidate, type OutwardName } from "./outward-name.ts";

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
 * agent confirms is still a fact about a name. A destination is never compared with an identity: the join decides who listens.
 */
export function nameCandidates(name: OutwardName, identities: readonly RepositoryIdentity[], sourceRepo: string): NameCandidate[] {
  const label = serviceLabel(name);
  if (label === "" || name.kind === "destination") return [];
  return identities
    .flatMap((identity): NameCandidate[] => {
      for (const basis of BASES) {
        const matched = recognizedBy(identity, basis).filter((recognition) => recognition.value === label);
        if (matched.length > 0) {
          return [{ name: name.name, repo: identity.id, basis, evidence: sortEvidence([...name.evidence.map((place) => ({ ...place, repo: sourceRepo })), ...matched.flatMap((recognition) => recognition.evidence.map((place) => ({ ...place, repo: identity.repo })))]) }];
        }
      }
      return [];
    })
    .sort((a, b) => compareText(a.repo, b.repo) || compareText(a.basis, b.basis));
}

function recognizedBy(identity: RepositoryIdentity, basis: (typeof BASES)[number]): readonly Recognition[] {
  switch (basis) {
    case "exact-name":
      return [{ value: identity.id, evidence: identity.evidence }];
    case "artifact":
      return identity.artifacts.map((coordinate) => ({ value: lastSegmentOf(coordinate), evidence: identity.evidence }));
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
