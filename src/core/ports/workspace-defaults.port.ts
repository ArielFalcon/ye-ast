import type { Result } from "../domain/shared/result.ts";
import type { WorkspaceManifest } from "../domain/topology/workspace-manifest.ts";
import type { FixedLayerFault } from "./fixed-layer-store.port.ts";

/** The file of the fixed layer that holds the workspace `ye-ast install --workspace` persisted. */
export const WORKSPACE_MANIFEST_FILE = "workspace.json";

export type { WorkspaceManifest, WorkspaceManifestFault } from "../domain/topology/workspace-manifest.ts";

/** The workspace persisted for a repository, which a request naming no `repos` works over. */
export interface WorkspaceDefaults {
  /**
   * The manifest of `root`, its relative repository paths resolved against it, or `undefined` when the repository
   * persists none. A file that does not parse or does not validate is a fault, never an absent workspace.
   */
  of(root: string): Promise<Result<WorkspaceManifest | undefined, FixedLayerFault>>;
}
