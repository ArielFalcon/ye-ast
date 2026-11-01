import type { Result } from "../domain/shared/result.ts";
import type { VcsFault } from "./vcs.port.ts";

export interface WorkingTreePath {
  path: string;
  /** True for a submodule entry of the index, which ye-ast never reads. */
  submodule: boolean;
}

export interface WorkingTreeListing {
  /** Tracked and untracked paths git does not ignore, in git's order, engine entries left out. */
  paths: readonly WorkingTreePath[];
  /** The repository's object format; only `sha1` blob ids are computed in this slice. */
  objectFormat: string;
}

/** The paths of a working tree, as git enumerates them without reading their content (RFC-0010 "Live head"). */
export interface WorkingTree {
  /**
   * Lists the working tree of `repo`, a repository root, honouring its `.gitignore` files and local exclude, never a
   * global ignore or attributes file, never writing the index and never starting a program named in configuration.
   * A subdirectory answers `not-repository-root`; an aborted `signal` answers `aborted`.
   */
  list(repo: string, signal?: AbortSignal): Promise<Result<WorkingTreeListing, VcsFault>>;
}
