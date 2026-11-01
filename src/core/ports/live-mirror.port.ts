import type { Result } from "../domain/shared/result.ts";
import type { SkippedEntry } from "./vcs.port.ts";
import type { WorkingTreePath } from "./working-tree.port.ts";

export interface MirrorFault {
  kind: "refused" | "unreadable" | "write-failed" | "aborted";
  detail: string;
}

/** One mirrored file: what ye-ast copied and the git blob id of the copied bytes. */
export interface MirrorEntry {
  path: string;
  size: number;
  /** Nanosecond modification time of the working-tree file when it was copied, as a decimal string. */
  mtimeNs: string;
  blob: string;
}

export interface MirrorVersions {
  codegraph: string;
  /** The range of codegraph store versions the build supports, as one stable string. */
  store: string;
  staging: string;
}

export interface MirrorState {
  versions: MirrorVersions;
  /** Every mirrored file, sorted by path. */
  manifest: readonly MirrorEntry[];
  skipped: readonly SkippedEntry[];
  /** Mirror-relative paths the store does not hold: the engine dropped them or could not read them. */
  notHeld: readonly string[];
  /** The `stateId` at the last full build of the store; empty while no full build has completed. */
  fullBuildStateId: string;
  stateId: string;
  /** Mirror paths the store may not reflect yet: a refresh began to change them and did not finish, or only the files were refreshed. The next store refresh changes them again. */
  pending: readonly string[];
}

export interface MirrorReconciliation {
  manifest: readonly MirrorEntry[];
  skipped: readonly SkippedEntry[];
  /** Paths added, modified or deleted in the mirror by this reconciliation, sorted. */
  changed: readonly string[];
}

export interface MirrorLock {
  release(): Promise<void>;
}

/** Where one repository's mirror for one declared scope lives. */
export interface MirrorLocation {
  repo: string;
  scope: string;
}

/**
 * ye-ast's persistent copy of a working tree (RFC-0010 "Live head"): `<repo>/.ye-ast-graph/live/<scope>/`, its lock
 * beside it at `<scope>.lock`, its state at `<scope>.state.json`. A directory on the way that is a symbolic link or is not
 * private to the account is `refused`.
 */
export interface LiveMirror {
  /** The directory the extractors and the engine read. */
  root(location: MirrorLocation): string;
  /** Takes the mirror's lock, waiting while another live process holds it; a holder whose pid is dead is stale. */
  lock(location: MirrorLocation, signal?: AbortSignal): Promise<Result<MirrorLock, MirrorFault>>;
  /** The recorded state, or `null` when there is none or it cannot be read as one. */
  readState(location: MirrorLocation): Promise<Result<MirrorState | null, MirrorFault>>;
  /** Replaces the recorded state atomically. */
  writeState(location: MirrorLocation, state: MirrorState): Promise<Result<void, MirrorFault>>;
  /**
   * Makes the mirror hold `paths` of the working tree at `location.repo`: a regular file whose size and nanosecond
   * modification time match its `manifest` entry keeps it, any other is copied and hashed from the copy; a symbolic
   * link, a submodule, a special file or an unsafe path is skipped with the export's reason; a manifest path no
   * longer listed or present is deleted. The copy drops what `CodeGraph.index` never reads (engine entries, every
   * `.gitignore`, the root `codegraph.json`), which the manifest still records. `force` names paths copied again
   * whatever their stat says.
   */
  reconcile(location: MirrorLocation, paths: readonly WorkingTreePath[], manifest: readonly MirrorEntry[], force: readonly string[], signal?: AbortSignal): Promise<Result<MirrorReconciliation, MirrorFault>>;
  /**
   * The paths whose stat says the mirror is behind `paths`, without reading or writing any file: a listed path whose
   * size or nanosecond modification time differs from its `manifest` entry, one the manifest does not hold, a manifest
   * path no longer listed or present, and a path `skipped` as a symbolic link that became a regular file. Sorted.
   */
  changedSince(location: MirrorLocation, paths: readonly WorkingTreePath[], state: Pick<MirrorState, "manifest" | "skipped">, signal?: AbortSignal): Promise<Result<readonly string[], MirrorFault>>;
  /** Copies the mirror's version of each of `paths` that it holds into `destination`, an empty directory, keeping relative paths; a path the mirror does not hold is left out. */
  materialize(location: MirrorLocation, paths: readonly string[], destination: string, signal?: AbortSignal): Promise<Result<void, MirrorFault>>;
  /** Removes the mirror's files, store and state, never its lock. */
  discard(location: MirrorLocation): Promise<Result<void, MirrorFault>>;
}
