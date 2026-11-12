import { buildEntrypointMap, contentFingerprint, declaredScope } from "../../domain/map/entrypoint-map.ts";
import { isEntrypointReadingInput } from "../../domain/languages/configuration.ts";
import { exportSelection, pathSelection, type PathSelection } from "../../domain/shared/scope.ts";
import { liveScope } from "../../domain/snapshot/live-export.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { EntrypointQueries } from "../../ports/entrypoint-queries.port.ts";
import type { EntrypointMapFact, MapBase } from "../../domain/map/entrypoint-map.ts";
import type { DeclaredScope } from "../../domain/shared/fact.ts";
import type { LiveFault } from "../../ports/live-queries.port.ts";
import type { PathMatcher } from "../../ports/path-matcher.port.ts";
import type { VcsFault } from "../../ports/vcs.port.ts";
import { asFault, openLive, type LiveDeps } from "../live/live-tree.ts";
import { factBaseOf, LIVE_REQUIRES_TRUSTED, trustOf, withScratch, type CommitExtraction, type SnapshotReaderDeps } from "../snapshot/read-snapshot.ts";
import { prepareCommit } from "../snapshot/prepared-snapshot.ts";
import { heldPaths } from "../navigation/snapshot-files.ts";
import { scopeNotice } from "../snapshot/scope-selection.ts";
import type { ScopeFault } from "../../ports/scope-fault.port.ts";
import { liveSnapshotReaders } from "../snapshot/live-snapshot.ts";

export interface EntrypointQueriesDeps extends SnapshotReaderDeps {
  matcher: PathMatcher;
  /** Version of each engine the extractor runs on, by package name. */
  engines: Readonly<Record<string, string>>;
  /** What a live query reads; without it a live query is refused as under `untrusted`. */
  live?: LiveDeps;
}

function mapReading(scope: DeclaredScope, matches: PathMatcher["matches"]): PathSelection {
  return exportSelection(scope, matches, isEntrypointReadingInput);
}

function scopedMap(base: MapBase, extracted: CommitExtraction, selected: PathSelection): EntrypointMapFact {
  const findings = extracted.findings.filter((finding) => finding.evidence[0] !== undefined && selected(finding.evidence[0].path));
  const readingCuts = extracted.readingCuts.filter((cut) => cut.at[0] !== undefined && selected(cut.at[0]));
  return buildEntrypointMap(base, findings, extracted.export, readingCuts);
}

export function createEntrypointQueries(deps: EntrypointQueriesDeps): EntrypointQueries {
  const { vcs } = deps;

  async function mapLive({ repo, repoId, scope: requested, signal, onStale }: Extract<Parameters<EntrypointQueries["map"]>[0], { live: true }>): Promise<Result<EntrypointMapFact, VcsFault | LiveFault | ScopeFault>> {
    const trust = await trustOf(deps, repo);
    if (trust !== "trusted" || deps.live === undefined) return LIVE_REQUIRES_TRUSTED;
    const head = await vcs.resolveCommit(repo, "HEAD", signal);
    if (!head.ok) return head;
    const scope = liveScope(requested);
    const selected = pathSelection(scope, deps.matcher.matches);
    const exported = mapReading(scope, deps.matcher.matches);
    const opened = await openLive(deps.live, { repo, scope, selected: exported, store: false, signal, onStale }, async (tree) => {
      const paths = heldPaths(tree.export)?.filter(selected);
      const notice = scopeNotice(scope, deps.matcher.matches, paths);
      if (!notice.ok) return notice;
      const extracted = await liveSnapshotReaders(deps, { repo, scope, trust, root: tree.root, export: tree.export }).extract(signal);
      if (!extracted.ok) return extracted;
      const base = {
        ...factBaseOf(deps, { repoId, sha: head.value, trust, scope, content: contentFingerprint(extracted.value.export), declaredConfig: {}, engines: deps.engines }),
        snapshot: { repo: repoId, kind: "live" as const, head: head.value, stateId: tree.stateId },
        ...(notice.value === undefined ? {} : { scopeSelection: notice.value }),
      };
      const map: Result<EntrypointMapFact, VcsFault> = { ok: true, value: scopedMap(base, extracted.value, selected) };
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

      return withScratch(deps, async (readScope) => {
        const scope = declaredScope(requested);
        const selected = pathSelection(scope, deps.matcher.matches);
        const exported = mapReading(scope, deps.matcher.matches);
        const trust = await trustOf(deps, repo);
        const prepared = await prepareCommit(deps, repo, sha, readScope, exported, { scope, trust }, signal);
        if (!prepared.ok) return prepared;
        const paths = heldPaths(prepared.value.tree.export)?.filter(selected);
        const notice = scopeNotice(scope, deps.matcher.matches, paths);
        if (!notice.ok) return notice;
        const extracted = await prepared.value.extract(signal);
        if (!extracted.ok) return extracted;
        const { export: mapExport } = extracted.value;
        const declaredConfig = deps.budget === undefined ? {} : { exportBudget: { maxEntries: deps.budget.maxEntries, maxBytes: deps.budget.maxBytes } };
        const base = factBaseOf(deps, { repoId, sha, trust, scope, content: contentFingerprint(mapExport), declaredConfig, engines: deps.engines });
        return { ok: true, value: scopedMap({ ...base, ...(notice.value === undefined ? {} : { scopeSelection: notice.value }) }, extracted.value, selected) };
      });
    },
  };
}
