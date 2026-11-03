import { INDEX_STORE_DIRECTORY } from "../../ports/code-graph.port.ts";
import type { Result } from "../../domain/shared/result.ts";
import { FIXED_LAYER_DIRECTORY, type FixedLayerFault, type FixedLayerStore } from "../../ports/fixed-layer-store.port.ts";
import type { FixedLayerAdmin } from "../../ports/fixed-layer-admin.port.ts";
import type { Install, InstallFault } from "../../ports/install.port.ts";
import type { LocalExclude } from "../../ports/local-exclude.port.ts";
import type { TrustRecords } from "../../ports/trust-record.port.ts";
import { DEFAULT_REVISION, type Vcs, type VcsFault } from "../../ports/vcs.port.ts";
import { parseWorkspaceManifest, renderWorkspaceManifest, type WorkspaceManifest } from "../../domain/topology/workspace-manifest.ts";
import { WORKSPACE_MANIFEST_FILE, type WorkspaceDefaults } from "../../ports/workspace-defaults.port.ts";

/** What `install` keeps out of git through the repository's local exclude file. */
export const IGNORED_LINES: readonly string[] = [`${FIXED_LAYER_DIRECTORY}/`, `${INDEX_STORE_DIRECTORY}/`];

export interface InstallDeps {
  vcs: Pick<Vcs, "resolveCommit">;
  trust: Pick<TrustRecords, "write">;
  exclude: LocalExclude;
  store: FixedLayerStore;
  layer: FixedLayerAdmin;
  /** Resolves a manifest's relative repository paths against the repository, as the reader will. */
  defaults: Pick<WorkspaceDefaults, "resolve">;
}

export function createInstall({ vcs, trust, exclude, store, layer, defaults }: InstallDeps): Install {
  return {
    async run({ repo, repoId, trust: mode, workspace, signal }) {
      const head = await vcs.resolveCommit(repo, DEFAULT_REVISION, signal);
      if (!head.ok) return stopped(head.fault, false);
      let manifest: WorkspaceManifest | undefined;
      if (workspace !== undefined) {
        const parsed = parseWorkspaceManifest(workspace.text);
        if (!parsed.ok) return stopped({ ...parsed.fault, detail: `${workspace.path}: ${parsed.fault.detail}` }, false);
        manifest = parsed.value;
        const readable = await everyRepositoryReadable(defaults.resolve(repo, manifest), vcs, signal);
        if (readable !== undefined) return stopped(readable, false);
      }
      const recorded = await trust.write(repo, mode);
      if (!recorded.ok) return stopped(recorded.fault, false);
      const excluded = await exclude.ensure(repo, IGNORED_LINES);
      if (!excluded.ok) return stopped(excluded.fault, true);
      const persisted = manifest === undefined ? undefined : await persist(store, repo, manifest);
      if (persisted !== undefined && !persisted.ok) return stopped(persisted.fault, true);
      const written = await layer.refresh({ repo, repoId, revision: DEFAULT_REVISION, ...(signal && { signal }) });
      if (!written.ok) return stopped(written.fault, true);
      return { ok: true, value: { trust: mode, excluded: excluded.value, layer: written.value, ...(persisted === undefined ? {} : { workspace: persisted.value }) } };
    },
  };
}

/**
 * Every repository the declaration names is checked against the filesystem before anything is written: a clone the query
 * families cannot read is a broken workspace, so the install names the entry instead of storing it. The fault is the
 * reader's own, with the entry prepended.
 */
async function everyRepositoryReadable(manifest: WorkspaceManifest, vcs: Pick<Vcs, "resolveCommit">, signal: AbortSignal | undefined): Promise<VcsFault | undefined> {
  for (const [index, declaration] of manifest.repos.entries()) {
    const resolved = await vcs.resolveCommit(declaration.path, declaration.revision ?? DEFAULT_REVISION, signal);
    if (!resolved.ok) return { ...resolved.fault, detail: `repos[${index}].path: ${resolved.fault.detail.trim()}` };
  }
  return undefined;
}

/** Writes the manifest when the stored bytes differ from it, so a second run of one workspace writes nothing. */
async function persist(store: FixedLayerStore, repo: string, manifest: WorkspaceManifest): Promise<Result<{ outcome: "written" | "unchanged" }, FixedLayerFault>> {
  const content = renderWorkspaceManifest(manifest);
  const stored = await store.read(repo, WORKSPACE_MANIFEST_FILE);
  if (!stored.ok) return stored;
  if (stored.value === content) return { ok: true, value: { outcome: "unchanged" } };
  const written = await store.write(repo, WORKSPACE_MANIFEST_FILE, content);
  return written.ok ? { ok: true, value: { outcome: "written" } } : written;
}

function stopped(fault: Omit<InstallFault, "trustRecorded">, trustRecorded: boolean): { ok: false; fault: InstallFault } {
  return { ok: false, fault: { ...fault, trustRecorded } };
}
