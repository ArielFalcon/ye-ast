import type { OutlineValue } from "../domain/outline/outline-fact.ts";
import type { Fact } from "../domain/shared/fact.ts";
import type { Result } from "../domain/shared/result.ts";
import type { ScopeRequest } from "../domain/shared/scope.ts";
import type { LiveFault, LiveSelector } from "./live-queries.port.ts";
import type { VcsFault } from "./vcs.port.ts";

interface OutlineBase {
  /** Path of the root of a git repository to read. */
  repo: string;
  /** Stable name of the repository in the snapshot of every fact; never a path. */
  repoId: string;
  /** Repo-relative paths to describe. */
  files: readonly string[];
  scope?: ScopeRequest;
  /** Aborting stops the work, removes every temporary directory and answers an `aborted` fault. */
  signal?: AbortSignal;
}

export type OutlineRequest = OutlineBase & ({ revision: string; live?: undefined } | ({ revision?: undefined } & LiveSelector));

export type OutlineFault = VcsFault | LiveFault;

export interface OutlineQueries {
  /**
   * Per requested file, the declarations a reader can open by span and the files it imports, read from the index the
   * other queries use: no file is opened. A requested file outside the declared scope or that the index holds nothing
   * of is a cut, never an empty entry.
   */
  outline(request: OutlineRequest): Promise<Result<Fact<OutlineValue>, OutlineFault>>;
}
