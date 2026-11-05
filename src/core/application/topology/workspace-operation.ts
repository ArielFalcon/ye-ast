import type { Result } from "../../domain/shared/result.ts";
import type { WorkspaceFault } from "../../ports/workspace-repos.port.ts";
import type { WorkspaceRead } from "../../ports/workspace-queries.port.ts";
import type { WorkspacePlanningRequest } from "./workspace-plan.ts";
import type { WorkspaceSnapshotContext, WorkspaceSnapshotRead } from "./workspace-snapshots.ts";

/** Application-private discovery plus consumer work inside one snapshot lifetime. */
export interface WorkspaceReadOperation {
  withRead<T, F = never>(
    request: WorkspacePlanningRequest,
    use: (read: WorkspaceRead, context: WorkspaceSnapshotContext) => Promise<Result<T, F>>,
  ): Promise<Result<WorkspaceSnapshotRead<T>, WorkspaceFault | F>>;
}
