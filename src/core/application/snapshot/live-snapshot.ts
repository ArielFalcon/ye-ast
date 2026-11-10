import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import type { DeclaredScope, TrustMode } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { CommitExport, VcsFault } from "../../ports/vcs.port.ts";
import { snapshotRetention } from "./prepared-snapshot.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { ABORTED, extractSources, readSources, type CommitExtraction, type PreparedCommit, type ReadScope, type SnapshotReaderDeps } from "./read-snapshot.ts";

/** What a live capture is read from: its mirror root, its listing and the inputs besides the listing that the read depends on. */
export interface LiveCapture {
  repo: string;
  scope: DeclaredScope;
  trust: TrustMode;
  root: string;
  export: CommitExport;
}

export interface LiveSnapshotReaders {
  sources(signal?: AbortSignal): Promise<Result<Pick<CommitExtraction, "export" | "sources">, VcsFault>>;
  extract(signal?: AbortSignal): Promise<Result<CommitExtraction, VcsFault>>;
  retained?: PreparedCommit["retained"];
  facts?: PreparedCommit["facts"];
}

/**
 * The sources and findings of one live capture, shared by every consumer of it. The snapshot data cache is keyed by the
 * capture's content, its listing of content hashes (RFC-0010 "The mirror"), the repository, scope and trust; never by
 * HEAD, so a capture whose files did not change reuses what an earlier one read, and an edit misses.
 */
export function liveSnapshotReaders(deps: Pick<SnapshotReaderDeps, "reader" | "extractor" | "snapshotCache" | "digest">, capture: LiveCapture, keep: ReadScope["keep"] = (sources) => [...sources]): LiveSnapshotReaders {
  const retention = snapshotRetention(deps, canonicalJson({ live: true, repo: capture.repo, scope: capture.scope, trust: capture.trust }), capture.export, capture.trust);
  let loaded: Promise<Result<Pick<CommitExtraction, "export" | "sources">, VcsFault>> | undefined;
  let extracted: Promise<Result<CommitExtraction, VcsFault>> | undefined;
  let retainedReading: Pick<CommitExtraction, "findings" | "readingCuts"> | undefined;
  /** The sources as read, the only ones retention stores; readers take the capture's own copies of them. */
  let read: readonly SourceFile[] = [];
  const load = async (signal?: AbortSignal): Promise<Result<Pick<CommitExtraction, "export" | "sources">, VcsFault>> => {
    const retained = retention?.lookup();
    if (retained !== undefined) {
      retainedReading = retained.findings === undefined || retained.readingCuts === undefined ? undefined : { findings: retained.findings, readingCuts: retained.readingCuts };
      read = retained.sources;
      return { ok: true, value: { export: capture.export, sources: keep(read) } };
    }
    const answer = await readSources(deps, capture.root, capture.export, signal);
    if (!answer.ok) return answer;
    read = answer.value.sources;
    retention?.keepSources(read);
    return { ok: true, value: { export: capture.export, sources: keep(read) } };
  };
  const sources: LiveSnapshotReaders["sources"] = async (signal) => {
    if (signal?.aborted) return ABORTED;
    const pending = loaded ??= load(signal);
    try {
      const result = await pending;
      if (!result.ok && loaded === pending) loaded = undefined;
      if (signal?.aborted) return ABORTED;
      return result;
    } catch (error) {
      if (loaded === pending) loaded = undefined;
      throw error;
    }
  };
  return {
    sources,
    async extract(signal) {
      if (signal?.aborted) return ABORTED;
      const pending = extracted ??= (async () => {
        const result = await sources(signal);
        if (!result.ok) return result;
        if (retainedReading !== undefined) return { ok: true as const, value: { ...result.value, ...retainedReading } };
        const answer = await extractSources(deps, result.value, signal);
        if (answer.ok) retention?.keepExtraction(read, answer.value);
        return answer;
      })();
      try {
        const answer = await pending;
        if (!answer.ok && extracted === pending) extracted = undefined;
        if (signal?.aborted) return ABORTED;
        return answer;
      } catch (error) {
        if (extracted === pending) extracted = undefined;
        throw error;
      }
    },
    ...(retention === undefined ? {} : { retained: retention.output, facts: retention.facts }),
  };
}
