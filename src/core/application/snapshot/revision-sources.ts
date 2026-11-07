import { isExtractorConfiguration } from "../../domain/languages/configuration.ts";
import { declaredScope, exportCuts } from "../../domain/map/entrypoint-map.ts";
import { exportSelection } from "../../domain/shared/scope.ts";
import type { PathMatcher } from "../../ports/path-matcher.port.ts";
import type { RevisionSources } from "../../ports/revision-sources.port.ts";
import { prepareCommit } from "./prepared-snapshot.ts";
import { trustOf, withScratch, type SnapshotReaderDeps } from "./read-snapshot.ts";

export interface RevisionSourcesDeps extends SnapshotReaderDeps {
  matcher: PathMatcher;
}

/**
 * The sources of a commit of the bound repository, exported from git at its sha and read through the confined reader
 * under the snapshot reader's selection and trust record, so an untrusted repository is never read from its working tree
 * and the per-process snapshot cache serves a commit read before. The caller's `sourceSelection` bounds what is read.
 */
export function createRevisionSources(deps: RevisionSourcesDeps): RevisionSources {
  return {
    resolve: ({ repo, signal }, revision) => deps.vcs.resolveCommit(repo.path, revision, signal),
    async filesAt({ repo, scope: requested, signal }, sha) {
      const scope = declaredScope(requested);
      const selection = exportSelection(scope, deps.matcher.matches, isExtractorConfiguration);
      const trust = await trustOf(deps, repo.path);
      return withScratch(deps.scratch, async (directory) => {
        const prepared = await prepareCommit(deps, repo.path, sha, directory, selection, { scope, trust }, signal);
        if (!prepared.ok) return prepared;
        const loaded = await prepared.value.sources(signal);
        if (!loaded.ok) return loaded;
        const cuts = exportCuts(loaded.value.export).filter((cut) => cut.kind !== "no-extractor");
        return { ok: true as const, value: { files: loaded.value.sources, cuts } };
      });
    },
  };
}
