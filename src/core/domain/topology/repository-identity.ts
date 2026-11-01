import { compareText } from "../shared/code-node.ts";
import type { Evidence } from "../shared/fact.ts";
import { serviceLabel, sortEvidence, type NameCandidate, type OutwardName } from "./outward-name.ts";

/** What a repository can be recognized by: the name it is known under, the artifacts its build declares, its remotes. */
export interface RepositoryIdentity {
  repo: string;
  /** The name the workspace and the repository's snapshot use: its directory name unless the caller names another. */
  id: string;
  /** The coordinates the repository's own build declares: a Maven `groupId:artifactId`, an npm package name. */
  artifacts: readonly string[];
  /** The repository name each of its remotes ends with, without `.git`. */
  remotes: readonly string[];
  evidence: readonly Evidence[];
}

const BASES = ["exact-name", "artifact", "remote"] as const;

/**
 * The local repositories that serve a name, strongest basis first. A name equal to a repository's id is `exact-name`; one
 * equal to a coordinate or to the tail of a remote is `artifact` or `remote`. Nothing weaker is reported: a candidate the
 * agent confirms is still a fact about a name.
 */
export function nameCandidates(name: OutwardName, identities: readonly RepositoryIdentity[]): NameCandidate[] {
  const label = serviceLabel(name);
  if (label === "") return [];
  return identities
    .flatMap((identity): NameCandidate[] => {
      for (const basis of BASES) {
        if (recognizedBy(identity, basis).includes(label)) return [{ name: name.name, repo: identity.id, basis, evidence: [...sortEvidence(name.evidence), ...identity.evidence] }];
      }
      return [];
    })
    .sort((a, b) => compareText(a.repo, b.repo) || compareText(a.basis, b.basis));
}

function recognizedBy(identity: RepositoryIdentity, basis: (typeof BASES)[number]): readonly string[] {
  switch (basis) {
    case "exact-name":
      return [identity.id];
    case "artifact":
      return identity.artifacts.map((coordinate) => coordinate.split(/[:/]/).filter(Boolean).pop() ?? coordinate);
    case "remote":
      return identity.remotes;
  }
}

/** The last segment of a path, with either separator and any trailing one: the directory a repository root ends in. */
export function directoryNameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}

/** The repository name a remote URL ends with, without its `.git` suffix: `host/owner/name` names `name`. */
export function repositoryNameOf(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0] ?? url;
  const tail = withoutQuery.split(/[/:]/).filter(Boolean).pop() ?? "";
  return tail.replace(/\.git$/i, "");
}
