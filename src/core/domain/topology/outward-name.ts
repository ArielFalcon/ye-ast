import { compareText } from "../shared/code-node.ts";
import type { Evidence } from "../shared/fact.ts";
import type { RepositoryEvidence } from "../shared/repository-evidence.ts";
import { canonicalJson } from "../shared/canonical-json.ts";

/**
 * What a repository states about the world outside it. A name is one fact: the host, prefix, coordinate or destination the
 * code or the configuration writes, with the places that write it.
 */
export type OutwardKind =
  | "http-host"
  | "path-prefix"
  | "configuration-url"
  | "destination"
  | "dependency"
  | "remote"
  | "registry";

export interface OutwardName<E extends Evidence = Evidence> {
  /** The name as it is compared with a repository's identity: a host, a first path segment, a coordinate, a destination. */
  name: string;
  kind: OutwardKind;
  evidence: readonly E[];
}

export type RepositoryOutwardName = OutwardName<RepositoryEvidence>;

/**
 * One local repository that serves a name, and the basis that says why. `event-destination` is a repository with a
 * listener the join matched to the destination a call site publishes; the other bases compare the name with an identity.
 */
export interface NameCandidate {
  name: string;
  repo: string;
  basis: "exact-name" | "artifact" | "remote" | "route-overlap" | "event-destination";
  evidence: readonly RepositoryEvidence[];
}

const FIRST_LABEL = /^[^.:/]+/;

/**
 * The token of a name that can equal a repository's identity. An HTTP name is its first host label or first path segment;
 * a Maven coordinate stays qualified and a package name uses its last segment, without the version. A destination stands for itself: a repository serves a
 * message subject by listening to it, which only the join decides.
 */
export function serviceLabel({ name, kind }: Pick<OutwardName, "name" | "kind">): string {
  const withoutScheme = name.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const hostOrPath = withoutScheme.replace(/^[^/]*\/\//, "");
  switch (kind) {
    case "http-host":
    case "configuration-url":
    case "registry": {
      const host = hostOrPath.split("/")[0] ?? "";
      return FIRST_LABEL.exec(host)?.[0] ?? host;
    }
    case "path-prefix": {
      const segment = withoutScheme.split("/").find((part) => part !== "");
      return segment ?? "";
    }
    case "dependency": {
      const coordinate = name.split("@")[0] ?? name;
      if (coordinate.includes(":")) return coordinate;
      return coordinate.split(/[:/]/).filter(Boolean).pop() ?? coordinate;
    }
    case "remote":
    case "destination":
      return name;
  }
}

export function compareOutwardName(a: OutwardName, b: OutwardName): number {
  return compareText(a.name, b.name) || compareText(a.kind, b.kind);
}

export function compareCandidate(a: NameCandidate, b: NameCandidate): number {
  return compareText(a.name, b.name) || compareText(a.repo, b.repo) || compareText(a.basis, b.basis);
}

/** The same name written twice is one name, its evidence gathered and sorted. */
export function gatherNames<E extends Evidence>(names: readonly OutwardName<E>[]): OutwardName<E>[] {
  const held = new Map<string, OutwardName<E>>();
  for (const name of names) {
    const key = `${name.kind}\0${name.name}`;
    const known = held.get(key);
    held.set(key, known === undefined ? name : { ...known, evidence: sortEvidence([...known.evidence, ...name.evidence]) });
  }
  return [...held.values()].sort(compareOutwardName);
}

/** The same candidate reached twice is one candidate, its evidence gathered and sorted. */
export function gatherCandidates(candidates: readonly NameCandidate[]): NameCandidate[] {
  const held = new Map<string, NameCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.name}\0${candidate.repo}\0${candidate.basis}`;
    const known = held.get(key);
    held.set(key, known === undefined ? candidate : { ...known, evidence: sortEvidence([...known.evidence, ...candidate.evidence]) });
  }
  return [...held.values()].sort(compareCandidate);
}

/** Each distinct evidence value, ordered deterministically without losing repository or span. */
export function sortEvidence<E extends Evidence>(evidence: readonly E[]): E[] {
  const seen = new Map<string, E>();
  for (const place of evidence) seen.set(canonicalJson(place), place);
  return [...seen.values()].sort((a, b) => {
    const repoA = "repo" in a && typeof a.repo === "string" ? a.repo : "";
    const repoB = "repo" in b && typeof b.repo === "string" ? b.repo : "";
    return compareText(a.path, b.path) || a.line - b.line || compareText(repoA, repoB) || compareText(canonicalJson(a), canonicalJson(b));
  });
}
