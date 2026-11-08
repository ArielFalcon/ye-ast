import type { DeclaredBuildOutput } from "../domain/shared/build-outputs.ts";

/**
 * What a declared directory holds at a path relative to it (ADR-0037 decision 3). A symbolic link is read through its
 * link text, as the directory stands in the snapshot: a target inside the directory is followed, a target inside the
 * repository is `snapshot` (to be read from the snapshot, never from a working tree), any other target is `refused`. A
 * file or a directory carries the path it was found at once its links were followed, relative to the directory. A path
 * the host's file system would not read (the directory missing or not a directory, a permission refused) is `unreadable`,
 * at that path; `""` is the directory itself.
 */
export type DeclaredEntry =
  | { kind: "file"; path: string; content: string }
  | { kind: "directory"; path: string; names: readonly string[] }
  | { kind: "absent" }
  | { kind: "snapshot"; path: string }
  | { kind: "refused"; link: string }
  | { kind: "unreadable"; path: string };

export interface DeclaredTree {
  /** The entry at `path`, a normalized relative path under the directory; `""` is the directory itself. */
  entry(path: string): DeclaredEntry;
}

/** Synchronous, because the TypeScript compiler's host is. */
export interface DeclaredTrees {
  open(output: DeclaredBuildOutput): DeclaredTree;
}
