/** One branch a remote's own listing states, with the sha the listing named for it. */
export interface RemoteBranch {
  name: string;
  sha: string;
}

/** The refs a remote's own listing states (`git ls-remote --symref`), never a clone's `origin/HEAD`. */
export interface RemoteListing {
  branches: readonly RemoteBranch[];
  /** The branch the listing names as default; absent when it names none. */
  defaultBranch?: string;
}

/** A listing entry a resolution consulted: the branch, and the sha the listing gave it or its absence. */
export interface ConsultedRef {
  branch: string;
  sha?: string;
}

/** The rule step that chose a repository's revision (RFC-0011 "Which snapshot of each", steps 1, 5 and 6). */
export type ResolutionStep = "explicit" | "trigger-line" | "default-branch" | "revision-unavailable";

/** How one repository's revision was chosen; a record of the query, never part of a fact. */
export interface RepositoryResolution {
  repo: string;
  /** What the declaration asked for, when it asked for a revision. */
  asked?: string;
  step: ResolutionStep;
  /** The listing entries consulted, in order, each with its sha or its absence. */
  consulted: readonly ConsultedRef[];
  /** More than one branch the trigger's line could have named; the scoped steps name branches uniquely, so it stays unset. */
  tie?: readonly string[];
  /** The sha the resolution pinned; absent when no step chose one. */
  sha?: string;
}

/** Whether a query verified a remote, and why not; carried beside the fact, never inside it (ADR-0016 decision 4). */
export type RemoteFreshness =
  | { status: "verified" }
  | { status: "unverified"; reason: "failed" | "deadline" | "offline" | "refresh-in-progress"; lastVerifiedAt?: string; detail?: string };

const FULL_SHA = /^[0-9a-f]{40}$/i;

/**
 * Chooses one revision for a repository from the remote's listing and the trigger's line, by steps 1, 5 and 6: an
 * explicit revision wins; else the branch named like the trigger's line; else the remote's default branch; else
 * `revision-unavailable`, never another branch silently.
 */
export function resolveRemoteSnapshot(repo: string, asked: string | undefined, triggerLine: string | undefined, listing: RemoteListing): RepositoryResolution {
  const branches = new Map(listing.branches.map((branch) => [branch.name, branch.sha]));

  if (asked !== undefined) {
    if (FULL_SHA.test(asked)) return { repo, asked, step: "explicit", consulted: [], sha: asked };
    const sha = branches.get(asked);
    return sha === undefined ? { repo, asked, step: "revision-unavailable", consulted: [{ branch: asked }] } : { repo, asked, step: "explicit", consulted: [{ branch: asked, sha }], sha };
  }

  const consulted: ConsultedRef[] = [];
  if (triggerLine !== undefined) {
    const sha = branches.get(triggerLine);
    consulted.push(sha === undefined ? { branch: triggerLine } : { branch: triggerLine, sha });
    if (sha !== undefined) return { repo, step: "trigger-line", consulted, sha };
  }
  if (listing.defaultBranch !== undefined) {
    const sha = branches.get(listing.defaultBranch);
    consulted.push(sha === undefined ? { branch: listing.defaultBranch } : { branch: listing.defaultBranch, sha });
    if (sha !== undefined) return { repo, step: "default-branch", consulted, sha };
  }
  return { repo, step: "revision-unavailable", consulted };
}
