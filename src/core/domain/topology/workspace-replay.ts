import { compareText } from "../shared/code-node.ts";
import { isFullObjectId } from "../shared/revision.ts";
import type { SnapshotRef } from "../shared/fact.ts";

export interface WorkspaceReplayContext {
  version: 1;
  declaration: string;
  snapshots: readonly SnapshotRef[];
}

export function isWorkspaceReplayContext(value: unknown): value is WorkspaceReplayContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  if (Object.keys(context).sort().join(",") !== "declaration,snapshots,version" || context.version !== 1 || typeof context.declaration !== "string" || !/^ws-r1:[0-9a-f]{64}$/.test(context.declaration) || !Array.isArray(context.snapshots)) return false;
  let previous: string | undefined;
  for (const item of context.snapshots) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const snapshot = item as Record<string, unknown>;
    if (Object.keys(snapshot).sort().join(",") !== "kind,repo,sha" || snapshot.kind !== "sha" || typeof snapshot.repo !== "string" || typeof snapshot.sha !== "string" || !isFullObjectId(snapshot.sha)) return false;
    if (previous !== undefined && compareText(previous, snapshot.repo) >= 0) return false;
    previous = snapshot.repo;
  }
  return true;
}
