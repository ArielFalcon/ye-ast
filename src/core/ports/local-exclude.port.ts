import type { Result } from "../domain/shared/result.ts";

export interface LocalExcludeFault {
  kind: "git-failed" | "unreadable" | "unwritable" | "refused";
  detail: string;
}

/** The repository's own exclude file, the one git documents for patterns that are not shared (`info/exclude`). */
export interface LocalExclude {
  /**
   * Appends the `lines` the file does not already hold, in order, and answers the ones it appended. The file is found
   * through git, so a linked worktree or a `.git` file works; no tracked file is touched. It is refused, not written,
   * when the file is a symbolic link or lies outside git's common directory. `repo` is a repository root.
   */
  ensure(repo: string, lines: readonly string[]): Promise<Result<readonly string[], LocalExcludeFault>>;
}
