import type { SnapshotRef } from "../shared/fact.ts";

export interface LibrarySource {
  path: string;
  content: string;
  snapshot?: SnapshotRef;
}

export const LIBRARY_ROOT = "(library)";

export function libraryPath(snapshot: SnapshotRef, path: string): string {
  const revision = snapshot.kind === "sha" ? [snapshot.sha] : [snapshot.head, snapshot.stateId];
  return `${LIBRARY_ROOT}/${[snapshot.repo, snapshot.kind, ...revision].map(encodeURIComponent).join("/")}/${path}`;
}
