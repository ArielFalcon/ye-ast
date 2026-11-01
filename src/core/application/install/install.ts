import { INDEX_STORE_DIRECTORY } from "../../ports/code-graph.port.ts";
import { FIXED_LAYER_DIRECTORY } from "../../ports/fixed-layer-store.port.ts";
import type { FixedLayerAdmin } from "../../ports/fixed-layer-admin.port.ts";
import type { Install, InstallFault } from "../../ports/install.port.ts";
import type { LocalExclude } from "../../ports/local-exclude.port.ts";
import type { TrustRecords } from "../../ports/trust-record.port.ts";
import { DEFAULT_REVISION, type Vcs } from "../../ports/vcs.port.ts";

/** What `install` keeps out of git through the repository's local exclude file. */
export const IGNORED_LINES: readonly string[] = [`${FIXED_LAYER_DIRECTORY}/`, `${INDEX_STORE_DIRECTORY}/`];

export interface InstallDeps {
  vcs: Pick<Vcs, "resolveCommit">;
  trust: Pick<TrustRecords, "write">;
  exclude: LocalExclude;
  layer: FixedLayerAdmin;
}

export function createInstall({ vcs, trust, exclude, layer }: InstallDeps): Install {
  return {
    async run({ repo, repoId, trust: mode, signal }) {
      const head = await vcs.resolveCommit(repo, DEFAULT_REVISION, signal);
      if (!head.ok) return stopped(head.fault, false);
      const recorded = await trust.write(repo, mode);
      if (!recorded.ok) return stopped(recorded.fault, false);
      const excluded = await exclude.ensure(repo, IGNORED_LINES);
      if (!excluded.ok) return stopped(excluded.fault, true);
      const written = await layer.refresh({ repo, repoId, revision: DEFAULT_REVISION, ...(signal && { signal }) });
      if (!written.ok) return stopped(written.fault, true);
      return { ok: true, value: { trust: mode, excluded: excluded.value, layer: written.value } };
    },
  };
}

function stopped(fault: Omit<InstallFault, "trustRecorded">, trustRecorded: boolean): { ok: false; fault: InstallFault } {
  return { ok: false, fault: { ...fault, trustRecorded } };
}
