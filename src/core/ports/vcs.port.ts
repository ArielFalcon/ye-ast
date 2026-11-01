import type { FileChange } from "../domain/change/diff-reader.ts";
import type { Result } from "../domain/shared/result.ts";

export interface ExportedFile {
  path: string;
  blob: string;
  /** False when the plan did not select the path, or the export stopped before reaching it. */
  written: boolean;
}

export interface SkippedEntry {
  path: string;
  reason: "symlink" | "submodule" | "unsafe-path" | "collision";
}

/** The first entry the export did not take because a budget ran out; `limit` is that budget. */
export interface ExportStop {
  at: string;
  limit: number;
}

export interface CommitExport {
  /** Every regular file the export accepted, in git's order, whether it was written or not. */
  files: readonly ExportedFile[];
  skipped: readonly SkippedEntry[];
  /** Set when a budget stopped the export: nothing at or after `at`, in git's order, was exported. */
  stopped?: ExportStop;
}

export interface ExportBudget {
  /** Entries of the commit the export takes; the next one stops it. */
  maxEntries: number;
  /** Bytes of file content the export writes; the first selected file that does not fit stops it. */
  maxBytes: number;
}

export interface ExportPlan {
  /** Which accepted files to write; the others are listed and reported but never read from git. */
  write(path: string): boolean;
  /** What the export may take; without one it takes the whole commit. */
  budget?: ExportBudget;
}

/** The revision a request reads when it names none. */
export const DEFAULT_REVISION = "HEAD";

export interface VcsFault {
  kind:
    | "unknown-revision"
    | "git-failed"
    | "not-repository-root"
    | "object-missing"
    | "no-merge-base"
    | "export-write-failed"
    | "aborted";
  detail: string;
}

export interface Vcs {
  /**
   * The full sha of the commit `revision` names. `repo` must be the root of a repository: a subdirectory answers
   * `not-repository-root`, since it would map the whole repository under the subdirectory's name. An aborted `signal`
   * answers `aborted`.
   */
  resolveCommit(repo: string, revision: string, signal?: AbortSignal): Promise<Result<string, VcsFault>>;
  /**
   * Lists the commit `sha` and writes the regular files `plan.write` selects under `destination`, an empty directory,
   * from git's object store: never the working tree, a replace object, a symlink, a submodule, a path outside
   * `destination` or the repository's own attributes. A path that a host could not hold or that it would read as `.git`
   * or as a place outside `destination` is reported `unsafe-path` on every host, and paths that a case-insensitive or
   * normalizing file system would merge keep the first in git's order, so every host writes the same files. Every
   * entry is listed, classified and reported whether it is written or not, but the export holds at most one chunk of
   * one blob and the listing's current record at a time. When `plan.budget` runs out the export stops, answers `ok`
   * with `stopped` and exports everything before it. Nothing is fetched: a selected blob absent from the local object
   * store (a partial clone) is an `object-missing` fault, never a skipped entry, since the export would otherwise look
   * complete. A file that cannot be written is `export-write-failed`. An aborted `signal` stops the git process and
   * answers `aborted`. On a fault `destination` holds an unspecified part of the commit and the caller discards it.
   */
  exportCommit(repo: string, sha: string, destination: string, plan: ExportPlan, signal?: AbortSignal): Promise<Result<CommitExport, VcsFault>>;
}

/** What two commits have in common and where they differ; separate from `Vcs` since a map needs neither. */
export interface VcsChanges {
  /** The full sha of the best common ancestor of the commits `first` and `second`, both full shas; `no-merge-base` when they share none. */
  mergeBase(repo: string, first: string, second: string, signal?: AbortSignal): Promise<Result<string, VcsFault>>;
  /**
   * What changed from commit `base` to commit `head`, both full shas, as the hunks git reports under an empty user and
   * system configuration with every option that could change them pinned: no context, no renames, no external diff
   * driver, no text conversion, and binary-marked files read as text. Files are in git's order. A diff git cannot
   * produce, or whose headers cannot be read, is `git-failed`.
   */
  diffCommits(repo: string, base: string, head: string, signal?: AbortSignal): Promise<Result<readonly FileChange[], VcsFault>>;
  /**
   * What changed from the directory `base` to the directory `head`, both outside any repository, as `diffCommits`
   * reports it: the same pinned options, paths relative to each directory, run outside any repository under an empty
   * configuration with no attributes file. Two equal directories give no change; a diff git cannot produce is
   * `git-failed`.
   */
  diffDirectories(base: string, head: string, signal?: AbortSignal): Promise<Result<readonly FileChange[], VcsFault>>;
}
