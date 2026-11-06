import type { Result } from "../../domain/shared/result.ts";
import { isEngineEntry } from "../../ports/staging-rules.ts";
import type { VcsFault } from "../../ports/vcs.port.ts";
import type { WorkingTree, WorkingTreeListing, WorkingTreePath } from "../../ports/working-tree.port.ts";
import { ABORTED, defaultGitDeps, ensureRepositoryRoot, gitFailed, type GitDeps } from "./git-vcs.adapter.ts";
import { compareText } from "../../domain/shared/code-node.ts";

const SUBMODULE_MODE = "160000";

/** The user's configuration stays, except what could change what git lists or start a program. */
const LISTING_PREFIX: readonly string[] = [
  "--no-optional-locks",
  "-c",
  "core.excludesFile=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.fsmonitor=false",
];

export function createGitWorkingTree(deps: Pick<GitDeps, "runGit"> = defaultGitDeps): WorkingTree {
  async function list(repo: string, signal?: AbortSignal): Promise<Result<WorkingTreeListing, VcsFault>> {
    const [root, tracked, untracked, format] = await Promise.all([
      ensureRepositoryRoot(deps, repo, signal),
      deps.runGit(repo, [...LISTING_PREFIX, "ls-files", "-z", "-s", "--cached"], signal),
      deps.runGit(repo, [...LISTING_PREFIX, "ls-files", "-z", "--others", "--exclude-standard"], signal),
      deps.runGit(repo, ["rev-parse", "--show-object-format"], signal),
    ]);
    if (signal?.aborted) return ABORTED;
    if (!root.ok) return root;
    if (tracked.code !== 0) return gitFailed(tracked);
    if (untracked.code !== 0) return gitFailed(untracked);
    if (format.code !== 0) return gitFailed(format);

    const listed = new Map<string, WorkingTreePath>();
    for (const record of records(tracked.stdout)) {
      const tab = record.indexOf("\t");
      const path = record.slice(tab + 1);
      const submodule = record.startsWith(`${SUBMODULE_MODE} `);
      listed.set(path, { path, submodule: submodule || listed.get(path)?.submodule === true });
    }
    for (const record of records(untracked.stdout)) {
      const nested = record.endsWith("/");
      const path = nested ? record.slice(0, -1) : record;
      listed.set(path, { path, submodule: nested });
    }
    const paths = [...listed.values()].filter((entry) => !isEngineEntry(entry.path)).sort((a, b) => compareText(a.path, b.path));
    return { ok: true, value: { paths, objectFormat: format.stdout.toString("utf8").trim() } };
  }

  return { list };
}

function records(output: Buffer): string[] {
  return output.toString("utf8").split("\0").filter((record) => record !== "");
}
