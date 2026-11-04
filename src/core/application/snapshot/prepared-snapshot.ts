import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import type { DeclaredScope, TrustMode } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { PathSelection } from "../../domain/shared/scope.ts";
import type { ScratchDirectory } from "../../ports/scratch-directory.port.ts";
import type { VcsFault } from "../../ports/vcs.port.ts";
import { ABORTED, exportCommit, extractSources, readSources, withScratch, type CommitExtraction, type SnapshotReaderDeps, type PreparedCommit, type SnapshotPreparation } from "./read-snapshot.ts";

type Sources = Pick<CommitExtraction, "export" | "sources">;

/** Retains only successful preparations until every consumer of the operation has finished. */
export function withSnapshotPreparation<T>(scratch: ScratchDirectory, use: (preparation: SnapshotPreparation) => Promise<T>): Promise<T> {
  return withScratch(scratch, async (directory) => {
    const held = new Map<string, { deps: SnapshotReaderDeps; value: PreparedCommit }>();
    return use({
      async obtain(key, deps, build) {
        const previous = held.get(key);
        if (previous && previous.deps.vcs === deps.vcs && previous.deps.reader === deps.reader && previous.deps.extractor === deps.extractor) return { ok: true, value: previous.value };
        const answer = await build(await directory());
        if (answer.ok) held.set(key, { deps, value: answer.value });
        return answer;
      },
    });
  });
}

export async function prepareCommit(
  deps: SnapshotReaderDeps,
  repo: string,
  sha: string,
  directory: () => Promise<string>,
  selected: PathSelection,
  context: { scope: DeclaredScope; trust: TrustMode },
  signal?: AbortSignal,
): Promise<Result<PreparedCommit, VcsFault>> {
  if (signal?.aborted) return ABORTED;
  const key = canonicalJson({ repo, sha, ...context, budget: deps.budget ?? null });
  const build = async (root: string): Promise<Result<PreparedCommit, VcsFault>> => {
    const exported = await exportCommit(deps, repo, sha, root, selected, signal);
    if (!exported.ok) return exported;
    const cache = deps.snapshotCache;
    let cacheKey: string | undefined;
    let loaded: Sources | undefined;
    let extracted: CommitExtraction | undefined;
    const sources = async (signal?: AbortSignal): Promise<Result<Sources, VcsFault>> => {
      if (signal?.aborted) return ABORTED;
      if (loaded !== undefined) return { ok: true, value: loaded };
      if (cache !== undefined && cacheKey === undefined) cacheKey = deps.digest.of(canonicalJson({ key, export: exported.value }));
      const retained = cacheKey === undefined ? undefined : cache?.get(cacheKey);
      if (retained !== undefined) {
        loaded = { export: exported.value, sources: retained.sources };
        if (retained.findings !== undefined) extracted = { ...loaded, findings: retained.findings };
        return { ok: true, value: loaded };
      }
      const answer = await readSources(deps, root, exported.value, signal);
      if (answer.ok) {
        loaded = answer.value;
        if (cacheKey !== undefined && cache?.get(cacheKey)?.findings === undefined) cache?.put(cacheKey, { sources: loaded.sources });
      }
      return answer;
    };
    return {
      ok: true,
      value: {
        root,
        tree: { export: exported.value },
        sources,
        async extract(signal?: AbortSignal) {
          if (signal?.aborted) return ABORTED;
          if (extracted !== undefined) return { ok: true, value: extracted };
          const read = await sources(signal);
          if (!read.ok) return read;
          if (signal?.aborted) return ABORTED;
          if (extracted !== undefined) return { ok: true, value: extracted };
          const answer = await extractSources(deps, read.value, signal);
          if (answer.ok) {
            extracted = answer.value;
            if (cacheKey !== undefined && !extracted.findings.some((finding) => finding.status === "unknown" && finding.reason === "deadline")) cache?.put(cacheKey, { sources: extracted.sources, findings: extracted.findings });
          }
          return answer;
        },
      },
    };
  };
  const answer = await (deps.preparation === undefined ? build(await directory()) : deps.preparation.obtain(key, deps, build));
  return signal?.aborted ? ABORTED : answer;
}
