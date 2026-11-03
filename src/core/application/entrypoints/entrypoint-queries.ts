import { buildEntrypointMap, contentFingerprint, declaredScope } from "../../domain/map/entrypoint-map.ts";
import { isExtractorConfiguration } from "../../domain/languages/configuration.ts";
import { exportSelection } from "../../domain/shared/scope.ts";
import { liveScope } from "../../domain/snapshot/live-export.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { EntrypointQueries } from "../../ports/entrypoint-queries.port.ts";
import type { EntrypointMapFact } from "../../domain/map/entrypoint-map.ts";
import type { LiveFault } from "../../ports/live-queries.port.ts";
import type { PathMatcher } from "../../ports/path-matcher.port.ts";
import type { VcsFault } from "../../ports/vcs.port.ts";
import { asFault, openLive, type LiveDeps } from "../live/live-tree.ts";
import { extractCommit, extractExport, factBaseOf, LIVE_REQUIRES_TRUSTED, trustOf, withScratch, type SnapshotReaderDeps } from "../snapshot/read-snapshot.ts";

export interface EntrypointQueriesDeps extends SnapshotReaderDeps {
  matcher: PathMatcher;
  /** Version of each engine the extractor runs on, by package name. */
  engines: Readonly<Record<string, string>>;
  /** What a live query reads; without it a live query is refused as under `untrusted`. */
  live?: LiveDeps;
}

export function createEntrypointQueries(deps: EntrypointQueriesDeps): EntrypointQueries {
  const { vcs } = deps;

  async function mapLive({ repo, repoId, scope: requested, signal, onStale }: Extract<Parameters<EntrypointQueries["map"]>[0], { live: true }>): Promise<Result<EntrypointMapFact, VcsFault | LiveFault>> {
    const trust = await trustOf(deps, repo);
    if (trust !== "trusted" || deps.live === undefined) return LIVE_REQUIRES_TRUSTED;
    const head = await vcs.resolveCommit(repo, "HEAD", signal);
    if (!head.ok) return head;
    const scope = liveScope(requested);
    const exported = exportSelection(scope, deps.matcher.matches, isExtractorConfiguration);
    const opened = await openLive(deps.live, { repo, scope, selected: exported, store: false, signal, onStale }, async (tree) => {
      const extracted = await extractExport(deps, tree.root, tree.export, signal);
      if (!extracted.ok) return extracted;
      const base = {
        ...factBaseOf(deps, { repoId, sha: head.value, trust, scope, content: contentFingerprint(extracted.value.export), declaredConfig: {}, engines: deps.engines }),
        snapshot: { repo: repoId, kind: "live" as const, head: head.value, stateId: tree.stateId },
      };
      const map: Result<EntrypointMapFact, VcsFault> = { ok: true, value: buildEntrypointMap(base, extracted.value.findings, extracted.value.export) };
      return map;
    });
    return opened.ok ? opened.value : { ok: false, fault: asFault(opened.fault) };
  }

  return {
    async map(request) {
      if (request.live === true) return mapLive(request);
      const { repo, repoId, revision, scope: requested, signal } = request;
      const resolved = await vcs.resolveCommit(repo, revision, signal);
      if (!resolved.ok) return resolved;
      const sha = resolved.value;

      return withScratch(deps.scratch, async (directory) => {
        const scope = declaredScope(requested);
        const exported = exportSelection(scope, deps.matcher.matches, isExtractorConfiguration);
        const extracted = await extractCommit(deps, repo, sha, await directory(), exported, signal);
        if (!extracted.ok) return extracted;
        const { export: mapExport, findings } = extracted.value;
        const declaredConfig = deps.budget === undefined ? {} : { exportBudget: { maxEntries: deps.budget.maxEntries, maxBytes: deps.budget.maxBytes } };
        const base = factBaseOf(deps, { repoId, sha, trust: await trustOf(deps, repo), scope, content: contentFingerprint(mapExport), declaredConfig, engines: deps.engines });
        return { ok: true, value: buildEntrypointMap(base, findings, mapExport) };
      });
    },
  };
}
