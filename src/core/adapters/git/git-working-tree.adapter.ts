import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Result } from "../../domain/shared/result.ts";
import { isEngineEntry } from "../../ports/staging-rules.ts";
import type { VcsFault } from "../../ports/vcs.port.ts";
import type { WorkingTree, WorkingTreeListing, WorkingTreePath } from "../../ports/working-tree.port.ts";
import { ABORTED, defaultGitDeps, ensureRepositoryRoot, gitFailed, type GitDeps } from "./git-vcs.adapter.ts";
import { compareText } from "../../domain/shared/code-node.ts";

const SUBMODULE_MODE = "160000";
/** `git check-ignore` exits 1 when none of the paths it was given is ignored. */
const CHECK_IGNORE_NONE = 1;

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

export interface WorkingTreeDeps extends Pick<GitDeps, "runGit"> {
  /** The identity of a file (device, inode, size, change times), or `undefined` when it cannot be read. */
  fileIdentity: (path: string) => Promise<string | undefined>;
}

const defaultWorkingTreeDeps: WorkingTreeDeps = {
  runGit: defaultGitDeps.runGit,
  fileIdentity: async (path) => {
    try {
      const status = await stat(path, { bigint: true });
      return `${status.dev}:${status.ino}:${status.size}:${status.mtimeNs}:${status.ctimeNs}`;
    } catch {
      return undefined;
    }
  },
};

/** A repository's object format, valid while its configuration file keeps the identity it had when the format was read. */
interface KeptFormat {
  config: string;
  identity: string;
  format: string;
}

/**
 * Lists working trees. The object format is set in the repository's configuration when the repository is created and
 * never changes after (`extensions.objectFormat`), so it is asked once per repository and asked again only when that
 * file is replaced or rewritten, as a new repository created at the same path does.
 */
export function createGitWorkingTree(deps: Pick<GitDeps, "runGit"> & Partial<WorkingTreeDeps> = defaultWorkingTreeDeps): WorkingTree {
  const fileIdentity = deps.fileIdentity ?? defaultWorkingTreeDeps.fileIdentity;
  const formats = new Map<string, KeptFormat>();

  async function objectFormat(repo: string, signal?: AbortSignal): Promise<Result<string, VcsFault>> {
    const kept = formats.get(repo);
    if (kept !== undefined && (await fileIdentity(kept.config)) === kept.identity) return { ok: true, value: kept.format };
    formats.delete(repo);
    const asked = await deps.runGit(repo, ["rev-parse", "--show-object-format", "--git-path", "config"], signal);
    if (asked.code !== 0) return gitFailed(asked);
    const [format = "", path] = asked.stdout.toString("utf8").split("\n");
    if (path !== undefined && path !== "") {
      const config = isAbsolute(path) ? path : join(repo, path);
      const identity = await fileIdentity(config);
      if (identity !== undefined) formats.set(repo, { config, identity, format });
    }
    return { ok: true, value: format };
  }

  async function list(repo: string, signal?: AbortSignal): Promise<Result<WorkingTreeListing, VcsFault>> {
    const [root, tracked, untracked, format] = await Promise.all([
      ensureRepositoryRoot(deps, repo, signal),
      deps.runGit(repo, [...LISTING_PREFIX, "ls-files", "-z", "-s", "--cached"], signal),
      deps.runGit(repo, [...LISTING_PREFIX, "ls-files", "-z", "--others", "--exclude-standard"], signal),
      objectFormat(repo, signal),
    ]);
    if (signal?.aborted) return ABORTED;
    if (!root.ok) return root;
    if (tracked.code !== 0) return gitFailed(tracked);
    if (untracked.code !== 0) return gitFailed(untracked);
    if (!format.ok) return format;

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
    return { ok: true, value: { paths, objectFormat: format.value.trim() } };
  }

  async function ignoredDirectories(repo: string, signal?: AbortSignal): Promise<Result<readonly string[], VcsFault>> {
    const untracked = await deps.runGit(repo, [...LISTING_PREFIX, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], signal);
    if (signal?.aborted) return ABORTED;
    if (untracked.code !== 0) return gitFailed(untracked);
    const candidates = records(untracked.stdout).filter((record) => record.endsWith("/"));
    if (candidates.length === 0) return { ok: true, value: [] };
    const excluded = await deps.runGit(repo, [...LISTING_PREFIX, "-c", "core.quotePath=false", "check-ignore", "--", ...candidates], signal);
    if (signal?.aborted) return ABORTED;
    if (excluded.code === CHECK_IGNORE_NONE) return { ok: true, value: [] };
    if (excluded.code !== 0) return gitFailed(excluded);
    const lines = excluded.stdout.toString("utf8").split("\n").filter((line) => line.endsWith("/"));
    return { ok: true, value: lines.map((line) => line.slice(0, -1)).sort(compareText) };
  }

  return { list, ignoredDirectories };
}

function records(output: Buffer): string[] {
  return output.toString("utf8").split("\0").filter((record) => record !== "");
}
