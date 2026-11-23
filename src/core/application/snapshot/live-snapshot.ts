import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import type { DeclaredScope, TrustMode } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { CommitExport, VcsFault } from "../../ports/vcs.port.ts";
import { entrypointReadingOf, snapshotRetention } from "./prepared-snapshot.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ParseHold } from "../../ports/parse-holds.port.ts";
import { ABORTED, extractSources, readSources, type CommitExtraction, type PreparedCommit, type ReadScope, type SnapshotReaderDeps } from "./read-snapshot.ts";

/** What a live capture is read from: its mirror root, read only while the capture is pinned, its listing and the inputs besides the listing that the read depends on. */
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
 * Pins the sources of one live capture and answers its readers, shared by every consumer of it. It reads the sources
 * from the capture's root, under the mirror lock (ADR-0144), or from the snapshot data cache; the readers it answers hold
 * no root, so nothing read after the lock is released reaches the mirror. The cache is keyed by the capture's content,
 * its listing of content hashes (RFC-0010 "The mirror"), the repository, scope and trust; never by HEAD, so a capture
 * whose files did not change reuses what an earlier one read, and an edit misses.
 */
export async function pinLiveSnapshot(deps: Pick<SnapshotReaderDeps, "reader" | "extractor" | "snapshotCache" | "derivedFactDisk" | "digest">, capture: LiveCapture, hold?: ParseHold, signal?: AbortSignal): Promise<Result<LiveSnapshotReaders, VcsFault>> {
  const keep: ReadScope["keep"] = hold === undefined ? (sources) => [...sources] : (sources) => hold.keep(sources);
  const retention = snapshotRetention(deps, canonicalJson({ live: true, repo: capture.repo, scope: capture.scope, trust: capture.trust }), capture.export, capture.trust);
  let retainedReading: Pick<CommitExtraction, "findings" | "readingCuts"> | undefined;
  /** The sources as read, the only ones retention stores; readers take the capture's own copies of them. */
  let read: readonly SourceFile[];
  const retained = retention?.lookup();
  if (retained !== undefined) {
    retainedReading = retained.findings === undefined || retained.readingCuts === undefined ? undefined : { findings: retained.findings, readingCuts: retained.readingCuts };
    read = retained.sources;
  } else {
    const answer = await readSources(deps, capture.root, capture.export, signal);
    if (!answer.ok) return answer;
    read = answer.value.sources;
    retention?.keepSources(read);
  }
  const pinned: Pick<CommitExtraction, "export" | "sources"> = { export: capture.export, sources: keep(read) };
  let extracted: Promise<Result<CommitExtraction, VcsFault>> | undefined;
  const sources: LiveSnapshotReaders["sources"] = async (signal) => (signal?.aborted ? ABORTED : { ok: true, value: pinned });
  return {
    ok: true,
    value: {
      sources,
      async extract(signal) {
        if (signal?.aborted) return ABORTED;
        const pending = extracted ??= (async () => {
          if (retainedReading !== undefined) return { ok: true as const, value: { ...pinned, ...retainedReading } };
          const answer = await extractSources(deps, pinned, signal, entrypointReadingOf(hold, retention));
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
    },
  };
}
