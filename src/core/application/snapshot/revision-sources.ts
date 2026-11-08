import { isExtractorConfiguration } from "../../domain/languages/configuration.ts";
import { declaredScope, exportCuts } from "../../domain/map/entrypoint-map.ts";
import type { Cut } from "../../domain/shared/fact.ts";
import { exportSelection, pathSelection } from "../../domain/shared/scope.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { PathMatcher } from "../../ports/path-matcher.port.ts";
import type { RevisionSources } from "../../ports/revision-sources.port.ts";
import { prepareCommit } from "./prepared-snapshot.ts";
import { trustOf, withScratch, type SnapshotReaderDeps } from "./read-snapshot.ts";

export interface RevisionSourcesDeps extends SnapshotReaderDeps {
  matcher: PathMatcher;
  /** The repository paths the sources read so far depend on and do not hold; each is read from the same commit. */
  dependencies?: (files: readonly SourceFile[]) => readonly string[];
}

/**
 * The sources of a commit of the bound repository, exported from git at its sha and read through the confined reader
 * under the snapshot reader's selection and trust record, so an untrusted repository is never read from its working tree
 * and the per-process snapshot cache serves a commit read before. The caller's `sourceSelection` bounds what is read, and
 * the paths the sources depend on are read from the same commit until none is missing, never from outside the repository.
 */
export function createRevisionSources(deps: RevisionSourcesDeps): RevisionSources {
  return {
    resolve: ({ repo, signal }, revision) => deps.vcs.resolveCommit(repo.path, revision, signal),
    async filesAt({ repo, scope: requested, signal }, sha) {
      const scope = declaredScope(requested);
      const trust = await trustOf(deps, repo.path);
      const permitted = pathSelection({ include: [], exclude: scope.exclude }, deps.matcher.matches);
      return withScratch(deps, async (readScope) => {
        const files: SourceFile[] = [];
        const cuts: Cut[] = [];
        const asked = new Set<string>();
        let reading: SnapshotReaderDeps = deps;
        let context = { scope, trust };
        let selection = exportSelection(scope, deps.matcher.matches, isExtractorConfiguration);
        for (;;) {
          const prepared = await prepareCommit(reading, repo.path, sha, readScope, selection, context, signal);
          if (!prepared.ok) return prepared;
          const loaded = await prepared.value.sources(signal);
          if (!loaded.ok) return loaded;
          files.push(...loaded.value.sources);
          cuts.push(...exportCuts(loaded.value.export).filter((cut) => cut.kind !== "no-extractor"));
          const wanted = new Set((deps.dependencies?.(files) ?? []).filter((path) => !asked.has(path) && permitted(path)));
          if (wanted.size === 0) return { ok: true as const, value: { files, cuts } };
          for (const path of wanted) asked.add(path);
          selection = (path) => wanted.has(path);
          reading = { ...deps, sourceSelection: selection };
          context = { scope: { ...scope, include: [...wanted].sort() }, trust };
        }
      });
    },
  };
}
