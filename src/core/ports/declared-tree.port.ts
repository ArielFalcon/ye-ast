import type { DeclaredBuildOutput } from "../domain/shared/build-outputs.ts";

/**
 * What a declared directory holds at a path relative to it (ADR-0037 decision 3). A symbolic link is read through its
 * link text, as the directory stands in the snapshot: a target inside the directory is followed, a target inside the
 * repository is `snapshot` (to be read from the snapshot, never from a working tree), any other target is `refused`.
 */
export type DeclaredEntry =
  | { kind: "file"; content: string }
  | { kind: "directory"; names: readonly string[] }
  | { kind: "absent" }
  | { kind: "snapshot"; path: string }
  | { kind: "refused"; link: string };

export interface DeclaredTree {
  /** The entry at `path`, a normalized relative path under the directory; `""` is the directory itself. */
  entry(path: string): DeclaredEntry;
}

/** Synchronous, because the TypeScript compiler's host is. */
export interface DeclaredTrees {
  open(output: DeclaredBuildOutput): DeclaredTree;
}
