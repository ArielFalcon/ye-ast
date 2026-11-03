import { isAbsolute, resolve } from "node:path";
import type { FixedLayerStore } from "../../ports/fixed-layer-store.port.ts";
import { FIXED_LAYER_DIRECTORY } from "../../ports/fixed-layer-store.port.ts";
import { parseWorkspaceManifest, type WorkspaceManifest } from "../../domain/topology/workspace-manifest.ts";
import { WORKSPACE_MANIFEST_FILE, type WorkspaceDefaults } from "../../ports/workspace-defaults.port.ts";

/**
 * The workspace `ye-ast install --workspace` persisted under the fixed layer of a repository. A relative repository path
 * was stored as written, so it is resolved against the root here, never against the process working directory.
 */
export function createWorkspaceDefaults(store: FixedLayerStore): WorkspaceDefaults {
  return {
    async of(root) {
      const stored = await store.read(root, WORKSPACE_MANIFEST_FILE);
      if (!stored.ok) return stored;
      if (stored.value === undefined) return { ok: true, value: undefined };
      const manifest = parseWorkspaceManifest(stored.value);
      if (!manifest.ok) {
        return { ok: false, fault: { kind: "unreadable", detail: `${FIXED_LAYER_DIRECTORY}/${WORKSPACE_MANIFEST_FILE}: ${manifest.fault.detail}` } };
      }
      return { ok: true, value: resolvePaths(manifest.value, root) };
    },

    resolve: (root, manifest) => resolvePaths(manifest, root),
  };
}

function resolvePaths(manifest: WorkspaceManifest, root: string): WorkspaceManifest {
  return {
    repos: manifest.repos.map((repo) => ({ ...repo, path: isAbsolute(repo.path) ? repo.path : resolve(root, repo.path) })),
    ...(manifest.gateways === undefined ? {} : { gateways: manifest.gateways }),
  };
}
