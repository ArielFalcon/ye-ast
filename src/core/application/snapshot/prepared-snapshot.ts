import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import type { DeclaredScope, TrustMode } from "../../domain/shared/fact.ts";
import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { PathSelection } from "../../domain/shared/scope.ts";
import { isInMapScope } from "../../domain/map/entrypoint-map.ts";
import type { CommitExport, VcsFault } from "../../ports/vcs.port.ts";
import type { EntrypointExtraction, SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { createDerivedFacts } from "./derived-facts.ts";
import { ABORTED, extractSources, listExport, readSources, withScratch, type CommitExtraction, type ReadScope, type SnapshotData, type SnapshotReaderDeps, type PreparedCommit, type SnapshotPreparation } from "./read-snapshot.ts";

type Sources = Pick<CommitExtraction, "export" | "sources">;

/** Retains only successful preparations, and the trees parsed from their sources, until every consumer of the operation has finished. */
export function withSnapshotPreparation<T>(deps: Pick<SnapshotReaderDeps, "scratch" | "holds">, use: (preparation: SnapshotPreparation) => Promise<T>): Promise<T> {
  return withScratch(deps, async ({ directory, keep }) => {
    const held = new Map<string, { deps: SnapshotReaderDeps; value: PreparedCommit }>();
    return use({
      async obtain(key, deps, build) {
        const previous = held.get(key);
        if (previous && previous.deps.vcs === deps.vcs && previous.deps.reader === deps.reader && previous.deps.extractor === deps.extractor && (previous.deps.sourceSelection ?? isInMapScope) === (deps.sourceSelection ?? isInMapScope)) return { ok: true, value: previous.value };
        const answer = await build(await directory(), keep);
        if (answer.ok) held.set(key, { deps, value: answer.value });
        return answer;
      },
    });
  });
}

/**
 * The snapshot data cache over one listing. `identity` names everything but the listing that the retained data
 * depends on; the key adds `listing`, what every reader of the data observes. The first `lookup` fixes the key;
 * `output` retains nothing before it.
 */
export interface SnapshotRetention {
  lookup(): SnapshotData | undefined;
  keepSources(sources: readonly SourceFile[]): void;
  keepExtraction(sources: readonly SourceFile[], extraction: EntrypointExtraction): void;
  output<T>(slot: string, produce: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** The derived facts of the files read under this snapshot's trust, kept by their content (ADR-0035). */
  facts: DerivedFacts;
}

export function snapshotRetention(deps: Pick<SnapshotReaderDeps, "snapshotCache" | "digest">, identity: string, listing: object, trust: TrustMode): SnapshotRetention | undefined {
  const cache = deps.snapshotCache;
  if (cache === undefined) return undefined;
  let entry: string | undefined;
  return {
    facts: createDerivedFacts(cache, deps.digest, trust),
    lookup() {
      entry ??= deps.digest.of(canonicalJson({ key: identity, listing }));
      return cache.get(entry);
    },
    keepSources(sources) {
      if (entry !== undefined && cache.get(entry)?.findings === undefined) cache.put(entry, { sources });
    },
    keepExtraction(sources, extraction) {
      if (entry !== undefined && !extraction.findings.some((finding) => finding.status === "unknown" && finding.reason === "deadline")) cache.put(entry, { sources, findings: extraction.findings, readingCuts: extraction.readingCuts });
    },
    async output<T>(slot: string, produce: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (entry === undefined) return produce();
      const outputKey = deps.digest.of(canonicalJson({ entry, output: slot }));
      const kept = cache.get(outputKey);
      if (kept?.output !== undefined) return kept.output as T;
      const output = await produce();
      if (signal?.aborted) return output;
      const serialized = JSON.parse(JSON.stringify(output)) as T;
      cache.put(outputKey, { sources: [], output: serialized });
      return serialized;
    },
  };
}

/** The files a snapshot's data is read from: sources are their contents, and nothing else of the listing reaches the stored values. */
function writtenListing(exported: CommitExport): object {
  return exported.files.filter((file) => file.written).map(({ path, blob }) => ({ path, blob }));
}

export async function prepareCommit(
  deps: SnapshotReaderDeps,
  repo: string,
  sha: string,
  scope: ReadScope,
  selected: PathSelection,
  context: { scope: DeclaredScope; trust: TrustMode },
  signal?: AbortSignal,
): Promise<Result<PreparedCommit, VcsFault>> {
  if (signal?.aborted) return ABORTED;
  const key = canonicalJson({ repo, sha, ...context, budget: deps.budget ?? null });
  const identity = canonicalJson({ ...context, budget: deps.budget ?? null });
  const build = async (root: string, keep: ReadScope["keep"]): Promise<Result<PreparedCommit, VcsFault>> => {
    const listed = await listExport(deps, repo, sha, root, selected, signal);
    if (!listed.ok) return listed;
    const exported = { ok: true as const, value: listed.value.export };
    let written: Promise<Result<void, VcsFault>> | undefined;
    const materialize = async (signal?: AbortSignal): Promise<Result<void, VcsFault>> => {
      if (signal?.aborted) return ABORTED;
      const answer = await (written ??= listed.value.materialize(signal));
      return signal?.aborted ? ABORTED : answer;
    };
    const retention = snapshotRetention(deps, identity, writtenListing(exported.value), context.trust);
    /** The sources as read, the only ones retention stores, and the read scope's own copies of them, the ones readers take. */
    let loaded: { read: readonly SourceFile[]; kept: Sources } | undefined;
    let extracted: CommitExtraction | undefined;
    const load = async (signal?: AbortSignal): Promise<Result<NonNullable<typeof loaded>, VcsFault>> => {
      if (signal?.aborted) return ABORTED;
      if (loaded !== undefined) return { ok: true, value: loaded };
      const retained = retention?.lookup();
      if (retained !== undefined) {
        loaded = { read: retained.sources, kept: { export: exported.value, sources: keep(retained.sources) } };
        if (retained.findings !== undefined && retained.readingCuts !== undefined) extracted = { ...loaded.kept, findings: retained.findings, readingCuts: retained.readingCuts };
        return { ok: true, value: loaded };
      }
      const ready = await materialize(signal);
      if (!ready.ok) return ready;
      const answer = await readSources(deps, root, exported.value, signal);
      if (!answer.ok) return answer;
      loaded = { read: answer.value.sources, kept: { export: exported.value, sources: keep(answer.value.sources) } };
      retention?.keepSources(loaded.read);
      return { ok: true, value: loaded };
    };
    const sources = async (signal?: AbortSignal): Promise<Result<Sources, VcsFault>> => {
      const answer = await load(signal);
      return answer.ok ? { ok: true, value: answer.value.kept } : answer;
    };
    return {
      ok: true,
      value: {
        root,
        materialize,
        tree: { export: exported.value },
        sources,
        async extract(signal?: AbortSignal) {
          if (signal?.aborted) return ABORTED;
          if (extracted !== undefined) return { ok: true, value: extracted };
          const read = await load(signal);
          if (!read.ok) return read;
          if (signal?.aborted) return ABORTED;
          if (extracted !== undefined) return { ok: true, value: extracted };
          const answer = await extractSources(deps, read.value.kept, signal);
          if (answer.ok) {
            extracted = answer.value;
            retention?.keepExtraction(read.value.read, extracted);
          }
          return answer;
        },
        ...(retention === undefined ? {} : { retained: retention.output, facts: retention.facts }),
      },
    };
  };
  const answer = await (deps.preparation === undefined ? build(await scope.directory(), scope.keep) : deps.preparation.obtain(key, deps, build));
  return signal?.aborted ? ABORTED : answer;
}
